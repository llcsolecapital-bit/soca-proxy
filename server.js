const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const POLYGON_KEY = process.env.POLYGON_KEY;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'SOCA Proxy running', polygon: POLYGON_KEY ? 'configured' : 'missing key' });
});

// Get latest price using previous close + today's bars (free tier compatible)
app.get('/quote/:symbols', async (req, res) => {
  if (!POLYGON_KEY) return res.status(500).json({ error: 'POLYGON_KEY not set' });
  const syms = req.params.symbols.toUpperCase().split(',');
  const results = [];
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  // Go back up to 5 days to handle weekends/holidays
  const fromDate = new Date(today);
  fromDate.setDate(fromDate.getDate() - 5);
  const fromStr = fromDate.toISOString().split('T')[0];

  for (const sym of syms) {
    try {
      // Get recent daily bars — gives us prev close, today open, current close
      const url = `https://api.polygon.io/v2/aggs/ticker/${sym}/range/1/day/${fromStr}/${todayStr}?adjusted=true&sort=asc&limit=5&apiKey=${POLYGON_KEY}`;
      const r = await fetch(url);
      const d = await r.json();
      if (d.results && d.results.length > 0) {
        const bars = d.results;
        const latest = bars[bars.length - 1];
        const prevBar = bars.length > 1 ? bars[bars.length - 2] : null;
        results.push({
          ticker: sym,
          // Use today's close as current price, fall back to open
          lastTrade: { p: latest.c },
          day: {
            o: latest.o,
            h: latest.h,
            l: latest.l,
            c: latest.c,
            v: latest.v,
            vw: latest.vw
          },
          prevDay: prevBar ? {
            c: prevBar.c,
            o: prevBar.o,
            h: prevBar.h,
            l: prevBar.l,
            v: prevBar.v
          } : { c: latest.o }
        });
      }
    } catch (e) {
      console.error(`Error fetching ${sym}:`, e.message);
    }
    // Small delay to respect rate limits
    await new Promise(r => setTimeout(r, 120));
  }
  res.json({ tickers: results });
});

// Candles / aggregates — free tier compatible
app.get('/candles/:sym/:mult/:span/:from/:to', async (req, res) => {
  if (!POLYGON_KEY) return res.status(500).json({ error: 'POLYGON_KEY not set' });
  try {
    const { sym, mult, span, from, to } = req.params;
    const url = `https://api.polygon.io/v2/aggs/ticker/${sym}/range/${mult}/${span}/${from}/${to}?adjusted=true&sort=asc&limit=1000&apiKey=${POLYGON_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Debug — raw daily bars for a ticker
app.get('/debug/:sym', async (req, res) => {
  if (!POLYGON_KEY) return res.status(500).json({ error: 'POLYGON_KEY not set' });
  try {
    const today = new Date().toISOString().split('T')[0];
    const from = new Date(); from.setDate(from.getDate() - 5);
    const fromStr = from.toISOString().split('T')[0];
    const url = `https://api.polygon.io/v2/aggs/ticker/${req.params.sym.toUpperCase()}/range/1/day/${fromStr}/${today}?adjusted=true&sort=asc&limit=5&apiKey=${POLYGON_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`SOCA Proxy listening on port ${PORT}`));
