import { ethers } from "ethers";
import { rpc } from "./rpc.js";

// 绝不允许替用户执行的函数选择器（授权/转账类）
const FORBIDDEN_SELECTORS = new Set(
  [
    "approve(address,uint256)",
    "setApprovalForAll(address,bool)",
    "transferFrom(address,address,uint256)",
    "safeTransferFrom(address,address,uint256)",
    "safeTransferFrom(address,address,uint256,bytes)",
    "transfer(address,uint256)",
    "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
  ].map((sig) => ethers.id(sig).slice(0, 10))
);

// CREATE2 部署工厂（mintgo 新项目由此部署 NFT 合约，discovery tx 即部署交易）
const DEPLOY_FACTORY = "0x4e59b44847b379678b781793ed19c6b5ba922b6e";

export function bnbToWei(bnb) {
  return BigInt(Math.round(Number(bnb) * 1e15)) * 1000n;
}

/** 部署型项目：扫描合约最近几分钟的真实 mint（Transfer from 0x0），原样复制他人成功的 mint calldata */
async function replicaMintCalldata(contract, deadline) {
  try {
    const latest = await rpc.blockNumber();
    const from = Math.max(1, latest - 2000); // ≈15 分钟窗口
    const logs = await rpc.ethGetLogs({
      address: contract,
      topics: [TRANSFER, pad0, null],
      fromBlock: "0x" + from.toString(16),
      toBlock: "0x" + latest.toString(16),
    });
    // 取最新一笔 mint 交易
    for (let i = logs.length - 1; i >= 0; i--) {
      const tx = await rpc.getTx(logs[i].transactionHash).catch(() => null);
      if (tx && tx.to && tx.to.toLowerCase() === contract && tx.input && tx.input !== "0x" && (tx.input.length - 2) / 2 < 2000) {
        return { inputData: tx.input, value: BigInt(tx.value || 0) };
      }
    }
  } catch {}
  return null;
}

const pad0 = "0x" + "0".repeat(64);
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * 用 functionName 生成候选签名，eth_call 以 value=0 模拟，返回一个能跑通的 calldata。
 * 用于：免费但拿不到发现者 calldata 时的兜底，以及 preview 被拒后的备选重试。
 */
export async function findMintCandidate(event, walletAddress) {
  if (!event.functionName || !walletAddress) return null;
  const fn = String(event.functionName).replace(/\(.*/, "");
  const sigs = [...new Set([`${fn}()`, `${fn}(uint256)`, `${fn}(uint256,uint256)`, "publicMint()", "mint()"])];
  for (const sig of sigs) {
    try {
      const selector = ethers.id(sig).slice(0, 10);
      let data = selector;
      const argCount = (sig.match(/,/g) || []).length + (sig.includes("(uint256") ? 1 : 0);
      if (argCount >= 1) data += BigInt(1).toString(16).padStart(64, "0");
      if (argCount >= 2) data += BigInt(1).toString(16).padStart(64, "0");
      await rpc.ethCall({ to: (event.contractAddress || "").toLowerCase(), from: walletAddress, data, value: "0x0" });
      return data;
    } catch {
      /* 该候选不可用，试下一个 */
    }
  }
  return null;
}

/**
 * 把 project.new 事件变成可执行的 mint 计划。
 * 权威来源是发现者首笔 mint 交易（链上 value + calldata 原样复制）；
 * 拿不到交易时退回事件自带字段。
 */
export async function buildMintPlan(event, walletAddress) {
  const plan = {
    eventId: event.eventId,
    contract: (event.contractAddress || "").toLowerCase(),
    name: event.name || "(未命名)",
    qty: event.mintQuantity ?? null,
    valueWei: null,
    inputData: null,
    priceSource: null,
    kind: "unknown", // free | paid | unknown | forbidden
    note: "",
  };

  let tx = null;
  if (event.transactionHash) {
    try {
      tx = await rpc.getTx(event.transactionHash);
    } catch (e) {
      plan.note = `RPC 拉取发现交易失败: ${e.message}`;
    }
  }

  if (tx && tx.to && tx.to.toLowerCase() === plan.contract) {
    plan.valueWei = BigInt(tx.value);
    plan.inputData = tx.input && tx.input !== "0x" ? tx.input : null;
    plan.priceSource = "discovery-tx";
  } else if (tx) {
    const to = (tx.to || "").toLowerCase();
    const inputLen = ((tx.input || "").length - 2) / 2;
    if (to === DEPLOY_FACTORY || inputLen > 5000) {
      // 部署型项目：discovery tx 是工厂部署合约（value 反映 mint 成本，免费平台为 0）
      plan.valueWei = BigInt(tx.value || 0);
      plan.priceSource = "deployer-tx";
      plan.deployKind = true;
      plan.note = "部署型项目（CREATE2 工厂），免费判定 + 复制他人 mint 调用";
    } else {
      plan.note = "发现交易 to 与合约不一致（可能经由路由），退回事件字段判定";
    }
  }

  if (plan.valueWei === null) {
    const v = event.valueNative;
    if (event.priceConfirmed && v != null && Number(v) === 0) {
      plan.valueWei = 0n;
      plan.priceSource = "event-confirmed";
    } else if (event.priceConfirmed && v != null && Number(v) > 0) {
      // 按发现者数量折算总花费（若 valueNative 本就是总额，这里只是保守高估）
      plan.valueWei = bnbToWei(Number(v) * (plan.qty || 1));
      plan.priceSource = "event-confirmed(per×qty)";
    }
  }

  // 部署型项目：优先复制他人成功 mint 的 calldata（参数天然正确）
  if (plan.deployKind && !plan.inputData && plan.valueWei === 0n) {
    const replica = await replicaMintCalldata(plan.contract);
    if (replica) {
      plan.inputData = replica.inputData;
      plan.valueWei = replica.value;
      plan.priceSource = "deploy-tx+replica";
    }
  }

  // 没有 calldata 时：用 functionName 生成候选，eth_call 以 value=0 模拟。
  // 模拟能跑通 = 直连免费 mint 路径真实存在；顺带解决价格未知（含经由路由 mint）的项目。
  if (!plan.inputData && event.functionName && walletAddress) {
    const fn = String(event.functionName).replace(/\(.*/, "");
    const sigs = [...new Set([`${fn}()`, `${fn}(uint256)`, "publicMint()", "mint()"])];
    for (const sig of sigs) {
      try {
        const selector = ethers.id(sig).slice(0, 10);
        const data = sig.includes("(uint256)")
          ? selector + BigInt(1).toString(16).padStart(64, "0")
          : selector;
        await rpc.ethCall({ to: plan.contract, from: walletAddress, data, value: "0x0" });
        plan.inputData = data;
        if (plan.valueWei === null) {
          plan.valueWei = 0n;
          plan.priceSource = `sim:free(${sig})`;
        } else {
          plan.priceSource += ` +sim:${sig}`;
        }
        break;
      } catch {
        /* 该候选不可用，试下一个 */
      }
    }
  }

  if (plan.valueWei === null) {
    plan.kind = "unknown";
    return plan;
  }

  plan.kind = plan.valueWei === 0n ? "free" : "paid";

  if (plan.inputData) {
    const sel = plan.inputData.slice(0, 10).toLowerCase();
    if (FORBIDDEN_SELECTORS.has(sel)) {
      plan.kind = "forbidden";
      plan.note = `发现交易的 calldata 是敏感操作 ${sel}，拒绝执行`;
    }
  }

  return plan;
}
