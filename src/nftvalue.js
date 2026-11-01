// NFT 价值跟踪：每晚 21:00（北京）扫描所有 minted 合约的链上活跃度并推送分级报告
// RPC 用 node:https 直连（不走 undici 全局代理），避免 clash 出口被公共节点风控
import https from "node:https";
import fs from "node:fs";
import { store } from "./state.js";
import { log } from "./logger.js";
import { notify } from "./telegram.js";
import { getWalletAddress } from "./minter.js";

const DEFAULT_RPCS = "https://rpc-bsc.48.club,https://bsc.publicnode.com,https://1rpc.io/bnb";

function rpcUrls() {
  const env = process.env.NFTVALUE_RPC_URLS || DEFAULT_RPCS;
  return env.split(",").map((s) => s.trim()).filter(Boolean);
}

let urlIdx = 0;
let lastReqAt = 0;
const MIN_GAP = 300;

function walletLower() {
  return (getWalletAddress() || "").toLowerCase();
}

function postJson(url, body, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request(
      u,
      {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) },
        timeout: timeoutMs,
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          if (!buf.trim().startsWith("{")) return reject(new Error(`RETRYABLE HTTP${res.statusCode}`));
          try {
            const j = JSON.parse(buf);
            if (j.error) {
              const msg = JSON.stringify(j.error).slice(0, 100);
              if (/limit|rate|exceed/i.test(msg)) return reject(new Error(`RETRYABLE ${msg}`));
              return reject(new Error(msg));
            }
            resolve(j.result);
          } catch {
            reject(new Error("RETRYABLE bad json"));
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("RETRYABLE timeout")));
    req.on("error", (e) => reject(new Error(`RETRYABLE ${e.message}`)));
    req.write(data);
    req.end();
  });
}

async function rpc(method, params, tries = 8) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const gap = Date.now() - lastReqAt;
    if (gap < MIN_GAP) await new Promise((r) => setTimeout(r, MIN_GAP - gap));
    lastReqAt = Date.now();
    const urls = rpcUrls();
    const url = urls[urlIdx++ % urls.length];
    try {
      return await postJson(url, { jsonrpc: "2.0", id: 1, method, params });
    } catch (e) {
      lastErr = e;
      if (!/^RETRYABLE/.test(e.message)) throw e;
    }
  }
  throw lastErr;
}

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad = (a) => "0x" + "0".repeat(24) + a.toLowerCase().replace(/^0x/, "");

async function blockInfo() {
  const latest = await rpc("eth_getBlockByNumber", ["latest", false]);
  const n = parseInt(latest.number, 16);
  const ref = await rpc("eth_getBlockByNumber", ["0x" + (n - 20000).toString(16), false]);
  const spb = Math.max(0.2, (parseInt(latest.timestamp, 16) - parseInt(ref.timestamp, 16)) / 20000);
  return { latest: n, spb, h6: Math.round(n - 21600 / spb), h24: Math.round(n - 86400 / spb) };
}

