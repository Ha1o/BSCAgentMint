// 并发握手测试：同一 key 同时开 N 条 WS 连接，验证是否存在并发上限 / 429
import WebSocket from "ws";
import { getWsProxyAgent } from "../src/proxy.js";
import { config } from "../src/config.js";

const N = Number(process.env.N || 4);
const results = [];
const recorded = new Set();
const finish = () => {
  if (recorded.size >= N) {
    console.log(results.join("\n"));
    process.exit(0);
  }
};

for (let i = 0; i < N; i++) {
  // 每条连接错开 500ms，模拟真实重连场景
  await new Promise((r) => setTimeout(r, 500 * i));
  const ws = new WebSocket(config.mintgo.streamUrl, {
    headers: { authorization: `Bearer ${config.mintgo.apiKey}` },
    agent: getWsProxyAgent(),
    handshakeTimeout: 15_000,
  });
  const tag = `conn${i}`;
  const record = (s) => {
    if (recorded.has(tag)) return;
    recorded.add(tag);
    results.push(`${tag}: ${s}`);
    try {
      ws.close();
    } catch {}
    finish();
  };
  ws.on("open", () => record("OPEN(101) ✓"));
  ws.on("unexpected-response", (req, res) => {
    let body = "";
    res.on("data", (c) => (body += c));
    res.on("end", () =>
      record(`HTTP ${res.statusCode} server=${res.headers.server || "-"} retry-after=${res.headers["retry-after"] || "-"} body=${body.slice(0, 150)}`)
    );
  });
  ws.on("error", (e) => record("ERR " + e.message.slice(0, 80)));
}

setTimeout(() => {
  console.log("30s 超时，已收到的结果：\n" + (results.join("\n") || "(无)"));
  process.exit(0);
}, 30_000);
