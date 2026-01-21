import express from "express";

const app = express();
app.use(express.json());

const SECRET_KEY = process.env.SECRET_KEY || "CHANGE_ME";
let lastSignal = null;

// --- helpers ---
function normalizeSymbol(symbol) {
  const s = String(symbol ?? "").trim().toUpperCase();
  const goldAliases = new Set(["GOLD", "XAUUSD", "XAU"]);
  if (goldAliases.has(s)) return "GOLD";
  return s;
}

function normalizeCmd(cmd) {
  const s = String(cmd ?? "").trim().toUpperCase();
  if (s === "BUY" || s === "SELL") return s;
  return "";
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

  // Accept only these fields (others are ignored)
  const {
    cmd,
    symbol,
    id,
    lots,
    tp_pips = 0,
    sl_pips = 0,
    magic = 0,
    comment = "",
  } = req.body ?? {};

  const normalizedCmd = normalizeCmd(cmd);
  const normalizedSymbol = normalizeSymbol(symbol);

  // Required: cmd, symbol, id, lots
  const missing = [];
  if (!normalizedCmd) missing.push("cmd");
  if (!normalizedSymbol) missing.push("symbol");
  if (!id) missing.push("id");
  if (lots === undefined || lots === null || lots === "") missing.push("lots");

  if (missing.length) {
    return res.status(400).json({
      error: "missing fields",
      missing,
      received: req.body ?? null,
    });
  }

  // numeric safety
  const lotsNum = Number(lots);
  const tpNum = Number(tp_pips);
  const slNum = Number(sl_pips);
  const magicNum = Number(magic);

  if (!Number.isFinite(lotsNum) || lotsNum <= 0) {
    return res.status(400).json({ error: "invalid lots" });
  }

  lastSignal = {
    cmd: normalizedCmd,
    symbol: normalizedSymbol, // => "GOLD"
    lots: lotsNum,
    tp_pips: Number.isFinite(tpNum) ? tpNum : 0,
    sl_pips: Number.isFinite(slNum) ? slNum : 0,
    magic: Number.isFinite(magicNum) ? magicNum : 0,
    comment: String(comment ?? ""),
    id: String(id),
    ts: Date.now(),
  };

  res.json({ ok: true });
});

// fetch last signal (one-time)
app.get("/last", (req, res) => {
  const key = req.query.key;
  if (key !== SECRET_KEY) {
    return res.status(403).json({ error: "invalid key" });
  }

  if (!lastSignal) return res.json({ signal: null });

  const s = lastSignal;
  lastSignal = null; // consume
  res.json(s);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server running on port", port);
});
