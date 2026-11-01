import { config } from "./config.js";
import { log } from "./logger.js";
import { store } from "./state.js";
import { rpc } from "./rpc.js";
import { buildMintPlan, findMintCandidate, bnbToWei } from "./classify.js";
import { wallet } from "./baw.js";
import { notify, projectMessage } from "./telegram.js";

let walletState = { connected: false, address: null, warnedAt: 0 };
let offlineAlertAt = 0;

export function setWalletState(s) {
  walletState = { ...walletState, ...s };
}

/** baw 会话失效类错误（掉线/未登录/服务端异常） */
function isBawAuthError(msg) {
  return /NOT_LOGGED_IN|10003000|System abnormality|UNAUTHORIZED|LOGGED_OUT/i.test(String(msg));
}

/** 会话失效：复位登录态 + 推送掉线告警（每 2 小时最多一次） */
function noteBawOffline(reason) {
  walletState.connected = false;
  walletState.address = null;
  walletState.lastProbeAt = 0;
  const now = Date.now();
  log.warn("minter", `baw 会话失效（${String(reason).slice(0, 120)}），等待重新扫码登录`);
  if (now - offlineAlertAt > 2 * 3600_000) {
    offlineAlertAt = now;
    notify("🔐 <b>baw 钱包已掉线，自动 mint 暂停</b>\n请重新扫码登录（npm run signin / deploy/nas.py signin），登录后服务自动恢复，无需重启。");
  }
}

async function hasContractCode(address) {
  try {
    const code = await rpc.getCode(address);
    return !!code && code !== "0x";
  } catch {
    return true; // RPC 拿不到时放行到 preview（币安侧还会模拟）
  }
}

/**
 * 处理一条 project.new 事件：判定 → 安全闸门 → baw preview/execute → 通知。
 * 全程串行调用（index.js 里有队列），这里不用考虑并发。
 */
