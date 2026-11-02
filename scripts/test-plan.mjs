// 用 NAS 上最近的 unknown 事件实测新 classify 逻辑
import fs from "node:fs";
import { buildMintPlan } from "../src/classify.js";

const WALLET = "0x12e8C8152316F60749Ac0D47103aAD5b7E1A3E41";
const lines = fs.readFileSync("data/events.jsonl", "utf8").trim().split("\n");
const events = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean)
  .filter((e) => e.functionName && e.contractAddress)
  .slice(-8);

for (const e of events) {
  try {
    const p = await buildMintPlan(e, WALLET);
    console.log(
      `${String(p.name).slice(0, 18).padEnd(20)}`,
      `kind=${p.kind}`,
      `val=${p.valueWei}`,
      `src=${p.priceSource}`,
      `data=${(p.inputData || "-").slice(0, 10)}`,
      `note=${(p.note || "").slice(0, 40)}`
    );
  } catch (err) {
    console.log(`${e.name} | FAIL ${String(err.message).slice(0, 60)}`);
  }
}
