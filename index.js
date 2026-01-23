import express from "express";

const app = express();

// ★ここが重要：
// 1) JSONは「application/json」のときだけ読む（MacroDroidは後で text/plain にする）
// 2) text/plain を受け取れるようにする（改行OK）
app.use(express.json({ strict: true, limit: "1mb" }));
app.use(express.text({ type: "text/plain", limit: "1mb" }));

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
const queueB = [];
const seenB = new Map();

// ===== Queue C =====
const queueC = [];

// ===== health =====
app.get("/health", (req, res) => res.json({ ok: true, status: "ok" }));

// ===== A/B：汎用フォーマット受信（なるべく変更しない） =====
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


// ===== C：パース共通 =====
const DEBUG_C = true;
function cLog(...args) { if (DEBUG_C) console.log(...args); }

function extractNumber(text, patterns) {
  for (const re of patterns) {
    const m = String(text || "").match(re);
    if (m && m[1]) return Number(m[1]);
  }
  return null;
}

function detectDirection(text) {
  const t = String(text || "");
  const u = t.toUpperCase();

  const isLong =
    t.includes("ロング") ||
    u.includes("GOLD LONG") ||
    u.includes("LONG") ||
    u.includes("BUY") ||
    t.includes("買い");

  const isShort =
    t.includes("ショート") ||
    u.includes("GOLD SHORT") ||
    u.includes("SHORT") ||
    u.includes("SELL") ||
    t.includes("売り");

  if (isLong && isShort) return "";
  if (!isLong && !isShort) return "";
  return isLong ? "BUY" : "SELL";
}

function parseEntrySlByWho(who, text) {
  const t = String(text || "");
  const arrow = "[:：⇒=>→]";

  if (who === "ゆな") {
    const entry = extractNumber(t, [
      new RegExp(`エントリー\\s*${arrow}\\s*([0-9]+(?:\\.[0-9]+)?)`, "i")
    ]);
    const sl = extractNumber(t, [
      new RegExp(`損切\\s*${arrow}\\s*([0-9]+(?:\\.[0-9]+)?)`, "i")
    ]);
    return { entry, sl };
  }

  if (who === "しおり") {
    const entry = extractNumber(t, [
      new RegExp(`\\bEN\\s*${arrow}\\s*([0-9]+(?:\\.[0-9]+)?)`, "i")
    ]);
    const sl = extractNumber(t, [
      new RegExp(`\\bSL\\s*${arrow}\\s*([0-9]+(?:\\.[0-9]+)?)`, "i")
    ]);
    return { entry, sl };
  }

  return { entry: null, sl: null };
}

function queueCSignal({ room, who, text, symbol, id }) {
  symbol = normalizeSymbol(symbol || "GOLD");
  id = String(id || "");
  if (!id) id = "C-" + Date.now() + "-" + Math.floor(Math.random() * 1e9);

  const cmd = detectDirection(text);
  if (!cmd) return { ok: true, ignored: "no_direction" };

  if (who !== "ゆな" && who !== "しおり") {
    return { ok: true, ignored: "who_not_allowed", who };
  }

  const { entry, sl } = parseEntrySlByWho(who, text);
  if (entry == null || sl == null || Number.isNaN(entry) || Number.isNaN(sl)) {
    return { ok: false, error: "parse_failed", need: ["entry", "sl"], who };
  }

  const item = {
    cmd,
    symbol,
    id,
    entry,
    sl,
    n: 3,
    who,
    room: String(room || ""),
    ts: Date.now()
  };

  pushQueue(queueC, item);
  cLog("[C] queued", item);
  return { ok: true, queued: true, size: queueC.length };
}

// ===== C：JSON版（curl等で使う） =====
app.post("/signal/c", (req, res) => {
  if (!requireKey(req, res)) return;

  const room = String(req.body?.room || "");
  const who  = String(req.body?.who  || req.body?.admin || ""); // adminでも受ける
  const text = String(req.body?.text || "");
  const symbol = req.body?.symbol || "GOLD";
  const id = req.body?.id || "";

  if (!text) return res.status(400).json({ error: "missing text" });

  const out = queueCSignal({ room, who, text, symbol, id });
  if (out.ok === false && out.error === "parse_failed") return res.status(400).json(out);
  return res.json(out);
});

// ===== C：Plain版（MacroDroid推奨：改行OK） =====
// URL例：/signal/c_plain?key=...&who=しおり&room=...&symbol=GOLD&id=...
app.post("/signal/c_plain", (req, res) => {
  if (!requireKey(req, res)) return;

  const who = String(req.query.who || "");      // ★ここで指定
  const room = String(req.query.room || "");
  const symbol = String(req.query.symbol || "GOLD");
  const id = String(req.query.id || "");

  // Body は text/plain の生本文（改行OK）
  const text = typeof req.body === "string" ? req.body : "";

  if (!text) return res.status(400).json({ error: "missing body text" });

  const out = queueCSignal({ room, who, text, symbol, id });
  if (out.ok === false && out.error === "parse_failed") return res.status(400).json(out);
  return res.json(out);
});

// 互換：旧 /signal/c_raw も /signal/c と同じ処理に流す（残してOK）
app.post("/signal/c_raw", (req, res) => {
  req.url = "/signal/c" + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "");
  return app._router.handle(req, res, () => {});
});

app.get("/last/c", (req, res) => handleLast(req, res, queueC));


// ★ JSONパースエラーを握って、ログだけ出して400返す（落ちないように）
app.use((err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") {
    console.log("[JSON_PARSE_ERROR]", err.message);
    return res.status(400).json({ error: "invalid_json", message: err.message });
  }
  return next(err);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server running on port", port));
