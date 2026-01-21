import express from "express";

const app = express();
app.use(express.json());

const SECRET_KEY = process.env.SECRET_KEY || "CHANGE_ME";
let lastSignal = null;

function asNumber(v) {
  // "0.01" みたいな文字列でもOKにする
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

// health check
app.get("/health", (req, res) => {
  res.json({ ok: true, status: "ok" });
});

// receive signal (PROD FORMAT)
app.post("/signal", (req, res) => {
  const key = req.query.key;
  if (key !== SECRET_KEY) {
    return res.status(403).json({ error: "invalid key" });
  }

  // required
  const cmd = typeof req.body.cmd === "string" ? req.body.cmd.toUpperCase() : "";
  const symbol = req.body.symbol;
  const lots = asNumber(req.body.lots);

  const missing = [];
  if (!["BUY", "SELL"].includes(cmd)) missing.push("cmd(BUY/SELL)");
  if (!isNonEmptyString(symbol)) missing.push("symbol");
  if (!(lots > 0)) missing.push("lots(>0)");

  if (missing.length) {
    return res.status(400).json({
      error: "missing fields",
      missing,
      received: req.body,
    });
  }

  // optional
  const tp_pips = asNumber(req.body.tp_pips ?? 0);
  const sl_pips = asNumber(req.body.sl_pips ?? 0);
  const magic = asNumber(req.body.magic ?? 0);
  const comment = isNonEmptyString(req.body.comment) ? req.body.comment : "";
  const id = isNonEmptyString(req.body.id) ? req.body.id : "";

  lastSignal = {
    cmd,
    symbol: String(symbol).trim(),
    lots,
    tp_pips: Number.isFinite(tp_pips) ? tp_pips : 0,
    sl_pips: Number.isFinite(sl_pips) ? sl_pips : 0,
    magic: Number.isFinite(magic) ? magic : 0,
    comment,
    id,
    ts: Date.now(), // いつ入ったか
  };

  return res.json({ ok: true, stored: lastSignal });
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

// RenderはPORT必須
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server running on port", port);
});
