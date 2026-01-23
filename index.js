import express from "express";

const app = express();

// ★重要：全体に express.json() を掛けない（MacroDroidの壊れJSONで落ちないようにする）
app.use(express.text({ type: "*/*", limit: "1mb" })); // 全リクエストを文字列で受ける

const SECRET_KEY = process.env.SECRET_KEY;

// ===== 共通設定 =====
const MAX_QUEUE = 200;

function requireKey(req, res) {
  const key = req.query.key;
  if (key !== SECRET_KEY) {
    res.status(403).json({ error: "invalid key" });
    return false;
  }
  return true;
}

function normalizeCmd(cmd) {
  const c = String(cmd || "").trim().toUpperCase();
  return c === "BUY" || c === "SELL" ? c : "";
}

function normalizeSymbol(symbol) {
  let s = String(symbol || "").trim().toUpperCase();
  if (s === "XAUUSD" || s === "XAUUSD#" || s === "XAU/USD" || s === "GOLD") s = "GOLD";
  return s;
}

function pushQueue(queue, item) {
  queue.push(item);
  while (queue.length > MAX_QUEUE) queue.shift();
}

function safeId(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

// ===== Queue A/B/C =====
const queueA = [];
const seenA = new Map();

const queueB = [];
const seenB = new Map();

const queueC = [];

// ===== health =====
app.get("/health", (req, res) => res.json({ ok: true, status: "ok" }));

// ===== A/B：汎用フォーマット受信（既存互換で残す） =====
const SEEN_TTL_MS = 5 * 60 * 1000;

function cleanupSeen(seenMap) {
  const now = Date.now();
  for (const [id, ts] of seenMap.entries()) {
    if (now - ts > SEEN_TTL_MS) seenMap.delete(id);
  }
}

function handleSignal(req, res, queue, seen) {
  if (!requireKey(req, res)) return;

  let { cmd, symbol, id } = req.body;
  if (!cmd || !symbol || !id) {
    return res.status(400).json({ error: "missing fields" });
  }

  cmd = normalizeCmd(cmd);
  symbol = normalizeSymbol(symbol);
  id = String(id);

  if (!cmd) return res.status(400).json({ error: "invalid cmd" });
  if (!symbol) return res.status(400).json({ error: "invalid symbol" });

  cleanupSeen(seen);
  if (seen.has(id)) return res.json({ ok: true, deduped: true });
  seen.set(id, Date.now());

  pushQueue(queue, { cmd, symbol, id, ts: Date.now() });
  return res.json({ ok: true, queued: true });
}

function handleLast(req, res, queue) {
  if (!requireKey(req, res)) return;
  if (queue.length === 0) return res.json({ signal: null });
  return res.json(queue.shift());
}

// A/B は JSON をルート単位で（curl/手動送信用）
const jsonParser = express.json({ strict: true, limit: "1mb" });

app.post("/signal/a", jsonParser, (req, res) => handleSignal(req, res, queueA, seenA));
app.get("/last/a", (req, res) => handleLast(req, res, queueA));

app.post("/signal/b", jsonParser, (req, res) => handleSignal(req, res, queueB, seenB));
app.get("/last/b", (req, res) => handleLast(req, res, queueB));


// =========================================================
// ===== A/B：Cと同じ “Plain運用” を追加（MacroDroid推奨）=====
// =========================================================

// ★短期デデュープ（同一通知の二重POSTだけ潰す）
const AB_DEDUP_MS = 2000;
const abRecent = new Map();

function abMakeDedupKey({ channel, who, room, cmd, symbol, text }) {
  // textは同一通知判定に少しだけ使う（長すぎないように先頭だけ）
  const t = String(text || "").replace(/\s+/g, " ").trim().slice(0, 120);
  return `${channel}|${who}|${room}|${cmd}|${symbol}|${t}`;
}

function abIsDuplicateAndMark(key) {
  const now = Date.now();
  const prev = abRecent.get(key) || 0;

  // 軽い掃除
  for (const [k, ts] of abRecent.entries()) {
    if (now - ts > AB_DEDUP_MS * 5) abRecent.delete(k);
  }

  if (now - prev < AB_DEDUP_MS) return true;
  abRecent.set(key, now);
  return false;
}

// A専用：文言でBUY/SELL判定
function detectDirectionA(text) {
  const t = String(text || "");
  // 仕様通り：固定フレーズに寄せる（誤反応防止）
  if (t.includes("ゴールドロングエントリー")) return "BUY";
  if (t.includes("ゴールドショートエントリー")) return "SELL";
  return "";
}

// B専用：文言でBUY/SELL判定
function detectDirectionB(text) {
  const t = String(text || "");
  // Allyのメッセージ例に寄せる（誤反応防止）
  if (t.includes("ゴールドロング") && (t.includes("成行買い") || t.includes("買い"))) return "BUY";
  if (t.includes("ゴールドショート") && (t.includes("成行売り") || t.includes("売り"))) return "SELL";
  return "";
}

function queueABSignal({ channel, room, who, text, symbol }) {
  symbol = normalizeSymbol(symbol || "GOLD");
  room = String(room || "");
  who = String(who || "");
  text = String(text || "");

  let cmd = "";
  if (channel === "A") cmd = detectDirectionA(text);
  if (channel === "B") cmd = detectDirectionB(text);

  if (!cmd) return { ok: true, ignored: "no_direction" };

  // キューへ
  const item = {
    cmd,
    symbol,
    id: safeId(channel),
    room,
    who,
    ts: Date.now()
  };

  const dkey = abMakeDedupKey({ channel, who, room, cmd, symbol, text });
  if (abIsDuplicateAndMark(dkey)) return { ok: true, deduped: true, reason: "short_window" };

  if (channel === "A") pushQueue(queueA, item);
  else pushQueue(queueB, item);

  return { ok: true, queued: true, size: channel === "A" ? queueA.length : queueB.length };
}

// ===== A：Plain（MacroDroid）=====
app.post("/signal/a_plain", (req, res) => {
  if (!requireKey(req, res)) return;

  const room = String(req.query.room || "");
  const who = String(req.query.who || "");
  const symbol = String(req.query.symbol || "GOLD");
  const text = typeof req.body === "string" ? req.body : "";

  if (!text) return res.status(400).json({ error: "missing body text" });

  // オプチャ名・管理人名チェック（安全に誤反応防止）
  // ※通知の表記ブレがあるなら、まずはコメントアウトして動作確認→必要なら緩める
  if (room && room !== "【FX】さくらサロンEA【裁量EA/自動売買】〈GOLD〉コピトレ") {
    return res.json({ ok: true, ignored: "room_mismatch", room });
  }
  if (who && who !== "春音さくら") {
    return res.json({ ok: true, ignored: "who_mismatch", who });
  }

  const out = queueABSignal({ channel: "A", room, who, text, symbol });
  return res.json(out);
});

// ===== B：Plain（MacroDroid）=====
app.post("/signal/b_plain", (req, res) => {
  if (!requireKey(req, res)) return;

  const room = String(req.query.room || "");
  const who = String(req.query.who || "");
  const symbol = String(req.query.symbol || "GOLD");
  const text = typeof req.body === "string" ? req.body : "";

  if (!text) return res.status(400).json({ error: "missing body text" });

  // オプチャ名・管理人名チェック（安全に誤反応防止）
  if (room && room !== "FX裁量EA配信") {
    return res.json({ ok: true, ignored: "room_mismatch", room });
  }
  if (who && who !== "Ally") {
    return res.json({ ok: true, ignored: "who_mismatch", who });
  }

  const out = queueABSignal({ channel: "B", room, who, text, symbol });
  return res.json(out);
});


// =====================
// ===== C（ここは維持）=====
// =====================
const DEBUG_C = true;
function cLog(...args) { if (DEBUG_C) console.log(...args); }

function extractNumber(text, patterns) {
  for (const re of patterns) {
    const m = String(text).match(re);
    if (m && m[1]) return Number(m[1]);
  }
  return null;
}

function detectDirection(text) {
  const t = String(text);
  const u = t.toUpperCase();

  const isLong  = t.includes("ロング") || u.includes("LONG") || u.includes("BUY")  || t.includes("買い");
  const isShort = t.includes("ショート") || u.includes("SHORT") || u.includes("SELL") || t.includes("売り");

  if (isLong && isShort) return "";
  if (!isLong && !isShort) return "";
  return isLong ? "BUY" : "SELL";
}

/**
 *  - ゆな：利確 ⇒ の値をTPにする
 *  - しおり：TP1 ⇒ の値をTPにする
 */
function parseEntrySlTpByWho(who, text) {
  const t = String(text);
  const arrow = "[:：⇒=>→]";

  if (who === "ゆな") {
    const entry = extractNumber(t, [new RegExp(`エントリー\\s*${arrow}\\s*([0-9.]+)`, "i")]);
    const sl    = extractNumber(t, [new RegExp(`損切\\s*${arrow}\\s*([0-9.]+)`, "i")]);
    const tp    = extractNumber(t, [new RegExp(`利確\\s*${arrow}\\s*([0-9.]+)`, "i")]);
    return { entry, sl, tp };
  }

  if (who === "しおり") {
    const entry = extractNumber(t, [new RegExp(`\\bEN\\s*${arrow}\\s*([0-9.]+)`, "i")]);
    const sl    = extractNumber(t, [new RegExp(`\\bSL\\s*${arrow}\\s*([0-9.]+)`, "i")]);
    const tp    = extractNumber(t, [new RegExp(`\\bTP1\\s*${arrow}\\s*([0-9.]+)`, "i")]);
    return { entry, sl, tp };
  }

  return { entry: null, sl: null, tp: null };
}

// ===== ★C 短期デデュープ =====
const C_DEDUP_MS = 2000;
const cRecent = new Map();

function makeDedupKey(item) {
  return `${item.who}|${item.cmd}|${item.symbol}|${item.entry}|${item.sl}|${item.tp ?? ""}`;
}

function isDuplicateAndMark(key) {
  const now = Date.now();
  const prev = cRecent.get(key) || 0;

  for (const [k, ts] of cRecent.entries()) {
    if (now - ts > C_DEDUP_MS * 5) cRecent.delete(k);
  }

  if (now - prev < C_DEDUP_MS) return true;
  cRecent.set(key, now);
  return false;
}

function queueCSignal({ room, who, text, symbol, id }) {
  symbol = normalizeSymbol(symbol || "GOLD");
  if (!id) id = "C-" + Date.now() + "-" + Math.random();

  const cmd = detectDirection(text);
  if (!cmd) return { ok: true, ignored: "no_direction" };

  if (who !== "ゆな" && who !== "しおり") {
    return { ok: true, ignored: "who_not_allowed" };
  }

  const { entry, sl, tp } = parseEntrySlTpByWho(who, text);
  if (!entry || !sl || !tp) return { ok: false, error: "parse_failed" };

  const item = { cmd, symbol, id, entry, sl, tp, n: 3, who, room, ts: Date.now() };

  const dkey = makeDedupKey(item);
  if (isDuplicateAndMark(dkey)) {
    cLog("[C] dedup_short", dkey);
    return { ok: true, deduped: true };
  }

  pushQueue(queueC, item);
  cLog("[C] queued", item);
  return { ok: true, queued: true };
}

// ===== C：JSON（curl用） =====
app.post("/signal/c", jsonParser, (req, res) => {
  if (!requireKey(req, res)) return;
  const out = queueCSignal(req.body);
  return res.json(out);
});

// ===== C：Plain（MacroDroid用） =====
app.post("/signal/c_plain", (req, res) => {
  if (!requireKey(req, res)) return;

  const out = queueCSignal({
    who: req.query.who,
    room: req.query.room,
    symbol: req.query.symbol,
    id: req.query.id,
    text: typeof req.body === "string" ? req.body : ""
  });

  return res.json(out);
});

app.get("/last/c", (req, res) => handleLast(req, res, queueC));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server running on port", port));
