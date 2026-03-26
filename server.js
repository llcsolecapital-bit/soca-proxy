const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const POLYGON_KEY = process.env.POLYGON_KEY;

app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'APEX Proxy running', polygon: POLYGON_KEY ? 'configured' : 'missing key' });
});

// Generic Polygon proxy — forwards any path
app.get('/polygon/*', async (req, res) => {
  if (!POLYGON_KEY) return res.status(500).json({ error: 'POLYGON_KEY env var not set' });
  try {
    const path = req.params[0];
    const query = new URLSearchParams(req.query).toString();
    const url = `https://api.polygon.io/${path}${query ? '?' + query + '&' : '?'}apiKey=${POLYGON_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Snapshot: current price + day data for one or many tickers
app.get('/quote/:symbols', async (req, res) => {
  if (!POLYGON_KEY) return res.status(500).json({ error: 'POLYGON_KEY not set' });
  try {
    const syms = req.params.symbols.toUpperCase();
    const url = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${syms}&apiKey=${POLYGON_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    res.json(data);
  } catch (e) {
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

// Previous day close (for after-hours calc)
app.get('/prevday/:sym', async (req, res) => {
  if (!POLYGON_KEY) return res.status(500).json({ error: 'POLYGON_KEY not set' });
  try {
    const url = `https://api.polygon.io/v2/aggs/ticker/${req.params.sym}/prev?adjusted=true&apiKey=${POLYGON_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`APEX Proxy listening on port ${PORT}`));
