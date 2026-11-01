// 对活跃合约验证持仓：mint tx receipt → tokenId → ownerOf
import fs from "node:fs";

const WALLET = "0x12e8C8152316F60749Ac0D47103aAD5b7E1A3E41";
const RPCS = (process.env.BSC_RPC_URLS || "https://rpc-bsc.48.club,https://bsc.publicnode.com,https://1rpc.io/bnb").split(",");
let rpcIdx = 0;
let lastReqAt = 0;
const MIN_GAP = 400;
async function rpc(method, params, tries = 8) {
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
      if (!text.trim().startsWith("{")) throw new Error(`RETRYABLE HTTP${r.status}`);
      const j = JSON.parse(text);
      if (j.error) {
        const msg = JSON.stringify(j.error).slice(0, 100);
        if (/limit|rate|exceed/i.test(msg)) throw new Error(`RETRYABLE ${msg}`);
        throw new Error(msg);
      }
      return j.result;
    } catch (e) {
      lastErr = e;
      if (!/^RETRYABLE/.test(e.message) && !/timeout|fetch|abort/i.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 700));
    }
  }
  throw lastErr;
}

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad = (a) => "0x" + "0".repeat(24) + a.toLowerCase().replace(/^0x/, "");

const tsv = fs.readFileSync("data/minted-list.tsv", "utf8").trim().split("\n");
const entries = tsv.map((l) => {
  const [contract, name, tx] = l.split("\t");
  return { contract: contract.toLowerCase(), name, tx };
});
const val = JSON.parse(fs.readFileSync("data/valuation.json", "utf8"));
const active = val.results.filter((r) => (r.transfers24h || 0) > 0);

console.error(`验证 ${active.length} 个活跃合约的持仓`);
const out = [];
for (const r of active) {
  const entry = entries.find((e) => e.contract === r.contract);
  const row = { ...r, tokensOwned: [], stillOwned: null };
  try {
    if (!entry?.tx) throw new Error("无 mint tx 记录");
    const receipt = await rpc("eth_getTransactionReceipt", [entry.tx]);
    if (!receipt) throw new Error("tx 回执为空（可能未上链）");
    const ids721 = new Set();
    const ids1155 = new Set();
    for (const l of receipt.logs) {
      if (l.address.toLowerCase() !== r.contract) continue;
      if (l.topics[0] === TRANSFER && l.topics[3] && l.topics[3].toLowerCase() === pad(WALLET)) {
        ids721.add(BigInt(l.topics[3]).toString());
      }
      // ERC1155 TransferSingle: operator,from,to(indexed) + (id,amount) in data
      if (l.topics[0] === "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62") {
        const to = (l.topics[3] || "").toLowerCase();
        if (to === pad(WALLET)) {
          try {
            ids1155.add(BigInt("0x" + l.data.replace(/^0x/, "").slice(0, 64)).toString());
          } catch {}
        }
      }
      // ERC1155 TransferBatch: data = [ids[], amounts[]] 头部是 offset/length，简化解析跳过
    }
    row.tokensMinted = ids721.size + ids1155.size;
    row.standard = ids721.size ? "ERC721" : ids1155.size ? "ERC1155" : "unknown";
    const checks = [];
    for (const id of [...ids721].slice(0, 3)) {
      try {
        const owner = await rpc("eth_call", [{ to: r.contract, data: "0x6352211e" + BigInt(id).toString(16).padStart(64, "0") }, "latest"]);
        checks.push(owner.toLowerCase() === pad(WALLET) ? id : `gone:${id}`);
      } catch {
        checks.push(`?:${id}`);
      }
    }
    for (const id of [...ids1155].slice(0, 3)) {
      try {
        const data = "0x00fdd58e" + pad(WALLET).slice(2) + BigInt(id).toString(16).padStart(64, "0"); // balanceOf(address,uint256)
        const bal = await rpc("eth_call", [{ to: r.contract, data }, "latest"]);
        const n = bal && bal !== "0x" ? parseInt(bal, 16) : 0;
        checks.push(n > 0 ? `${id}x${n}` : `gone:${id}`);
      } catch {
        checks.push(`?:${id}`);
      }
    }
    row.tokensOwned = checks;
    row.stillOwned = checks.some((x) => String(x).startsWith("1155") || (!x.startsWith("gone:") && !x.startsWith("?:")));
    if (row.stillOwned == null || checks.length === 0) row.stillOwned = null;
  } catch (e) {
    row.verifyError = String(e.message).slice(0, 80);
  }
  out.push(row);
  console.error(`${r.name}: minted=${row.tokensMinted ?? "?"} stillOwned=${row.stillOwned}`);
}

fs.writeFileSync("data/valuation-verified.json", JSON.stringify({ verifiedAt: new Date().toISOString(), rows: out }, null, 2));
console.log("done");
