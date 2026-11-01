// 从 OKX NFT 页面批量抓取合约的市场数据（地板价/24h交易/挂单/持有者）
import fs from "node:fs";
import { initProxyForFetch } from "../src/proxy.js";

const val = JSON.parse(fs.readFileSync("data/valuation.json", "utf8"));
const rows = val.results;
const out = [];

function pick(re, text, fallback = null) {
  const m = text.match(re);
  return m ? m[1].trim() : fallback;
}

let i = 0;
for (const r of rows) {
  const url = `https://web3.okx.com/nft/collection/bsc/${r.contract}`;
  const row = { contract: r.contract, name: r.name, t6h: r.transfers24h, addrs6h: r.addrs24h };
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { "user-agent": "Mozilla/5.0", "accept-language": "zh-CN" } });
    const text = await resp.text();
    row.okxStatus = resp.status;
    // 页面常见字段（中英文版都兼容的宽松匹配）
    row.floor = pick(/地板价[\s\S]{0,200}?>([\d.]+)\s*<|Floor price[\s\S]{0,200}?>([\d.]+)\s*</, text) || pick(/地板价[\s\S]{0,120}?(\-\-)/, text, "--");
    row.volume = pick(/总交易额[\s\S]{0,200}?>([\d.]+)\s*</, text, "--");
    row.holders = pick(/>(\d+)\s*<\/span>\s*<\/div>\s*<[^>]*>\s*持有者/, text) || pick(/共有 (\d+) 个 NFT/, text);
    row.totalNft = pick(/共有 (\d+) 个 NFT/, text);
    row.listed = pick(/>(\d+%)\s*<\/[\w-]+>\s*<[^>]*>\s*上架率/, text);
    // FAQ 摘要句（含 24h 交易与挂单状态的明文）
    const faq = text.match(/该项目近期的表现如何？([\s\S]{0,300}?)</);
    row.recent = faq ? faq[1].replace(/\s+/g, " ").trim().slice(0, 160) : "";
    const faq2 = text.match(/我需要多少钱才能完成购买？([\s\S]{0,300}?)</);
    row.listState = faq2 ? faq2[1].replace(/\s+/g, " ").trim().slice(0, 120) : "";
    // 页面标题里的 NFT 总数
    const titleCount = text.match(/([A-Za-z0-9 .]+)'s (\d+) unique NFTs/);
    if (titleCount) row.totalNft = titleCount[2];
    if (!text.includes(r.contract.slice(2, 10))) row.note = "页面未含该合约（可能未被 OKX 收录）";
  } catch (e) {
    row.okxError = String(e.message).slice(0, 80);
  }
  out.push(row);
  i++;
  if (i % 10 === 0) {
    fs.writeFileSync("data/okx-data.json", JSON.stringify(out, null, 2));
    console.error(`进度 ${i}/${rows.length}`);
  }
  await new Promise((res) => setTimeout(res, 800));
}
fs.writeFileSync("data/okx-data.json", JSON.stringify(out, null, 2));

// 控制台摘要
console.log("\n== OKX 市场数据（按链上 6h 活跃排序）==");
console.log("名称".padEnd(22), "6h转让", "地板价", "24h交易", "挂单", "持有者");
for (const r of out.sort((a, b) => b.t6h - a.t6h)) {
  if (r.t6h === 0 && !r.floor) continue;
  console.log(
    String(r.name).slice(0, 20).padEnd(22),
    String(r.t6h).padEnd(6),
    String(r.floor).padEnd(6),
    (r.recent || "").includes("没有交易") ? "无" : "有",
    String(r.listed || "--").padEnd(5),
    String(r.holders || "--").padEnd(6)
  );
}
