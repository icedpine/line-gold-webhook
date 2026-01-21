import express from "express";

const app = express();
app.use(express.json());

const SECRET_KEY = process.env.SECRET_KEY;
let lastSignal = null;

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

  if (cmd !== "BUY" && cmd !== "SELL") {
    return res.status(400).json({ error: "invalid cmd" });
  }

  // symbol 正規化（安心設計）
  if (symbol === "XAUUSD" || symbol === "XAUUSD#" || symbol === "GOLD") {
    symbol = "GOLD";
  }

  lastSignal = {
    cmd,
    symbol,
    id,
    ts: Date.now()
  };

  res.json({ ok: true });
});

// fetch last signal
app.get("/last", (req, res) => {
  const key = req.query.key;
  if (key !== SECRET_KEY) {
    return res.status(403).json({ error: "invalid key" });
  }

  if (!lastSignal) {
    return res.json({ signal: null });
  }

  const s = lastSignal;
  lastSignal = null; // 1回取得したら消す
  res.json(s);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server running on port", port);
});
