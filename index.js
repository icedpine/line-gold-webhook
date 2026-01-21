import express from "express";

const app = express();
app.use(express.json());

const SECRET_KEY = process.env.SECRET_KEY || "CHANGE_ME";
let lastSignal = null;

// ---- helpers ----
function normalizeSymbol(symbol) {
  const s = String(symbol ?? "").trim().toUpperCase();

  // Anything that should be treated as GOLD (XAUUSD etc.)
  const goldAliases = new Set(["GOLD", "XAUUSD", "XAU"]);

  if (goldAliases.has(s)) return "GOLD";
  return s; // keep as-is for other symbols (optional)
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

  const { cmd, symbol, id } = req.body;

  // normalize
  const normalizedCmd = String(cmd ?? "").trim().toUpperCase();
  const normalizedSymbol = normalizeSymbol(symbol);

  // validate
  if (!normalizedCmd || !normalizedSymbol || !id) {
    return res.status(400).json({ error: "missing fields" });
  }

  if (normalizedCmd !== "BUY" && normalizedCmd !== "SELL") {
    return res.status(400).json({ error: "invalid cmd" });
  }

  // (Optional) If you ONLY want GOLD, uncomment this:
  // if (normalizedSymbol !== "GOLD") {
  //   return res.status(400).json({ error: "symbol must be GOLD" });
  // }

  lastSignal = {
    cmd: normalizedCmd,
    symbol: normalizedSymbol,
    id: String(id),
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
  lastSignal = null;
  res.json(s);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server running on port", port);
});
