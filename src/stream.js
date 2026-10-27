import WebSocket from "ws";
import { EventEmitter } from "node:events";
import { config } from "./config.js";
import { log } from "./logger.js";
import { getWsProxyAgent } from "./proxy.js";
import { notify } from "./telegram.js";

/**
 * mintgo BSC 新项目流客户端
 * - Bearer 鉴权
 * - 断线自动重连（指数退避），重连带 ?since=<cursor>
 * - 服务端 429 限流时退避加长（2 分钟起步，最长 10 分钟）
 * - 断线超 30 分钟推送告警（每 2 小时最多一次），恢复时推送通知
 * 事件: "ready" (info) / "event" (project.new 原始事件)
 */
export class MintgoStream extends EventEmitter {
  constructor({ getCursor, onCursor }) {
    super();
    this.getCursor = getCursor;
    this.onCursor = onCursor;
    this.ws = null;
    this.backoff = 0;
    this.closed = false;
    this.lastMsgAt = 0;
    this.watchTimer = null;
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.rateLimited = false;
    this.lastOpenAt = 0;
    this.downAlertAt = 0;
    this.wasDown = false;
  }

  start() {
    this.closed = false;
    this.connect();
  }

  stop() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    clearInterval(this.watchTimer);
    if (this.ws) {
      try {
        this.ws.terminate();
      } catch {}
    }
  }

  url() {
    const cursor = this.getCursor();
    const base = config.mintgo.streamUrl;
    return cursor > 0 ? `${base}?since=${cursor}` : base;
  }

  connect() {
    if (this.closed) return;
    const url = this.url();
    log.info("stream", `连接 ${url}`);
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${config.mintgo.apiKey}` },
      agent: getWsProxyAgent(),
      handshakeTimeout: 20_000,
    });
    this.ws = ws;
    this.lastMsgAt = Date.now();

    ws.on("message", (raw) => {
      this.lastMsgAt = Date.now();
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        log.warn("stream", "非 JSON 消息: " + raw.toString().slice(0, 200));
        return;
      }
      if (msg.type === "ready") {
        log.info("stream", `ready cursor=${msg.cursor} expiresAt=${msg.expiresAt}`);
        this.onCursor?.(msg.cursor);
        this.emit("ready", msg);
      } else if (msg.type === "caught_up") {
        log.info("stream", `已追平 cursor=${msg.cursor}`);
      } else if (msg.type === "project.new") {
        if (Number.isFinite(msg.cursor)) this.onCursor?.(msg.cursor);
        this.emit("event", msg);
      } else {
        log.info("stream", "其他消息类型: " + raw.toString().slice(0, 300));
      }
    });

    ws.on("open", () => {
      const wasDown = this.lastOpenAt > 0 && this.wasDown;
      this.backoff = 0;
      this.rateLimited = false;
      this.lastOpenAt = Date.now();
      this.wasDown = false;
      log.info("stream", "已连接，等待事件");
      if (wasDown) notify("🟢 <b>mintgo 流已恢复连接</b>，继续监听新项目");
      this.pingTimer = setInterval(() => {
        try {
          ws.ping();
        } catch {}
      }, 30_000);
      this.watchTimer = setInterval(() => {
        if (Date.now() - this.lastMsgAt > 180_000) {
          log.warn("stream", "3 分钟无消息，优雅关闭后重连（让服务端尽快释放连接配额）");
          try {
            ws.close();
          } catch {}
          setTimeout(() => {
            try {
              ws.terminate();
            } catch {}
          }, 5000);
        }
      }, 30_000);
    });

    ws.on("pong", () => {
      this.lastMsgAt = Date.now();
    });

    ws.on("unexpected-response", (req, res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        const h = res.headers || {};
        const rlHeaders = Object.fromEntries(Object.entries(h).filter(([k]) => /rate|limit|retry/i.test(k)));
        log.warn(
          "stream",
          `握手被拒 status=${res.statusCode} server=${h.server || "?"} cf-ray=${h["cf-ray"] || "-"} 限流头=${JSON.stringify(rlHeaders)} body=${body.slice(0, 200)}`
        );
        if (res.statusCode === 429) {
          this.rateLimited = true;
        }
        // 别 res.destroy() — ws 在握手拒绝后会自动 emit error+close，
        // 手动销毁会打乱事件循环导致 ExitCode=0 异常退出；交给 error/close 完成退避
      });
    });

    ws.on("error", (e) => {
      if (/429/.test(e.message)) {
        this.rateLimited = true;
        log.warn("stream", "服务端限流（429），进入长退避等待");
      } else {
        log.error("stream", `WS 异常: ${e.message}`);
      }
      // 吞掉错误，防止未捕获异常导致整个 Node 进程崩溃退出
    });

    ws.on("close", (code, reason) => {
      clearInterval(this.pingTimer);
      clearInterval(this.watchTimer);
      if (this.closed) return;
      this.wasDown = true;
      // 断线超过 30 分钟：推送告警（每 2 小时最多一次）
      if (this.lastOpenAt > 0 && Date.now() - this.lastOpenAt > 30 * 60_000 && Date.now() - this.downAlertAt > 2 * 3600_000) {
        this.downAlertAt = Date.now();
        notify("🔴 <b>mintgo 流已断开超过 30 分钟</b>，正在持续重连。若长期不恢复，请检查 mintgo key 是否过期或被限流（mintgo.fun 重置后更新 .env 重启）。");
      }
      const r = reason?.toString() || "";
      log.warn("stream", `连接关闭 code=${code} ${r}，${Math.round(this.delay() / 1000)}s 后重连`);
      this.reconnectTimer = setTimeout(() => this.connect(), this.delay());
      this.backoff = Math.min(this.backoff + 1, 6);
    });
  }

  delay() {
    if (this.rateLimited) {
      // 429/CONNECTION_LIMIT：等旧连接在服务端释放，60s 起步、5min 封顶
      return Math.min(300_000, 60_000 * 2 ** Math.min(this.backoff, 3)) + Math.floor(Math.random() * 5000);
    }
    return Math.min(60_000, 1000 * 2 ** this.backoff) + Math.floor(Math.random() * 800);
  }
}