async function getLogsRange(filter, fromBlock, toBlock, deadline) {
  const logs = [];
  let from = fromBlock;
  let span = Math.min(4000, toBlock - fromBlock + 1);
  while (from <= toBlock) {
    if (Date.now() > deadline) throw new Error("BUDGET");
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

async function contractName(addr) {
  try {
    const out = await rpc("eth_call", [{ to: addr, data: "0x06fdde03" }, "latest"]);
    if (out && out !== "0x" && out.length >= 130) {
      const s = Buffer.from(out.slice(130).replace(/(00)+$/, ""), "hex").toString("utf8").replace(/[^\x20-\x7e]/g, "").trim();
      if (s) return s;
    }
  } catch {}
  return null;
}

/**
 * 扫描全部 minted 合约的近 6h 链上活跃度。
 * 返回 [{ contract, name, t6h, addrs6h, balance, delta }]
 */
export async function scanValue() {
  const contracts = Object.entries(store.snapshot().mintedContracts || {});
  if (!contracts.length) return { scanned: 0, rows: [] };
  const { latest, h6 } = await blockInfo();
  const wallet = walletLower();
  if (!wallet) {
    log.warn("nftvalue", "钱包地址未知，跳过扫描");
    return { scanned: 0, rows: [] };
  }
  const rows = [];
  const deadline0 = Date.now() + 20 * 60_000; // 全量总预算 20 分钟（62 合约 × ~15 请求，2 路并发）
  const queue = contracts.slice();
  const scanOne = async ([contract, meta]) => {
    const deadline = Date.now() + 120_000;
    const row = { contract, name: meta.name || "?", t6h: 0, addrs6h: 0, balance: null, delta: null, err: null };
    try {
      const act = await getLogsRange({ address: contract, topics: [TRANSFER] }, h6, latest, deadline);
      const addrs = new Set();
      for (const l of act) {
        if (!l.topics[1] || BigInt(l.topics[1]) === 0n) continue;
        row.t6h++;
        addrs.add(l.topics[1]);
        addrs.add(l.topics[2]);
      }
      row.addrs6h = addrs.size;
      try {
        const out = await rpc("eth_call", [{ to: contract, data: "0x70a08231" + pad(wallet).slice(2) }, "latest"]);
        row.balance = out && out !== "0x" ? parseInt(out, 16) : null;
      } catch {}
      row.name = (await contractName(contract)) || row.name;
      if (row.name && row.name !== "?") store.markMinted(contract, row.name);
      const prev = store.snapshot().valuePrev || {};
      if (prev[contract] != null) row.delta = row.t6h - prev[contract];
    } catch (e) {
      row.err = String(e.message).slice(0, 60);
    }
    rows.push(row);
    return row;
  };
  async function worker() {
    while (queue.length) {
      if (Date.now() > deadline0) {
        log.warn("nftvalue", "扫描总预算超 20 分钟，剩余合约明天再扫");
        return;
      }
      const e = queue.shift();
      if (!e) break;
      await scanOne(e);
    }
  }
  await Promise.all([worker(), worker()]);
  return { scanned: rows.length, rows };
}

function bjDay(now = Date.now()) {
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
}
function bjHHMM(now = Date.now()) {
  return new Date(now + 8 * 3600_000).toISOString().slice(11, 16);
}

/** 组装 HTML 报告 */
export function buildValueText(rows) {
  const hot = rows.filter((r) => !r.err && r.t6h >= 3).sort((a, b) => b.t6h - a.t6h);
  const warm = rows.filter((r) => !r.err && r.t6h >= 1 && r.t6h < 3).sort((a, b) => b.t6h - a.t6h);
  const dead = rows.filter((r) => !r.err && r.t6h === 0);
  const errs = rows.filter((r) => r.err);
  const line = (r) =>
    `• <b>${r.name}</b> — ${r.t6h} 笔转让 / ${r.addrs6h} 地址` +
    (r.balance != null ? `（在手 ${r.balance}）` : "") +
    (r.delta != null && r.delta !== 0 ? ` 环比${r.delta > 0 ? "+" : ""}${r.delta}` : "") +
    `\n  <a href="https://web3.okx.com/nft/collection/bsc/${r.contract}">OKX 页面</a> · bscscan: <a href="https://bscscan.com/token/${r.contract}">合约</a>`;
  let text = `🌙 <b>NFT 价值日报</b>（北京时间 ${bjDay()} 21:00）\n扫描 minted 合约: ${rows.length}\n`;
  text += `\n🔥 <b>高活跃（6h≥3 笔真实转让）</b>\n${hot.length ? hot.map(line).join("\n") : "（无）"}`;
  if (warm.length) text += `\n\n🟡 <b>低活跃（1-2 笔）</b>\n${warm.map(line).join("\n")}`;
  text += `\n\n💤 死盘: ${dead.length} 个（近 6h 零转让，建议持有不动）`;
  if (errs.length) text += `\n⚠️ 扫描失败: ${errs.length} 个（下晚重试）`;
  text += `\n\n卖出判断参考：高活跃项目打开 OKX 页面看地板价与挂单，接 offer 或挂略低于地板的价试水。当前策略：先不卖，持续观察。`;
  return text;
}

/** 每分钟调用：北京时间 21:00-21:05 触发，每天一次 */
export async function maybeNightlyValueReport(now = Date.now()) {
  const hhmm = bjHHMM(now);
  if (hhmm < "21:00" || hhmm > "21:05") return false;
  const day = bjDay(now);
  if (store.snapshot().lastValueReportOn === day) return false;
  store.markValueReport(day);
  try {
    const { rows } = await scanValue();
    const text = buildValueText(rows);
    notify(text);
    store.saveValuePrev(Object.fromEntries(rows.map((r) => [r.contract, r.t6h])));
    log.info("nftvalue", `每晚价值报告已推送（${rows.length} 个合约）`);
  } catch (e) {
    log.error("nftvalue", `价值报告失败: ${e.message}`);
    notify(`⚠️ NFT 价值报告生成失败：${String(e.message).slice(0, 120)}`);
  }
  return true;
}

/** 手动触发（测试/即时报告）：扫描；push=false 时只打日志不推送 */
export async function runValueReportNow(push = true) {
  const { rows } = await scanValue();
  const text = buildValueText(rows);
  if (push) notify(text);
  else log.info("nftvalue", `DRY 报告预览:\n${text.replace(/<[^>]+>/g, "")}`);
  store.saveValuePrev(Object.fromEntries(rows.map((r) => [r.contract, r.t6h])));
  return rows.length;
}

/** 启动时从 data/minted-seed.tsv 合并历史合约（contract\tname\ttx） */
export function seedFromTsv(path = "data/minted-seed.tsv") {
  try {
    const lines = fs.readFileSync(path, "utf8").trim().split("\n");
    const entries = lines.map((l) => {
      const [contract, name, tx] = l.split("\t");
      return { contract, name, tx };
    });
    return store.seedMinted(entries);
  } catch {
    return 0;
  }
}
