import express from "express";

const app = express();
app.use(express.json());

const SECRET_KEY = process.env.SECRET_KEY || "CHANGE_ME";
let lastSignal = null;

// --- helpers ---
const normalizeCmd = (cmd) => {
  if (!cmd) return null;
  const c = String(cmd).trim().toUpperCase();
  if (["BUY", "SELL", "CLOSE", "CLOSEALL"].includes(c)) return c;
  return null;
};

const normalizeSymbolToGold = (symbol) => {
  if (!symbol) return "GOLD";
  const s = String(symbol).trim().toUpperCase();

  // GOLDとして扱いたい入力をまとめてGOLDにする
  if (
    s === "GOLD" ||
    s === "XAUUSD" ||
    s === "XAU/USD" ||
    s === "GOLDUSD" ||
    s.includes("XAU")
  ) {
    return "GOLD";
  }

  // それ以外は一旦そのまま返す（必要ならここで弾いてもOK）
  return s;
};

const toNumber = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const toInt = (v) => {
  const n = toNumber(v);
  return n === null ? null : Math.trunc(n);
};

// health check
app.get("/health", (req, res) => {
  res.json({ ok: true, status: "ok" });
});

// receive signal (production format)
app.post("/signal", (req, res) => {
  const key = req.query.key;
  if (key !== SECRET_KEY) {
    return res.status(403).json({ error: "invalid key" });
  }

  // body (expected)
  // {
  //   cmd: "BUY"|"SELL",
  //   symbol: "xauusd"|"GOLD"|...,
  //   lots: 0.01,
  //   tp_pips: 300,
  //   sl_pips: 200,
  //   magic: 777,
  //   comment: "test",
  //   id: "unique-string"
  // }

  const cmd = normalizeCmd(req.body?.cmd);
  const symbol = normalizeSymbolToGold(req.body?.symbol);
  const lots = toNumber(req.body?.lots);
  const tp_pips = toInt(req.body?.tp_pips ?? 0);
  const sl_pips = toInt(req.body?.sl_pips ?? 0);
  const magic = toInt(req.body?.magic ?? 0);
  const comment = req.body?.comment ? String(req.body.comment) : "";
  const id = req.body?.id ? String(req.body.id) : null;

  // required
  const missing = [];
  if (!cmd) missing.push("cmd");
  if (!symbol) missing.push("symbol");
  if (!id) missing.push("id");
  if (lots === null || lots <= 0) missing.push("lots");

  if (missing.length) {
    return res.status(400).json({
      error: "missing fields",
      missing,
      received: req.body,
    });
  }

  // store FULL payload
  lastSignal = {
    cmd,
    symbol, // normalized to GOLD
    lots,
    tp_pips,
    sl_pips,
    magic,
    comment,
    id,
    ts: Date.now(), // 任意：受信時刻
  };

  res.json({ ok: true, stored: { id, cmd, symbol } });
});

// fetch last signal (one-time)
app.get("/last", (req, res) => {
  const key = req.query.key;
  if (key !== SECRET_KEY) {
    return res.status(403).json({ error: "invalid key" });
  }

  if (!lastSignal) {
    return res.json({ signal: null });
  }

  const s = lastSignal;
  lastSignal = null;

  // return FULL payload
  return res.json(s);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server running on port", port);
});
