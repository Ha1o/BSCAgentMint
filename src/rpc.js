import { config } from "./config.js";
import { log } from "./logger.js";
import https from "node:https";
import http from "node:http";

let urlIndex = 0;

/** 直连 RPC（node:https，不走 undici 全局代理）：clash 出口 IP 会被公共节点 CDN 风控返回 403 HTML */
function post(url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "http:" ? http : https;
    const data = JSON.stringify(body);
    const req = mod.request(
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
          if (!buf.trim().startsWith("{")) {
            return reject(new Error(`RETRYABLE HTTP${res.statusCode} 非JSON响应（节点风控/限流）`));
          }
          try {
            const json = JSON.parse(buf);
            if (json.error) {
              const msg = json.error.message || JSON.stringify(json.error);
              return reject(new Error(/limit|rate|exceed/i.test(msg) ? `RETRYABLE ${msg}` : msg));
            }
            resolve(json.result);
          } catch (e) {
            reject(new Error("RETRYABLE 响应解析失败"));
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("RETRYABLE 请求超时")));
    req.on("error", (e) => reject(new Error(`RETRYABLE ${e.message}`)));
    req.write(data);
    req.end();
  });
}

/** 轮询 RPC 列表，单个节点失败自动切下一个；业务性 revert 直接抛出不再切换 */
async function call(method, params) {
  let lastErr;
  for (let i = 0; i < config.rpc.urls.length * 2; i++) {
    const url = config.rpc.urls[(urlIndex + i) % config.rpc.urls.length];
    try {
      const result = await post(url, { jsonrpc: "2.0", id: 1, method, params }, config.rpc.timeoutMs);
      urlIndex = (urlIndex + i) % config.rpc.urls.length;
      return result;
    } catch (e) {
      if (/revert/i.test(e.message)) throw e; // 合约逻辑性回滚，换节点也一样
      lastErr = e;
      if (!/^RETRYABLE/.test(e.message)) {
        log.warn("rpc", `${url} ${method} 失败: ${e.message}`);
      }
    }
  }
  throw lastErr || new Error("所有 RPC 均不可用");
}

export const rpc = {
  /** 发现者首笔 mint 交易：拿权威 value / calldata */
  async getTx(hash) {
    const tx = await call("eth_getTransactionByHash", [hash]);
    if (!tx) return null;
    return {
      from: tx.from,
      to: tx.to,
      value: tx.value, // hex quantity
      input: tx.input,
      blockNumber: tx.blockNumber,
    };
  },
  async getCode(address) {
    return call("eth_getCode", [address, "latest"]);
  },
  /** 只读模拟合约调用（用于候选 calldata 筛选） */
  async ethCall({ to, from, data, value = "0x0" }) {
    return call("eth_call", [{ to, from, data, value }, "latest"]);
  },
  async ethGetLogs(filter) {
    return call("eth_getLogs", [filter]);
  },
  async blockNumber() {
    const h = await call("eth_blockNumber", []);
    return parseInt(h, 16);
  },
};
