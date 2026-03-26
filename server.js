const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const POLYGON_KEY = process.env.POLYGON_KEY;
const FINNHUB_KEY = process.env.FINNHUB_KEY;

app.use(cors());
app.use(express.json());

// ── PRICE CACHE ──────────────────────────────────────────────────────────────
// Prices are fetched server-side every 30s and cached here
// Dashboard reads from cache — zero API calls on page load/refresh
let priceCache = {};       // sym → Finnhub quote object
let lastCacheUpdate = null;
let cacheReady = false;

const SYMBOLS = [
  'AAPL','MSFT','NVDA','GOOGL','AMZN','META','TSLA','AVGO','ORCL','ASML',
  'SPY','QQQ','IWM','DIA','XLK','XLF','XLE',
  'AMD','INTC','QCOM','MU','AMAT','LRCX','KLAC','TXN','MRVL','ARM',
  'JPM','BAC','WFC','GS','MS','BLK','V','MA','PYPL','AXP',
  'LLY','JNJ','UNH','ABBV','PFE','MRK','TMO','ABT','DHR','AMGN',
  'WMT','COST','HD','MCD','SBUX','NKE','TGT','LOW','TJX',
  'XOM','CVX','COP','SLB','EOG',
  'NFLX','DIS','CMCSA','T','VZ','TMUS','SPOT',
  'CAT','DE','BA','RTX','HON','GE','UPS','FDX','LMT','NOC',
  'CRM','ADBE','NOW','INTU','SNOW','PLTR','UBER','ABNB','COIN','SHOP',
  'SPGI','MCO','CB','MMM','PG','KO','PEP','PM','MO'
];

async function refreshPriceCache() {
  if (!FINNHUB_KEY) return;
  try {
    // Fetch all in parallel — server-side no CORS/rate limit issues from browser
    const results = await Promise.all(
      SYMBOLS.map(async sym => {
        try {
          const r = await fetch(
            `https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB_KEY}`,
            { timeout: 8000 }
          );
          const q = await r.json();
          if (q.c && q.c > 0) return { sym, quote: q };
          return null;
        } catch(e) { return null; }
      })
    );

    let updated = 0;
    results.forEach(item => {
      if (!item) return;
      priceCache[item.sym] = {
        ticker: item.sym,
        lastTrade: { p: item.quote.c },
        day: { o: item.quote.o, h: item.quote.h, l: item.quote.l, c: item.quote.c, v: 0 },
        prevDay: { c: item.quote.pc },
        finnhub: item.quote
      };
      updated++;
    });

    lastCacheUpdate = new Date().toISOString();
    cacheReady = true;
    console.log(`Cache updated: ${updated}/${SYMBOLS.length} symbols at ${lastCacheUpdate}`);
  } catch(e) {
    console.error('Cache refresh error:', e.message);
  }
}

// Start cache refresh loop immediately on boot
refreshPriceCache();
setInterval(refreshPriceCache, 30000); // refresh every 30s

// ── ROUTES ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'SOCA Proxy running',
    polygon: POLYGON_KEY ? 'configured' : 'missing',
    finnhub: FINNHUB_KEY ? 'configured' : 'missing',
    cacheReady,
    lastCacheUpdate,
    cachedSymbols: Object.keys(priceCache).length
  });
});

// Quote endpoint — returns from cache instantly, zero Finnhub calls
app.get('/quote/:symbols', (req, res) => {
  const requested = [...new Set(req.params.symbols.toUpperCase().split(','))];
  const tickers = requested
    .map(sym => priceCache[sym] || null)
    .filter(Boolean);
  res.json({
    tickers,
    fromCache: true,
    lastUpdate: lastCacheUpdate,
    ready: cacheReady
  });
});

// Candles via Polygon
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

// Debug — single symbol from cache
app.get('/debug/:sym', (req, res) => {
  const sym = req.params.sym.toUpperCase();
  const cached = priceCache[sym];
  res.json({
    sym,
    found: !!cached,
    price: cached?.finnhub?.c || null,
    change: cached?.finnhub?.d || null,
    changePct: cached?.finnhub?.dp || null,
    lastUpdate: lastCacheUpdate,
    cacheReady
  });
});

// Force manual cache refresh (useful after deploy)
app.get('/refresh', async (req, res) => {
  await refreshPriceCache();
  res.json({ ok: true, cachedSymbols: Object.keys(priceCache).length, lastUpdate: lastCacheUpdate });
});

app.listen(PORT, () => {
  console.log(`SOCA Proxy listening on port ${PORT}`);
  console.log(`Finnhub key: ${FINNHUB_KEY ? 'set' : 'MISSING'}`);
  console.log(`Polygon key: ${POLYGON_KEY ? 'set' : 'MISSING'}`);
});
