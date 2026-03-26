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
 
// Returns the most recent trading day grouped bars from Polygon
async function getGroupedBars(daysBack = 0) {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  et.setDate(et.getDate() - daysBack);
  for (let i = 0; i < 7; i++) {
    const dow = et.getDay();
    if (dow === 0) et.setDate(et.getDate() - 2);
    if (dow === 6) et.setDate(et.getDate() - 1);
    const dateStr = et.toISOString().split('T')[0];
    const r = await fetch(`https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${dateStr}?adjusted=true&apiKey=${POLYGON_KEY}`);
    const data = await r.json();
    if (data.results && data.results.length > 0) return { data, dateStr };
    et.setDate(et.getDate() - 1);
  }
  return null;
}
 
// Quote endpoint — one call gets all tickers
app.get('/quote/:symbols', async (req, res) => {
  if (!POLYGON_KEY) return res.status(500).json({ error: 'POLYGON_KEY not set' });
  try {
    const requestedSyms = new Set(req.params.symbols.toUpperCase().split(','));
 
    // Get today (or most recent trading day)
    const latest = await getGroupedBars(0);
    if (!latest) return res.json({ tickers: [] });
 
    const tickers = latest.data.results
      .filter(b => requestedSyms.has(b.T))
      .map(b => ({
        ticker: b.T,
        lastTrade: { p: b.c },
        day: { o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, vw: b.vw },
        prevDay: { c: b.o } // default fallback
      }));
 
    // Get previous trading day for accurate % change
    const prev = await getGroupedBars(1);
    if (prev) {
      const prevMap = {};
      prev.data.results.forEach(b => { prevMap[b.T] = b.c; });
      tickers.forEach(t => {
        if (prevMap[t.ticker]) t.prevDay = { c: prevMap[t.ticker] };
      });
    }
 
    res.json({ tickers, date: latest.dateStr });
  } catch (e) {
    console.error('Quote error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
 
// Candles
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
 
// Debug
app.get('/debug/:sym', async (req, res) => {
  if (!POLYGON_KEY) return res.status(500).json({ error: 'POLYGON_KEY not set' });
  try {
    const sym = req.params.sym.toUpperCase();
    const latest = await getGroupedBars(0);
    const result = latest?.data.results?.find(b => b.T === sym);
    res.json({ date: latest?.dateStr, found: !!result, data: result || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
 
app.listen(PORT, () => console.log(`SOCA Proxy listening on port ${PORT}`));
