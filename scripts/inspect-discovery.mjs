// 检查最近事件的 discovery tx：to 是否为统一路由、value、selector
import fs from "node:fs";
import https from "node:https";

const RPCS = (process.env.BSC_RPC_URLS || "https://rpc-bsc.48.club,https://bsc.publicnode.com,https://1rpc.io/bnb").split(",");
let idx = 0;
let lastAt = 0;
async function rpc(method, params, tries = 8) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const gap = Date.now() - lastAt;
    if (gap < 300) await new Promise((r) => setTimeout(r, 300 - gap));
    lastAt = Date.now();
    const url = RPCS[idx++ % RPCS.length];
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
      const t = await r.text();
      if (!t.trim().startsWith("{")) throw new Error(`RETRYABLE HTTP${r.status}`);
      const j = JSON.parse(t);
      if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 80));
      return j.result;
    } catch (e) {
      lastErr = e;
      if (!/^RETRYABLE/.test(e.message) && !/timeout|fetch/i.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw lastErr;
}

const lines = fs.readFileSync("data/events.jsonl", "utf8").trim().split("\n");
const events = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).filter((e) => e.type === "project.new" || e.eventId);
const recent = events.slice(-15);
console.error(`最近 ${recent.length} 条事件`);
for (const e of recent) {
  const txHash = e.transactionHash;
  if (!txHash) { console.log(`${e.name} | 无tx字段`); continue; }
  try {
    const tx = await rpc("eth_getTransactionByHash", [txHash]);
    if (!tx) { console.log(`${e.name} | tx 不存在`); continue; }
    console.log(
      `${String(e.name).slice(0, 20).padEnd(22)}`,
      `contract=${String(e.contractAddress).slice(0, 12)}`,
      `txTo=${String(tx.to).slice(0, 14)}`,
      `value=${BigInt(tx.value || 0)} BNB`,
      `selector=${String(tx.input).slice(0, 10)}`,
      `inputLen=${(String(tx.input).length - 2) / 2}B`,
      `status=${tx.blockNumber ? "mined" : "pending"}`
    );
  } catch (err) {
    console.log(`${e.name} | 查询失败 ${String(err.message).slice(0, 40)}`);
  }
}
