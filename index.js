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

// ===== Queue A/B =====
const queueA = [];
const seenA = new Map();
const queueB = new Map(); // ←（※元コードだと配列だったので戻す）
const queueB_arr = [];    // 互換：queueBを配列として使う
const seenB = new Map();

// ===== Queue C =====
const queueC = [];

// ===== health =====
app.get("/health", (req, res) => res.json({ ok: true, status: "ok" }));

// ===== A/B：汎用フォーマット受信 =====
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

// A/B は JSON をルート単位で
const jsonParser = express.json({ strict: true, limit: "1mb" });

app.post("/signal/a", jsonParser, (req, res) => handleSignal(req, res, queueA, seenA));
app.get("/last/a", (req, res) => handleLast(req, res, queueA));

// ★ここは元の通り queueB_arr を使う（最小変更）
app.post("/signal/b", jsonParser, (req, res) => handleSignal(req, res, queueB_arr, seenB));
app.get("/last/b", (req, res) => handleLast(req, res, queueB_arr));


// ===== C 共通 =====
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
 * ★修正：ゆな/しおり別に entry/sl に加えて tp を抽出する
 *  - ゆな：利確 ⇒ の値をTPにする
 *  - しおり：TP1 ⇒ の値をTPにする
 */
function parseEntrySlTpByWho(who, text) {
  const t = String(text);
  const arrow = "[:：⇒=>→]";

  if (who === "ゆな") {
    const entry = extractNumber(t, [new RegExp(`エントリー\\s*${arrow}\\s*([0-9.]+)`, "i")]);
    const sl    = extractNumber(t, [new RegExp(`損切\\s*${arrow}\\s*([0-9.]+)`, "i")]);

    // 「利確           ⇒5045.5」みたいに空白が多いのも拾う
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
  // ★修正：tp も含める（TP違いで誤デデュープしない）
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

  // ★修正：TPも抽出
  const { entry, sl, tp } = parseEntrySlTpByWho(who, text);
  if (!entry || !sl || !tp) return { ok: false, error: "parse_failed" };

  // ★修正：itemに tp を追加
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
