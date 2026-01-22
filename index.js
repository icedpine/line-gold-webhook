import express from "express";

const app = express();
app.use(express.json());

const SECRET_KEY = process.env.SECRET_KEY;

// ===== 共通設定 =====
const MAX_QUEUE = 200;                 // 上限
const SEEN_TTL_MS = 5 * 60 * 1000;     // 5分だけ重複記憶

function cleanupSeen(seenMap) {
  const now = Date.now();
  for (const [id, ts] of seenMap.entries()) {
    if (now - ts > SEEN_TTL_MS) seenMap.delete(id);
  }
}

function normalizeCmd(cmd) {
  const c = String(cmd || "").trim().toUpperCase();
  return (c === "BUY" || c === "SELL") ? c : "";
}

function normalizeSymbol(symbol) {
  let s = String(symbol || "").trim().toUpperCase();
  // よくある表記ゆれをGOLDに寄せる
  if (s === "XAUUSD" || s === "XAUUSD#" || s === "XAU/USD" || s === "GOLD") s = "GOLD";
  return s;
}

function requireKey(req, res) {
  const key = req.query.key;
  if (key !== SECRET_KEY) {
    res.status(403).json({ error: "invalid key" });
    return false;
  }
  return true;
}

// ===== Queue A/B =====
const queueA = [];
const seenA  = new Map();

const queueB = [];
const seenB  = new Map();

// ===== health =====
app.get("/health", (req, res) => {
  res.json({ ok: true, status: "ok" });
});

// ===== 共通：signal handler =====
function handleSignal(req, res, queue, seen) {
  if (!requireKey(req, res)) return;

  let { cmd, symbol, id } = req.body;

  // 必須チェック
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

  // 重複排除
  cleanupSeen(seen);
  if (seen.has(id)) {
    return res.json({ ok: true, deduped: true });
  }
  seen.set(id, Date.now());

  // キューに積む
  queue.push({ cmd, symbol, id, ts: Date.now() });

  // 上限超えは古いのを捨てる
  while (queue.length > MAX_QUEUE) queue.shift();

  return res.json({ ok: true, queued: true, size: queue.length });
}

// ===== 共通：last handler =====
function handleLast(req, res, queue) {
  if (!requireKey(req, res)) return;

  if (queue.length === 0) {
    return res.json({ signal: null });
  }
  const s = queue.shift(); // FIFOで1件pop
  return res.json(s);
}

// ===== A routes =====
app.post("/signal/a", (req, res) => handleSignal(req, res, queueA, seenA));
app.get("/last/a", (req, res) => handleLast(req, res, queueA));

// ===== B routes =====
app.post("/signal/b", (req, res) => handleSignal(req, res, queueB, seenB));
app.get("/last/b", (req, res) => handleLast(req, res, queueB));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server running on port", port);
});
