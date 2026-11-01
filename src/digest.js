import { store } from "./state.js";
import { config } from "./config.js";
import { log } from "./logger.js";
import { notify } from "./telegram.js";

/** 北京时间 YYYY-MM-DD */
function bjDay(now = Date.now()) {
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
}

function bjHHMM(now = Date.now()) {
  return new Date(now + 8 * 3600_000).toISOString().slice(11, 16);
}

const STATUS_LABELS = {
  minted: "✅ 已自动 mint",
  "mint-failed": "🟡 模拟未通过（放弃）",
  "paid-skip": "💰 付费跳过",
  "unknown-price": "❓ 价格未知",
  "wallet-unconnected": "🔐 钱包未登录错过",
  "low-balance": "⛽ 余额不足错过",
  "daily-cap": "⛔ 达每日上限",
  "no-calldata": "⚠️ 无法构造 calldata",
  "no-code": "🚫 合约无代码",
  forbidden: "🚫 可疑拦截",
  "auto-off": "🔕 自动 mint 关闭",
  "dry-run": "🧪 DRY-RUN 拦截",
};

/** 构造过去 24 小时的摘要 HTML */
export function buildDigest(hours = 24) {
  const { total, minted, byStatus, failedReasons } = store.attemptsStats(hours);
  const top = Object.entries(byStatus).sort((a, b) => b[1] - a[1]);
  const missed = (byStatus["wallet-unconnected"] || 0) + (byStatus["low-balance"] || 0) + (byStatus["daily-cap"] || 0) + (byStatus["mint-failed"] || 0);
  const lines = top.map(([st, n]) => `${STATUS_LABELS[st] || st}: <b>${n}</b>`);
  const snap = store.snapshot();
  const failTop = Object.entries(failedReasons).sort((a, b) => b[1] - a[1])[0];
  let failNote = "";
  if (failTop) {
    const r = failTop[0];
    const kind = /NOT_LOGGED_IN/i.test(r)
      ? "baw 掉线（已支持自动告警）"
      : /CONNECTION_LIMIT/i.test(r)
        ? "连接限制"
        : "币安侧模拟拒绝";
    failNote = `\n失败主因: ${kind}`;
  }
  return (
    `📊 <b>过去 ${hours} 小时摘要</b>（北京时间 ${bjDay()} 08:00）\n` +
    `事件总数: <b>${total}</b> ｜ 已 mint: <b>${minted}</b> ｜ 未 mint: <b>${total - minted}</b>\n` +
    (lines.length ? lines.join("\n") : "（无记录）") +
    `\n💥 错过机会合计: <b>${missed}</b>（登录/余额/上限/模拟失败）` +
    `\n今日已 mint: <b>${snap.mintedToday}</b> / 上限 ${config.mint.maxPerDay}` +
    failNote
  );
}

/** 每分钟调用：北京时间 08:00-08:05 窗口内发送，每天最多一次 */
export function maybeDailyDigest(now = Date.now()) {
  const hhmm = bjHHMM(now);
  if (hhmm < "08:00" || hhmm > "08:05") return false;
  const day = bjDay(now);
  if (!store.shouldSendDigest(day)) return false;
  const text = buildDigest(24);
  notify(text);
  log.info("digest", "已推送每日摘要");
  return true;
}
