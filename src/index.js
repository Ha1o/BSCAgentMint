import { config } from "./config.js";
import { log } from "./logger.js";
import { initProxyForFetch } from "./proxy.js";
import { store } from "./state.js";
import { MintgoStream } from "./stream.js";
import { handleEvent, setWalletState } from "./minter.js";
import { notify, telegramEnabled } from "./telegram.js";
import { wallet } from "./baw.js";
import { maybeDailyDigest } from "./digest.js";

const maskKey = (k) => (k.length > 24 ? k.slice(0, 12) + "…" + k.slice(-6) : "…");

async function main() {
  await initProxyForFetch();

  log.info("boot", `BSCAgentMint 启动 AUTO_MINT=${config.autoMint} DRY_RUN=${config.dryRun} MAX_VALUE_BNB=${config.mint.maxValueBnb} 每日上限=${config.mint.maxPerDay}`);
  log.info("boot", `MintGo key: ${maskKey(config.mintgo.apiKey)} | Telegram: ${telegramEnabled() ? "已配置" : "未配置（仅日志）"}`);

  // 检查 baw 登录状态（失败不阻塞，minter 里会兜底）
  let connected = false;
  let address = null;
  try {
    const status = await wallet.status();
    connected = String(status).toUpperCase() === "CONNECTED";
    log.info("boot", `baw 钱包状态: ${status}`);
    if (connected) {
      address = await wallet.address();
      const agentId = await wallet.agentId();
      log.info("boot", `BSC 地址: ${address} | Agent ID: ${agentId || "(未查询到)"}`);
      notify(`🤖 <b>BSCAgentMint 已启动</b>\n钱包: <code>${address || "?"}</code>\nAgent ID: ${agentId || "-"}\n模式: ${config.dryRun ? "DRY-RUN" : config.autoMint ? "自动 mint" : "仅通知"}`);
    } else {
      log.warn("boot", "baw 未登录：运行 npm run signin 扫码登录，登录前只通知不 mint");
      notify("🤖 <b>BSCAgentMint 已启动（baw 未登录）</b>\n运行 <code>npm run signin</code> 扫码登录币安 Agentic Wallet 后才会自动 mint。");
    }
  } catch (e) {
    log.warn("boot", `baw 状态查询失败（继续启动）: ${e.message}`);
  }
  setWalletState({ connected, address });

  // 事件串行处理，避免同一时刻多笔并发交易
  let chain = Promise.resolve();
  const enqueue = (fn) => {
    chain = chain.then(fn).catch((e) => log.error("queue", e.message));
  };

  const stream = new MintgoStream({
    getCursor: () => store.cursor,
    onCursor: (n) => store.setCursor(n),
  });

  stream.on("ready", (info) => {
    const expiresAt = info.expiresAt || 0;
    if (expiresAt && expiresAt - Date.now() < 48 * 3600_000 && store.shouldWarnKeyExpiry()) {
      const t = new Date(expiresAt).toISOString();
      notify(`⏰ <b>MintGo API key 即将过期</b>（${t}），请到 mintgo.fun 重置并更新 .env 的 MINTGO_API_KEY`);
    }
  });

  stream.on("event", (event) => {
    enqueue(() => handleEvent(event));
  });

  const shutdown = () => {
    log.info("boot", "退出");
    stream.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // 每日摘要：北京时间 08:00-08:05 窗口内推送过去 24 小时统计
  setInterval(() => {
    try {
      maybeDailyDigest();
    } catch (e) {
      log.warn("digest", `摘要推送失败: ${e.message}`);
    }
  }, 60_000);

  stream.start();
}

main().catch((e) => {
  log.error("boot", e.stack || e.message);
  process.exit(1);
});
