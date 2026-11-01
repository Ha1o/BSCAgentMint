import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve("data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const EVENTS_FILE = path.join(DATA_DIR, "events.jsonl");

const SEEN_CAP = 1000;
const ATTEMPT_CAP = 4000; // 超过后按时间修剪（保留 48h），保证 24h 摘要数据完整
const ATTEMPT_TTL = 48 * 3600_000;

const DEFAULT_STATE = {
  cursor: 0,
  seenEventIds: [],
  attempts: {}, // eventId -> { status, txHash?, reason?, at }
  day: "",
  mintedToday: 0,
  keyExpiryWarnedOn: "",
  lastDigestOn: "",
};

fs.mkdirSync(DATA_DIR, { recursive: true });

function load() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

let state = load();

function save() {
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

export const store = {
  get cursor() {
    return state.cursor;
  },
  setCursor(n) {
    if (Number.isFinite(n) && n > state.cursor) {
      state.cursor = n;
      save();
    }
  },
  hasSeen(eventId) {
    return state.seenEventIds.includes(eventId);
  },
  markSeen(eventId) {
    state.seenEventIds.unshift(eventId);
    if (state.seenEventIds.length > SEEN_CAP) state.seenEventIds = state.seenEventIds.slice(0, SEEN_CAP);
    save();
  },
  attemptOf(eventId) {
    return state.attempts[eventId];
  },
  recordAttempt(eventId, contract, status, extra = {}) {
    const prev = state.attempts[eventId];
    // 已成功 mint 过的合约不回退状态
    if (prev?.status === "minted") return;
    state.attempts[eventId] = {
      contract,
      status,
      at: new Date().toISOString(),
      ...extra,
    };
    const keys = Object.keys(state.attempts);
    if (keys.length > ATTEMPT_CAP) {
      const cutoff = new Date(Date.now() - ATTEMPT_TTL).toISOString();
      for (const k of keys) {
        if (state.attempts[k].at < cutoff) delete state.attempts[k];
      }
    }
    if (status === "minted") this.bumpDaily();
    save();
  },
  /** 统计最近 hours 小时的 attempts，供每日摘要使用 */
  attemptsStats(hours = 24) {
    const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();
    const byStatus = {};
    const failedReasons = {};
    let total = 0;
    let minted = 0;
    for (const v of Object.values(state.attempts)) {
      if (!v.at || v.at < cutoff) continue;
      total += 1;
      byStatus[v.status] = (byStatus[v.status] || 0) + 1;
      if (v.status === "minted") minted += 1;
      if (v.status === "mint-failed") {
        const r = String(v.reason || "unknown");
        failedReasons[r] = (failedReasons[r] || 0) + 1;
      }
    }
    return { total, minted, byStatus, failedReasons };
  },
  /** 每日摘要每天最多发一次（北京时间日界） */
  shouldSendDigest(bjDay) {
    if (state.lastDigestOn === bjDay) return false;
    state.lastDigestOn = bjDay;
    save();
    return true;
  },
  dailyAllowance(maxPerDay) {
    const today = new Date().toISOString().slice(0, 10);
    if (state.day !== today) {
      state.day = today;
      state.mintedToday = 0;
      save();
    }
    return Math.max(0, maxPerDay - state.mintedToday);
  },
  bumpDaily() {
    const today = new Date().toISOString().slice(0, 10);
    if (state.day !== today) {
      state.day = today;
      state.mintedToday = 0;
    }
    state.mintedToday += 1;
    save();
  },
  /** key 过期提醒每天最多一次 */
  shouldWarnKeyExpiry() {
    const today = new Date().toISOString().slice(0, 10);
    if (state.keyExpiryWarnedOn === today) return false;
    state.keyExpiryWarnedOn = today;
    save();
    return true;
  },
  appendEvent(event) {
    try {
      fs.appendFileSync(EVENTS_FILE, JSON.stringify(event) + "\n");
    } catch {
      /* ignore */
    }
  },
  snapshot() {
    return { ...state };
  },
};
