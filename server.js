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
 
// Batch quote endpoint — fetches all symbols in one Polygon grouped daily bars call
// This is free tier compatible and returns all tickers in ONE request
app.get('/quote/:symbols', async (req, res) => {
  if (!POLYGON_KEY) return res.status(500).json({ error: 'POLYGON_KEY not set' });
  try {
    // Polygon grouped daily bars — returns ALL tickers for a given date in one call
    // Find the most recent trading day
    const today = new Date();
    // If weekend, go back to Friday
    const day = today.getDay();
    if (day === 0) today.setDate(today.getDate() - 2); // Sunday → Friday
    if (day === 6) today.setDate(today.getDate() - 1); // Saturday → Friday
    const dateStr = today.toISOString().split('T')[0];
 
    const url = `https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${dateStr}?adjusted=true&apiKey=${POLYGON_KEY}`;
    const r = await fetch(url);
    const d = await r.json();
 
    if (!d.results || d.results.length === 0) {
      // Fallback: try previous trading day
      const prev = new Date(today);
      prev.setDate(prev.getDate() - 1);
      if (prev.getDay() === 0) prev.setDate(prev.getDate() - 2);
      if (prev.getDay() === 6) prev.setDate(prev.getDate() - 1);
      const prevStr = prev.toISOString().split('T')[0];
      const r2 = await fetch(`https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${prevStr}?adjusted=true&apiKey=${POLYGON_KEY}`);
      const d2 = await r2.json();
 
      if (!d2.results) return res.json({ tickers: [] });
 
      const requestedSyms = new Set(req.params.symbols.toUpperCase().split(','));
      const tickers = d2.results
        .filter(b => requestedSyms.has(b.T))
        .map(b => ({
          ticker: b.T,
          lastTrade: { p: b.c },
          day: { o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, vw: b.vw },
          prevDay: { c: b.o } // fallback
        }));
      return res.json({ tickers });
    }
 
    // Filter to only requested symbols
    const requestedSyms = new Set(req.params.symbols.toUpperCase().split(','));
    const tickers = d.results
      .filter(b => requestedSyms.has(b.T))
      .map(b => ({
        ticker: b.T,
        lastTrade: { p: b.c },
        day: { o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, vw: b.vw },
        prevDay: { c: b.o } // will be updated below
      }));
 
    // Get prev close separately for accurate day change %
    // Use a second grouped call for previous day
    const prev = new Date(today);
    prev.setDate(prev.getDate() - 1);
    if (prev.getDay() === 0) prev.setDate(prev.getDate() - 2);
    if (prev.getDay() === 6) prev.setDate(prev.getDate() - 1);
    const prevStr = prev.toISOString().split('T')[0];
 
    const r2 = await fetch(`https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${prevStr}?adjusted=true&apiKey=${POLYGON_KEY}`);
    const d2 = await r2.json();
 
    if (d2.results) {
      const prevMap = {};
      d2.results.forEach(b => { prevMap[b.T] = b.c; });
      tickers.forEach(t => {
        if (prevMap[t.ticker]) t.prevDay = { c: prevMap[t.ticker] };
      });
    }
 
    res.json({ tickers });
  } catch (e) {
    console.error('Quote error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
 
// Candles / aggregates
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
    const today = new Date();
    if (today.getDay() === 0) today.setDate(today.getDate() - 2);
    if (today.getDay() === 6) today.setDate(today.getDate() - 1);
    const dateStr = today.toISOString().split('T')[0];
    const url = `https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${dateStr}?adjusted=true&apiKey=${POLYGON_KEY}`;
    const r = await fetch(url);
    const d = await r.json();
    const sym = req.params.sym.toUpperCase();
    const result = d.results?.find(b => b.T === sym);
    res.json({ date: dateStr, result, status: d.status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
 
app.listen(PORT, () => console.log(`SOCA Proxy listening on port ${PORT}`));
 
