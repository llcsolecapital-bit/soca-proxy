const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const POLYGON_KEY = process.env.POLYGON_KEY;
const FINNHUB_KEY = process.env.FINNHUB_KEY;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    status: 'SOCA Proxy running',
    polygon: POLYGON_KEY ? 'configured' : 'missing',
    finnhub: FINNHUB_KEY ? 'configured' : 'missing'
  });
});

// Batch quotes via Finnhub — fetches all symbols in parallel server-side
// No browser rate limit issues, returns all in ~2-3 seconds
app.get('/quote/:symbols', async (req, res) => {
  if (!FINNHUB_KEY) return res.status(500).json({ error: 'FINNHUB_KEY not set on Railway' });
  try {
    const syms = [...new Set(req.params.symbols.toUpperCase().split(','))];

    // Fetch all in parallel — server has no CORS restriction
    const results = await Promise.all(
      syms.map(async sym => {
        try {
          const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB_KEY}`);
          const q = await r.json();
          if (!q.c || q.c === 0) return null;
          return {
            ticker: sym,
            lastTrade: { p: q.c },
            day: { o: q.o, h: q.h, l: q.l, c: q.c, v: 0 },
            prevDay: { c: q.pc },
            finnhub: q  // includes d (change $), dp (change %), pc (prev close)
          };
        } catch(e) { return null; }
      })
    );

    res.json({ tickers: results.filter(Boolean) });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Candles via Polygon (still free for historical bars)
app.get('/candles/:sym/:mult/:span/:from/:to', async (req, res) => {
  if (!POLYGON_KEY) return res.status(500).json({ error: 'POLYGON_KEY not set' });
  try {
    const { sym, mult, span, from, to } = req.params;
    const url = `https://api.polygon.io/v2/aggs/ticker/${sym}/range/${mult}/${span}/${from}/${to}?adjusted=true&sort=asc&limit=1000&apiKey=${POLYGON_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Debug
app.get('/debug/:sym', async (req, res) => {
  if (!FINNHUB_KEY) return res.status(500).json({ error: 'FINNHUB_KEY not set' });
  try {
    const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${req.params.sym.toUpperCase()}&token=${FINNHUB_KEY}`);
    const q = await r.json();
    res.json({ sym: req.params.sym.toUpperCase(), data: q });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`SOCA Proxy listening on port ${PORT}`));
