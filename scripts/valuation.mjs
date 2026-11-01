// 钱包 NFT 估值助手：按 minted 合约清单逐合约查链上持仓与活跃度
// 输入: data/minted-list.tsv (contract\tname\ttx)
// 用法: node scripts/valuation.mjs [--out data/valuation.json]
import fs from "node:fs";
// 注意：这里故意不走 initProxyForFetch——BSC 公共 RPC 直连即可，
// clash 代理出口 IP 会被节点 CDN 风控返回 403 HTML

const WALLET = "0x12e8C8152316F60749Ac0D47103aAD5b7E1A3E41";
const RPCS = (process.env.BSC_RPC_URLS || "https://rpc-bsc.48.club,https://bsc.publicnode.com,https://1rpc.io/bnb").split(",");

let rpcIdx = 0;
let lastReqAt = 0;
const MIN_GAP = 500; // 全局限速：公共 RPC 对突发并发限流严格
async function rpc(method, params, tries = 12) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const gap = Date.now() - lastReqAt;
    if (gap < MIN_GAP) await new Promise((r) => setTimeout(r, MIN_GAP - gap));
    lastReqAt = Date.now();
    const url = RPCS[rpcIdx++ % RPCS.length];
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await r.text();
      if (!text.trim().startsWith("{")) throw new Error(`RETRYABLE HTTP${r.status} HTML`);
      const j = JSON.parse(text);
      if (j.error) {
        const msg = JSON.stringify(j.error).slice(0, 120);
        if (/limit|rate|exceed|too many/i.test(msg)) throw new Error(`RETRYABLE ${msg}`);
        throw new Error(msg);
      }
      return j.result;
    } catch (e) {
      lastErr = e;
      if (!/^RETRYABLE/.test(e.message) && !/timeout|fetch|abort/i.test(e.message)) throw e;
      await new Promise((res) => setTimeout(res, 600));
    }
  }
  throw lastErr;
}

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad = (a) => "0x" + "0".repeat(24) + a.toLowerCase().replace(/^0x/, "");
const ERC721_IFACE = "0x80ac58cd"; // supportsInterface(ERC721)

async function blockDaysAgo(days) {
  const latest = await rpc("eth_getBlockByNumber", ["latest", false]);
  const n = parseInt(latest.number, 16);
  const ref = await rpc("eth_getBlockByNumber", ["0x" + (n - 20000).toString(16), false]);
  const spb = (parseInt(latest.timestamp, 16) - parseInt(ref.timestamp, 16)) / 20000;
  return { latest: n, spb, day1: Math.round(n - 86400 / spb), dayN: Math.round(n - (days * 86400) / spb), day6h: Math.round(n - 21600 / spb) };
}

async function getLogsRange(filter, fromBlock, toBlock, deadline) {
  const logs = [];
  let from = fromBlock;
  let span = Math.min(3500, toBlock - fromBlock + 1);
  while (from <= toBlock) {
    if (deadline && Date.now() > deadline) throw new Error("BUDGET_EXCEEDED 单合约预算超时");
    const to = Math.min(toBlock, from + span - 1);
    try {
      const part = await rpc("eth_getLogs", [{ ...filter, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }]);
      logs.push(...part);
      from = to + 1;
    } catch (e) {
      if (span > 300) span = Math.floor(span / 2);
      else if (/RETRYABLE|timeout|limit/i.test(e.message)) await new Promise((r) => setTimeout(r, 1200));
      else throw e;
    }
  }
  return logs;
}

async function callInt(to, data) {
  try {
    const out = await rpc("eth_call", [{ to, data }, "latest"]);
    return out && out !== "0x" ? parseInt(out, 16) : null;
  } catch {
    return null;
  }
}

