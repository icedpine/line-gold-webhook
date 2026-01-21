import express from "express";

const app = express();
app.use(express.json());

const SECRET_KEY = process.env.SECRET_KEY || "CHANGE_ME";

// ====== Queue settings ======
const MAX_QUEUE = Number(process.env.MAX_QUEUE || 50); // 溜める上限（任意）
const DEDUPE_TTL_MS = Number(process.env.DEDUPE_TTL_MS || 5 * 60 * 1000); // id重複防止(5分)

// FIFO queue
let queue = [];

// id dedupe (in-memory)
const seen = new Map(); // id -> timestamp(ms)
function gcSeen(now) {
  for (const [id, ts] of seen.entries()) {
    if (now - ts > DEDUPE_TTL_MS) seen.delete(id);
  }
}

// ---- helpers ----
function normalizeCmd(cmd) {
  const c = String(cmd || "").trim().toUpperCase();
  if (c !== "BUY" && c !== "SELL") return null;
  return c;
}

function normalizeSymbol(symbol) {
  const s = String(symbol || "").trim().toUpperCase();
  // ここで全部GOLDに寄せる（あなたの運用方針）
  if (s === "GOLD" || s === "XAUUSD" || s === "XAU/USD" || s === "XAUUSD#") return "GOLD";
  // それ以外はそのまま（必要ならここで弾く）
  return s;
}

function auth(req, res) {
  const key = req.query.key;
  if (!key || key !== SECRET_KEY) {
    res.status(403).json({ error: "invalid key" });
    return false;
  }
  return true;
}

// ====== routes ======
app.get("/health", (req, res) => {
  res.json({ ok: true, status: "ok" });
});

// push signal into queue
app.post("/signal", (req, res) => {
  if (!auth(req, res)) return;

  const { cmd, symbol, id } = req.body || {};

  const ncmd = normalizeCmd(cmd);
  const nsym = normalizeSymbol(symbol);
  const nid = String(id || "").trim();

  if (!ncmd || !nsym || !nid) {
    return res.status(400).json({
      error: "missing/invalid fields",
      required: ["cmd(BUY/SELL)", "symbol", "id"],
    });
  }

  const now = Date.now();
  gcSeen(now);

  // 重複IDは受け付けない（MacroDroidが誤爆連投しても安全）
  if (seen.has(nid)) {
    return res.json({ ok: true, deduped: true });
  }
  seen.set(nid, now);

  const item = { cmd: ncmd, symbol: nsym, id: nid, ts: now };

  // queue上限：古いのを落とす（安全策）
  if (queue.length >= MAX_QUEUE) {
    queue.shift();
  }
  queue.push(item);

  res.json({ ok: true, queued: true, size: queue.length, stored: { id: item.id, cmd: item.cmd, symbol: item.symbol } });
});

// pop one signal from queue (FIFO)
app.get("/last", (req, res) => {
  if (!auth(req, res)) return;

  if (queue.length === 0) {
    return res.json({ signal: null });
  }

  const item = queue.shift();
  res.json(item);
});

// (任意) 現在のキュー長確認：運用時の監視用（不要なら消してOK）
app.get("/queue_len", (req, res) => {
  if (!auth(req, res)) return;
  res.json({ ok: true, size: queue.length });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server running on port", port);
});
