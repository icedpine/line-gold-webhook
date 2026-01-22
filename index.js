import express from "express";

const app = express();
app.use(express.json());

const SECRET_KEY = process.env.SECRET_KEY;

// ★変更点：lastSignal → queue
const queue = [];                 // FIFO
const MAX_QUEUE = 200;            // 念のため上限（多すぎると危険）
const seen = new Map();           // id重複防止（簡易）
const SEEN_TTL_MS = 5 * 60 * 1000; // 5分だけ記憶

function cleanupSeen() {
  const now = Date.now();
  for (const [id, ts] of seen.entries()) {
    if (now - ts > SEEN_TTL_MS) seen.delete(id);
  }
}

// health check
app.get("/health", (req, res) => {
  res.json({ ok: true, status: "ok" });
});

// receive signal
app.post("/signal", (req, res) => {
  const key = req.query.key;
  if (key !== SECRET_KEY) {
    return res.status(403).json({ error: "invalid key" });
  }

  let { cmd, symbol, id } = req.body;

  // 必須チェック（最低限）
  if (!cmd || !symbol || !id) {
    return res.status(400).json({
      error: "missing fields",
      required: ["cmd", "symbol", "id"],
      received: req.body
    });
  }

  // 正規化
  cmd = String(cmd).toUpperCase();
  symbol = String(symbol).toUpperCase();
  id = String(id);

  if (cmd !== "BUY" && cmd !== "SELL") {
    return res.status(400).json({ error: "invalid cmd" });
  }

  // symbol 正規化（安心設計）
  if (symbol === "XAUUSD" || symbol === "XAUUSD#" || symbol === "XAU/USD" || symbol === "GOLD") {
    symbol = "GOLD";
  }

  // ★重複排除（同一idが2回来たら無視）
  cleanupSeen();
  if (seen.has(id)) {
    return res.json({ ok: true, deduped: true });
  }
  seen.set(id, Date.now());

  // ★キューに積む（取りこぼし防止）
  queue.push({
    cmd,
    symbol,
    id,
    ts: Date.now()
  });

  // 上限を超えたら古いものを捨てる（安全弁）
  while (queue.length > MAX_QUEUE) queue.shift();

  res.json({ ok: true, queued: true, size: queue.length });
});

// fetch next signal (FIFO)
app.get("/last", (req, res) => {
  const key = req.query.key;
  if (key !== SECRET_KEY) {
    return res.status(403).json({ error: "invalid key" });
  }

  if (queue.length === 0) {
    return res.json({ signal: null });
  }

  const s = queue.shift(); // ★1回取得したら消す（FIFO）
  res.json(s);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server running on port", port);
});