async function main() {
  const tsv = fs.readFileSync("data/minted-list.tsv", "utf8").trim().split("\n");
  const entries = tsv.map((l) => {
    const [contract, name, tx] = l.split("\t");
    return { contract: contract.toLowerCase(), logName: name, tx };
  });
  console.error(`输入 ${entries.length} 个 minted 合约`);
  const { latest, day1, dayN, day6h } = await blockDaysAgo(3);
  console.error(`最新块 ${latest}，24h 前 ${day1}，6h 前 ${day6h}（活跃度用 6h 窗口初筛）`);

  const results = [];
  const scanOne = async (entry) => {
    const { contract, logName } = entry;
    const row = { contract, logName, kind: "ERC721?", balance: null, tokensInWallet: 0, stillOwned: null, transfers24h: 0, addrs24h: 0, name: "?" };
    const t0 = Date.now();
    const deadline = t0 + 180_000; // 单合约预算
    try {
      const iface = await rpc("eth_call", [{ to: contract, data: "0x01ffc9a7" + ERC721_IFACE.slice(2).padStart(64, "0") }, "latest"]).catch(() => "0x");
      row.kind = iface && iface !== "0x" && parseInt(iface, 16) % 2 === 1 ? "ERC721" : "ERC1155?";
      if (row.kind === "ERC721") row.balance = await callInt(contract, "0x70a08231" + pad(WALLET).slice(2));
      try {
        const out = await rpc("eth_call", [{ to: contract, data: "0x06fdde03" }, "latest"]);
        if (out && out !== "0x" && out.length >= 130) {
          row.name = Buffer.from(out.slice(130).replace(/(00)+$/, ""), "hex").toString("utf8").replace(/[^\x20-\x7e]/g, "").trim() || logName;
        }
      } catch {}
      if (row.name === "?") row.name = logName;

      // 近 6 小时全网活跃（BSC 0.45s/块 → 24h=19 万块太大，6h≈4.8 万块作初筛）
      const act = await getLogsRange({ address: contract, topics: [TRANSFER] }, day6h, latest, deadline);
      const addrs = new Set();
      for (const l of act) {
        if (!l.topics[1] || BigInt(l.topics[1]) === 0n) continue;
        row.transfers24h++; // 字段沿用：代表近 6h 转让数
        addrs.add(l.topics[1]);
        addrs.add(l.topics[2]);
      }
      row.addrs24h = addrs.size;

      if (row.kind === "ERC721") {
        row.stillOwned = (row.balance ?? 0) > 0;
      } else {
        row.stillOwned = null; // 1155 持仓需要 tokenId，先标记待确认
      }
    } catch (e) {
      row.error = e.message.slice(0, 100);
    }
    row.ms = Date.now() - t0;
    results.push(row);
    return row;
  };

  // 串行 + 温和间隔：公共 RPC 对突发并发限流严格
  let done = 0;
  const limit = process.argv.includes("--limit") ? Number(process.argv[process.argv.indexOf("--limit") + 1]) : entries.length;
  for (const e of entries.slice(0, limit)) {
    await scanOne(e);
    done++;
    fs.writeFileSync("data/valuation.json", JSON.stringify({ wallet: WALLET, scannedAt: new Date().toISOString(), partial: true, results }, null, 2));
    console.error(`进度 ${done}/${Math.min(limit, entries.length)} ${e.logName}`);
  }
  console.error(`完成 ${done}`);

  results.sort((a, b) => b.transfers24h * 100 + b.addrs24h - (a.transfers24h * 100 + a.addrs24h));
  fs.writeFileSync("data/valuation.json", JSON.stringify({ wallet: WALLET, scannedAt: new Date().toISOString(), results }, null, 2));
  console.log("\n== 活跃度排行（24h 有交易的在前）==");
  console.log("名称".padEnd(24), "标准", "持仓", "在手", "24h转让", "24h地址", "合约");
  for (const r of results) {
    if (r.transfers24h === 0) continue;
    console.log(
      String(r.name).slice(0, 22).padEnd(24),
      r.kind.padEnd(8),
      String(r.balance ?? r.tokensInWallet).padEnd(4),
      String(r.stillOwned).padEnd(5),
      String(r.transfers24h).padEnd(8),
      String(r.addrs24h).padEnd(8),
      r.contract.slice(0, 14)
    );
  }
  const idle = results.filter((r) => !r.error && r.transfers24h === 0);
  const errs = results.filter((r) => r.error);
  console.log(`\n24h 零转让: ${idle.length} 个，查询失败: ${errs.length} 个`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
