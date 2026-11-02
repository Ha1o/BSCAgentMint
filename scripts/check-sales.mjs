// 检测活跃 NFT 合约的真实成交：转让 tx 内含 WBNB 转账 = 买卖成交，金额即成交价
import fs from "node:fs";
import https from "node:https";

const WALLET = "0x12e8C8152316F60749Ac0D47103aAD5b7E1A3E41";
const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const RPCS = (process.env.BSC_RPC_URLS || "https://rpc-bsc.48.club,https://bsc.publicnode.com,https://1rpc.io/bnb").split(",");
let urlIdx = 0;
let lastReqAt = 0;
const MIN_GAP = 300;

async function rpc(method, params, tries = 8) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const gap = Date.now() - lastReqAt;
    if (gap < MIN_GAP) await new Promise((r) => setTimeout(r, MIN_GAP - gap));
    lastReqAt = Date.now();
    const url = RPCS[urlIdx++ % RPCS.length];
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
      const t = await r.text();
      if (!t.trim().startsWith("{")) throw new Error(`RETRYABLE HTTP${r.status}`);
      const j = JSON.parse(t);
      if (j.error) {
        const msg = JSON.stringify(j.error).slice(0, 80);
        if (/limit|rate|exceed/i.test(msg)) throw new Error(`RETRYABLE ${msg}`);
        throw new Error(msg);
      }
      return j.result;
    } catch (e) {
      lastErr = e;
      if (!/^RETRYABLE/.test(e.message) && !/timeout|fetch/i.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  throw lastErr;
}

const pad = (a) => "0x" + "0".repeat(24) + a.toLowerCase().replace(/^0x/, "");

async function blockInfo() {
  const latest = await rpc("eth_getBlockByNumber", ["latest", false]);
  const n = parseInt(latest.number, 16);
  const ref = await rpc("eth_getBlockByNumber", ["0x" + (n - 20000).toString(16), false]);
  const spb = Math.max(0.2, (parseInt(latest.timestamp, 16) - parseInt(ref.timestamp, 16)) / 20000);
  return { latest: n, h24: Math.round(n - 86400 / spb) };
}

async function getLogsRange(filter, fromBlock, toBlock) {
  const logs = [];
  let from = fromBlock;
  let span = Math.min(4000, toBlock - fromBlock + 1);
  while (from <= toBlock) {
    const to = Math.min(toBlock, from + span - 1);
    try {
      const part = await rpc("eth_getLogs", [{ ...filter, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }]);
      logs.push(...part);
      from = to + 1;
    } catch (e) {
      if (span > 400) span = Math.floor(span / 2);
      else if (/RETRYABLE/.test(e.message)) await new Promise((r) => setTimeout(r, 1200));
      else throw e;
    }
  }
  return logs;
}

async function main() {
  const val = JSON.parse(fs.readFileSync("data/valuation.json", "utf8"));
  const active = val.results.filter((r) => (r.transfers24h || 0) > 0).sort((a, b) => b.transfers24h - a.transfers24h);
  const { latest, h24 } = await blockInfo();
  console.error(`活跃合约 ${active.length} 个，扫 24h 成交`);

  const out = [];
  for (const r of active) {
    const row = { contract: r.contract, name: r.name, sales24h: 0, volumeBnb: 0, maxSaleBnb: 0, sampleSales: [], txs: 0 };
    const txs = new Map(); // txHash -> { from, to }
    try {
      const logs = await getLogsRange({ address: r.contract, topics: [TRANSFER] }, h24, latest);
      for (const l of logs) {
        if (!l.topics[1] || BigInt(l.topics[1]) === 0n) continue;
        txs.set(l.transactionHash, { from: l.topics[1], to: l.topics[2] });
      }
      row.txs = txs.size;
      // 每笔转让 tx 查 WBNB 转账（限前 25 笔控预算）
      let checked = 0;
      for (const [txHash, t] of txs) {
        if (checked >= 25) break;
        checked++;
        const receipt = await rpc("eth_getTransactionReceipt", [txHash]).catch(() => null);
        if (!receipt) continue;
        let wbnb = 0n;
        let buyer = null;
        for (const l of receipt.logs || []) {
          if ((l.address || "").toLowerCase() !== WBNB) continue;
          if (l.topics[0] !== TRANSFER) continue;
          // WBNB 转入卖方 or 市场托管方（排除 0x0）
          if (!l.topics[2] || BigInt(l.topics[2]) === 0n) continue;
          const amt = BigInt(l.data);
          if (amt > wbnb) {
            wbnb = amt;
            buyer = l.topics[1];
          }
        }
        if (wbnb > 0n) {
          const bnb = Number(wbnb) / 1e18;
          row.sales24h++;
          row.volumeBnb += bnb;
          row.maxSaleBnb = Math.max(row.maxSaleBnb, bnb);
          if (row.sampleSales.length < 3) row.sampleSales.push({ tx: txHash.slice(0, 18) + "…", bnb: +bnb.toFixed(5), txValue: receipt.value });
        }
      }
      row.volumeBnb = +row.volumeBnb.toFixed(4);
      row.maxSaleBnb = +row.maxSaleBnb.toFixed(5);
    } catch (e) {
      row.err = String(e.message).slice(0, 60);
    }
    out.push(row);
    console.error(`${r.name}: txs=${row.txs} sales=${row.sales24h} vol=${row.volumeBnb} BNB max=${row.maxSaleBnb}`);
  }

  fs.writeFileSync("data/sales-check.json", JSON.stringify({ at: new Date().toISOString(), rows: out }, null, 2));
  console.log("\n== 24h 真实成交（WBNB 结算）==");
  console.log("名称".padEnd(22), "转让tx", "成交笔", "24h成交额", "最大单笔");
  for (const r of out.sort((a, b) => b.volumeBnb - a.volumeBnb)) {
    console.log(
      String(r.name).slice(0, 20).padEnd(22),
      String(r.txs).padEnd(7),
      String(r.sales24h).padEnd(7),
      String(r.volumeBnb).padEnd(10),
      String(r.maxSaleBnb)
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
