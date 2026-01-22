import express from "express";

const app = express();
app.use(express.json());

const SECRET_KEY = process.env.SECRET_KEY;

// ===== 共通設定 =====
const MAX_QUEUE = 200;
const SEEN_TTL_MS = 5 * 60 * 1000;

function cleanupSeen(seenMap) {
  const now = Date.now();
  for (const [id, ts] of seenMap.entries()) {
    if (now - ts > SEEN_TTL_MS) seenMap.delete(id);
  }
}

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
const queueB = [];
const seenB = new Map();

// ===== Queue C =====
const queueC = [];
const seenC = new Map();

// ===== health =====
app.get("/health", (req, res) => res.json({ ok: true, status: "ok" }));

// ===== A/B：汎用フォーマット受信 =====
function handleSignal(req, res, queue, seen) {
  if (!requireKey(req, res)) return;

  let { cmd, symbol, id } = req.body;
  if (!cmd || !symbol || !id) {
    return res.status(400).json({
      error: "missing fields",
      required: ["cmd", "symbol", "id"],
      received: req.body
    });
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
  return res.json({ ok: true, queued: true, size: queue.length });
}

function handleLast(req, res, queue) {
  if (!requireKey(req, res)) return;
  if (queue.length === 0) return res.json({ signal: null });
  return res.json(queue.shift());
}

app.post("/signal/a", (req, res) => handleSignal(req, res, queueA, seenA));
app.get("/last/a", (req, res) => handleLast(req, res, queueA));

app.post("/signal/b", (req, res) => handleSignal(req, res, queueB, seenB));
app.get("/last/b", (req, res) => handleLast(req, res, queueB));

// ===== C：raw本文を受け取り、entry/slを抽出してqueueCへ積む =====
// MacroDroidから送るJSON例：
// { "room":"ゆなのエントリー共有のへや", "admin":"ゆな", "text":"...全文...", "id":"..." }
function extractNumber(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) return Number(m[1]);
  }
  return null;
}

function extractLots(text) {
  const m = text.match(/([0-9]+(?:\.[0-9]+)?)\s*ロット/i);
  if (m && m[1]) return Number(m[1]);
  return null;
}

app.post("/signal/c_raw", (req, res) => {
  if (!requireKey(req, res)) return;

  let { room, admin, text, id, symbol } = req.body;
  room = String(room || "");
  admin = String(admin || "");
  text = String(text || "");
  id = String(id || "");
  symbol = normalizeSymbol(symbol || "GOLD");

  if (!id || !text) {
    return res.status(400).json({ error: "missing fields", required: ["id", "text"] });
  }

  // オプチャ名で縛りたい場合（任意）
  // ここで一致しなければ捨てる（誤爆防止）
  if (room && room !== "ゆなのエントリー共有のへや") {
    return res.json({ ok: true, ignored: "room_mismatch" });
  }

  // ロング/ショート判定（本文に "ロング"/"ショート" が含まれた時点でOK）
  const isLong = /ロング/i.test(text);
  const isShort = /ショート/i.test(text);
  if (!isLong && !isShort) {
    return res.json({ ok: true, ignored: "no_direction" });
  }
  const cmd = isLong ? "BUY" : "SELL";

  // 管理人判定：adminが入っていればそれを使う。無ければ本文から推測も可
  const who = admin || (text.includes("ゆな") ? "ゆな" : (text.includes("しおり") ? "しおり" : "unknown"));

  // 抽出ルール（ゆな / しおり）
  // ゆな：エントリー⇒xxxx / 損切⇒xxxx
  // しおり：EN⇒xxxx / SL⇒xxxx
  const entry = extractNumber(text, [
    /エントリー\s*[⇒=>]\s*([0-9]+(?:\.[0-9]+)?)/i,
    /\bEN\s*[⇒=>]\s*([0-9]+(?:\.[0-9]+)?)/i
  ]);

  const sl = extractNumber(text, [
    /損切\s*[⇒=>]\s*([0-9]+(?:\.[0-9]+)?)/i,
    /\bSL\s*[⇒=>]\s*([0-9]+(?:\.[0-9]+)?)/i
  ]);

  if (entry == null || sl == null) {
    return res.status(400).json({
      error: "parse_failed",
      need: ["entry", "sl"],
      who,
      received_text: text
    });
  }

  // ロット（本文にあれば拾う。無ければEA側のLotsを使う想定）
  const lots = extractLots(text); // nullでもOK

  // 3ポジ固定（要件）
  const n = 3;

  cleanupSeen(seenC);
  if (seenC.has(id)) return res.json({ ok: true, deduped: true });
  seenC.set(id, Date.now());

  pushQueue(queueC, {
    cmd,
    symbol: symbol || "GOLD",
    id,
    entry,
    sl,
    n,
    lots,     // nullならEA側のLotsを使う
    who,
    ts: Date.now()
  });

  return res.json({ ok: true, queued: true, size: queueC.length });
});

app.get("/last/c", (req, res) => handleLast(req, res, queueC));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server running on port", port));