export async function handleEvent(event) {
  const eventId = event.eventId;
  if (!eventId || !event.contractAddress) {
    log.warn("minter", "事件缺少 eventId/contractAddress，忽略");
    return;
  }

  store.appendEvent(event);

  if (store.hasSeen(eventId)) {
    log.info("minter", `重复事件 ${eventId}，跳过`);
    return;
  }
  store.markSeen(eventId);

  const prev = store.attemptOf(eventId);
  if (prev) {
    log.info("minter", `事件 ${eventId} 已处理过（${prev.status}），跳过`);
    return;
  }

  log.info("minter", `新项目: ${event.name || "?"} ${event.contractAddress} valueNative=${event.valueNative} confirmed=${event.priceConfirmed} fn=${event.functionName}`);

  const plan = await buildMintPlan(event, walletState.address);
  log.info("minter", `判定 kind=${plan.kind} value=${plan.valueWei}n source=${plan.priceSource} note=${plan.note}`);

  // ---- 分类闸门 ----
  if (plan.kind === "unknown") {
    store.recordAttempt(eventId, plan.contract, "unknown-price", { reason: plan.note });
    notify(projectMessage({ plan, action: "❓ <b>价格未知的新项目</b>（未自动 mint）" }));
    return;
  }
  if (plan.kind === "forbidden") {
    store.recordAttempt(eventId, plan.contract, "forbidden", { reason: plan.note });
    notify(projectMessage({ plan, action: "🚫 <b>可疑项目，已拦截</b>", detail: plan.note }));
    return;
  }
  if (plan.kind === "paid") {
    const maxWei = bnbToWei(config.mint.maxValueBnb);
    if (plan.valueWei > maxWei) {
      store.recordAttempt(eventId, plan.contract, "paid-skip", { reason: `花费超出 MAX_VALUE_BNB=${config.mint.maxValueBnb}` });
      if (config.notify.nonFree) {
        notify(projectMessage({ plan, action: "💰 <b>付费项目，未自动 mint</b>" }));
      } else {
        log.info("minter", "付费项目，未通知");
      }
      return;
    }
    // 落在允许范围内的付费 mint 继续往下走
  }

  if (!config.autoMint) {
    store.recordAttempt(eventId, plan.contract, "auto-off");
    notify(projectMessage({ plan, action: "🔔 <b>新项目（自动 mint 已关闭）</b>" }));
    return;
  }

  // ---- 执行前安全闸门 ----
  const allow = store.dailyAllowance(config.mint.maxPerDay);
  if (allow <= 0) {
    store.recordAttempt(eventId, plan.contract, "daily-cap");
    notify(projectMessage({ plan, action: "⛔ <b>已达每日 mint 上限，本项目跳过</b>" }));
    return;
  }

  if (!plan.inputData) {
    store.recordAttempt(eventId, plan.contract, "no-calldata", { reason: plan.note });
    notify(projectMessage({ plan, action: "⚠️ <b>免费项目但无法构造 calldata，未 mint</b>", detail: plan.note }));
    return;
  }

  if (!(await hasContractCode(plan.contract))) {
    store.recordAttempt(eventId, plan.contract, "no-code");
    notify(projectMessage({ plan, action: "🚫 <b>合约无代码（可能是假部署），未 mint</b>" }));
    return;
  }

  if (!walletState.connected || !walletState.address) {
    // 懒重查：用户扫码登录后不必重启服务，最多每 10 分钟探测一次
    if (Date.now() - (walletState.lastProbeAt || 0) > 10 * 60_000) {
      walletState.lastProbeAt = Date.now();
      try {
        const st = await wallet.status();
        if (String(st).toUpperCase() === "CONNECTED") {
          walletState.connected = true;
          walletState.address = await wallet.address();
          log.info("minter", `baw 已登录（懒检测）地址=${walletState.address}`);
        }
      } catch {}
    }
  }
  if (!walletState.connected || !walletState.address) {
    store.recordAttempt(eventId, plan.contract, "wallet-unconnected");
    noteBawOffline("懒检测未登录");
    return;
  }

  const bal = await wallet.bnbBalance();
  if (bal != null) {
    const need = Number(plan.valueWei) / 1e18 + config.mint.bnbReserve;
    if (bal < need) {
      store.recordAttempt(eventId, plan.contract, "low-balance", { reason: `BNB 余额 ${bal} 低于阈值` });
      notify(projectMessage({ plan, action: "⛽ <b>BNB 余额不足（低于保留线），未 mint</b>", detail: `余额 ${bal} BNB` }));
      return;
    }
  }

  if (config.dryRun) {
    store.recordAttempt(eventId, plan.contract, "dry-run", {
      to: plan.contract,
      value: String(plan.valueWei),
      inputData: plan.inputData,
    });
    notify(projectMessage({
      plan,
      action: "🧪 <b>DRY-RUN：本应自动 mint（已拦截在广播前）</b>",
      detail: `to=${plan.contract} value=${plan.valueWei} data=${plan.inputData.slice(0, 20)}…`,
    }));
    return;
  }

  // ---- 执行：baw preview（币安侧模拟）→ execute；preview 被拒时用候选 calldata 兜底一次 ----
  const tryMint = async (inputData) => {
    log.info("minter", `preview: to=${plan.contract} value=${plan.valueWei} data=${inputData.slice(0, 34)}…`);
    const { requestId } = await wallet.contractCallPreview({
      from: walletState.address,
      to: plan.contract,
      valueWei: plan.valueWei,
      inputData,
    });
    log.info("minter", `preview OK requestId=${requestId}，执行`);
    return wallet.contractCallExecute(requestId);
  };

  try {
    let viaCandidate = false;
    let exec;
    try {
      exec = await tryMint(plan.inputData);
    } catch (firstErr) {
      if (isBawAuthError(firstErr.message)) {
        noteBawOffline(firstErr.message);
        throw firstErr; // 掉线时不再浪费候选重试
      }
      // 币安侧模拟拒绝：可能是发现者 calldata 带有特定参数/状态已变。试模拟通过的候选签名。
      const alt = await findMintCandidate(event, walletState.address);
      if (alt && alt.toLowerCase() !== String(plan.inputData).toLowerCase()) {
        log.info("minter", `preview 被拒（${String(firstErr.message).slice(0, 160)}），尝试候选 calldata: ${alt.slice(0, 10)}…`);
        exec = await tryMint(alt);
        viaCandidate = true;
      } else {
        throw firstErr;
      }
    }
    log.info("minter", `execute 完成 status=${exec.status} tx=${exec.txHash}`);
    store.recordAttempt(eventId, plan.contract, "minted", {
      txHash: exec.txHash,
      via: viaCandidate ? "candidate-calldata" : "discovery-tx",
    });
    notify(projectMessage({
      plan,
      action: "✅ <b>自动 mint 已提交</b>" + (viaCandidate ? "（候选 calldata）" : ""),
      detail: exec.txHash ? `交易: <code>${exec.txHash}</code>\nhttps://bscscan.com/tx/${exec.txHash}` : JSON.stringify(exec.raw).slice(0, 400),
    }));
  } catch (e) {
    log.error("minter", `mint 放弃 ${plan.name}: ${e.message}`);
    store.recordAttempt(eventId, plan.contract, "mint-failed", { reason: String(e.message).slice(0, 500) });
    // preview 被拒 = 未广播上链，无 gas 损失；常见原因随推送带出
    notify(projectMessage({
      plan,
      action: "🟡 <b>模拟未通过，已自动放弃</b>（未上链、无损失）",
      detail: String(e.message)
        .replace(/^baw contract-call preview 失败: /, "币安模拟拒绝: ")
        .slice(0, 400),
    }));
  }
}
