const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const POLYGON_KEY   = process.env.POLYGON_KEY;
const FINNHUB_KEY   = process.env.FINNHUB_KEY;
const SCHWAB_KEY    = process.env.SCHWAB_KEY;
const SCHWAB_SECRET = process.env.SCHWAB_SECRET;
const REDIRECT_URI  = process.env.REDIRECT_URI || 'https://soca-proxy-production.up.railway.app/callback';
const TG_TOKEN      = process.env.TG_TOKEN;
const TG_CHAT       = process.env.TG_CHAT;

app.use(cors());
app.use(express.json());

// ── TELEGRAM ──────────────────────────────────────────────────────────────────
async function tg(msg) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: 'Markdown' })
    });
  } catch(e) {}
}

// ── SCHWAB AUTH ───────────────────────────────────────────────────────────────
let schwabTokens = { access_token: null, refresh_token: null, expires_at: null, account_hash: null };

function schwabReady() {
  return schwabTokens.access_token && Date.now() < (schwabTokens.expires_at || 0);
}

async function refreshSchwabToken() {
  if (!schwabTokens.refresh_token) return false;
  try {
    const creds = Buffer.from(`${SCHWAB_KEY}:${SCHWAB_SECRET}`).toString('base64');
    const r = await fetch('https://api.schwabapi.com/v1/oauth/token', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: schwabTokens.refresh_token })
    });
    const d = await r.json();
    if (d.access_token) {
      schwabTokens.access_token  = d.access_token;
      schwabTokens.refresh_token = d.refresh_token || schwabTokens.refresh_token;
      schwabTokens.expires_at    = Date.now() + (d.expires_in - 60) * 1000;
      console.log('Schwab token refreshed');
      return true;
    }
    console.error('Schwab refresh failed:', JSON.stringify(d));
    return false;
  } catch(e) { console.error('Schwab refresh error:', e.message); return false; }
}

async function getSchwabToken() {
  if (schwabReady()) return schwabTokens.access_token;
  if (schwabTokens.refresh_token) {
    const ok = await refreshSchwabToken();
    if (ok) return schwabTokens.access_token;
  }
  return null;
}

async function getSchwabAccountHash() {
  if (schwabTokens.account_hash) return schwabTokens.account_hash;
  const token = await getSchwabToken();
  if (!token) return null;
  try {
    const r = await fetch('https://api.schwabapi.com/trader/v1/accounts/accountNumbers', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const d = await r.json();
    if (d && d[0]) {
      schwabTokens.account_hash = d[0].hashValue;
      console.log('Got account hash:', schwabTokens.account_hash);
      return schwabTokens.account_hash;
    }
  } catch(e) { console.error('Account hash error:', e.message); }
  return null;
}

// Refresh token every 25 min
setInterval(async () => { if (schwabTokens.refresh_token) await refreshSchwabToken(); }, 25 * 60 * 1000);

// ── PRICE CACHE ───────────────────────────────────────────────────────────────
let priceCache = {};
let lastCacheUpdate = null;
let cacheReady = false;
let dataSource = 'none';

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

// Fetch from Schwab (real-time, best quality)
async function fetchSchwabPrices() {
  const token = await getSchwabToken();
  if (!token) return false;
  try {
    const symsParam = SYMBOLS.join('%2C');
    const fields = 'quote,fundamental';
    const r = await fetch(
      `https://api.schwabapi.com/marketdata/v1/quotes?symbols=${symsParam}&fields=${fields}&indicative=false`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    if (!r.ok) { console.error('Schwab quotes error:', r.status); return false; }
    const d = await r.json();
    let updated = 0;
    for (const sym of SYMBOLS) {
      const q = d[sym]?.quote;
      const f = d[sym]?.fundamental;
      if (!q || !q.lastPrice) continue;
      priceCache[sym] = {
        ticker: sym,
        lastTrade: { p: q.lastPrice },
        day: {
          o: q.openPrice || q.lastPrice,
          h: q.highPrice || q.lastPrice,
          l: q.lowPrice  || q.lastPrice,
          c: q.lastPrice,
          v: q.totalVolume || 0
        },
        prevDay: { c: q.closePrice || q.lastPrice },
        schwab: {
          c:  q.lastPrice,
          o:  q.openPrice,
          h:  q.highPrice,
          l:  q.lowPrice,
          pc: q.closePrice,       // prev close
          d:  q.netChange,        // day change $
          dp: q.netPercentChange, // day change %
          preMarket:  q.preMarketPrice  || null,
          afterHours: q.postMarketPrice || null,
          preMarketChange:   q.preMarketChange   || null,
          preMarketChangePct: q.preMarketPercentChange || null,
          afterHoursChange:  q.postMarketChange  || null,
          afterHoursChangePct: q.postMarketPercentChange || null,
          bidPrice: q.bidPrice,
          askPrice: q.askPrice,
          volume:   q.totalVolume,
          week52High: f?.['52WeekHigh'],
          week52Low:  f?.['52WeekLow'],
        }
      };
      updated++;
    }
    dataSource = 'schwab';
    lastCacheUpdate = new Date().toISOString();
    cacheReady = true;
    console.log(`Schwab prices updated: ${updated} symbols`);
    return true;
  } catch(e) { console.error('Schwab price fetch error:', e.message); return false; }
}

// Fallback: Finnhub
async function fetchFinnhubPrices() {
  if (!FINNHUB_KEY) return false;
  try {
    const results = await Promise.all(
      SYMBOLS.map(async sym => {
        try {
          const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB_KEY}`);
          const q = await r.json();
          if (!q.c || q.c === 0) return null;
          return { sym, quote: q };
        } catch(e) { return null; }
      })
    );
    let updated = 0;
    results.forEach(item => {
      if (!item) return;
      const q = item.quote;
      priceCache[item.sym] = {
        ticker: item.sym,
        lastTrade: { p: q.c },
        day: { o: q.o, h: q.h, l: q.l, c: q.c, v: 0 },
        prevDay: { c: q.pc },
        finnhub: q
      };
      updated++;
    });
    dataSource = 'finnhub';
    lastCacheUpdate = new Date().toISOString();
    cacheReady = true;
    console.log(`Finnhub prices updated: ${updated} symbols`);
    return true;
  } catch(e) { console.error('Finnhub error:', e.message); return false; }
}

async function refreshPriceCache() {
  // Try Schwab first (real-time), fall back to Finnhub
  const schwabOk = await fetchSchwabPrices();
  if (!schwabOk) await fetchFinnhubPrices();
}

// Start cache refresh immediately and every 30s
refreshPriceCache();
setInterval(refreshPriceCache, 30000);

// ── BOT ENGINE ────────────────────────────────────────────────────────────────
let botRunning = false;
let botPositions = {}; // sym → { qty, avgPrice, entryTime }
let botSettings = {
  slPct: 5, tpPct: 15, maxPosPct: 10, rsiB: 32, rsiS: 68, minConf: 75
};
let tradeLog = [];
let cash = 1000; // paper cash tracking

// Strategy indicators
const mean = a => a.reduce((s,x)=>s+x,0)/a.length;
function sma(a,n){if(a.length<n)return a[a.length-1];return mean(a.slice(-n));}
function ema(a,n){if(a.length<n)return a[a.length-1];const k=2/(n+1);let e=mean(a.slice(0,n));for(let i=n;i<a.length;i++)e=a[i]*k+e*(1-k);return e;}
function rsi(a,n=14){if(a.length<n+1)return 50;let g=0,l=0;for(let i=a.length-n;i<a.length;i++){const d=a[i]-a[i-1];d>0?g+=d:l-=d;}return 100-100/(1+(g/(l||1e-9)));}
function bb(a,n=20){const m=sma(a,n);const sl=a.slice(-n);const sd=Math.sqrt(sl.reduce((s,p)=>s+(p-m)**2,0)/n);return{upper:m+2*sd,lower:m-2*sd,mid:m};}
function roc(a,n=10){if(a.length<n+1)return 0;return(a[a.length-1]-a[a.length-1-n])/a[a.length-1-n]*100;}
function atr(a,n=14){if(a.length<n+1)return(a[a.length-1]||100)*.02;let s=0;for(let i=a.length-n;i<a.length;i++){const h=a[i]*1.005,lv=a[i]*.995;s+=Math.max(h-lv,Math.abs(h-(a[i-1]||a[i])),Math.abs(lv-(a[i-1]||a[i])));}return s/n;}

// Daily candle cache for indicators
let dailyBars = {}; // sym → [closes]

async function fetchDailyBars(sym) {
  if (!POLYGON_KEY) return;
  try {
    const to = new Date().toISOString().split('T')[0];
    const from = new Date(); from.setFullYear(from.getFullYear()-1);
    const fromStr = from.toISOString().split('T')[0];
    const r = await fetch(`https://api.polygon.io/v2/aggs/ticker/${sym}/range/1/day/${fromStr}/${to}?adjusted=true&sort=asc&limit=365&apiKey=${POLYGON_KEY}`);
    const d = await r.json();
    if (d.results && d.results.length > 0) {
      dailyBars[sym] = d.results.map(b => b.c);
    }
  } catch(e) {}
}

// Pre-fetch daily bars for all symbols at startup
async function initDailyBars() {
  console.log('Fetching daily bars for all symbols...');
  for (const sym of SYMBOLS) {
    await fetchDailyBars(sym);
    await new Promise(r => setTimeout(r, 300));
  }
  console.log(`Daily bars loaded for ${Object.keys(dailyBars).length} symbols`);
}
initDailyBars();
// Refresh daily bars every 6 hours
setInterval(initDailyBars, 6 * 60 * 60 * 1000);

function analyze(sym) {
  const closes = dailyBars[sym] || [];
  const NONE = { buyGate: false, sellSignal: false, passed: 0, confidence: 0, trendScore: 0, mrScore: 0, rocVal: 0, atrVal: 0, rsiVal: 50 };
  if (closes.length < 30) return NONE;
  const p = priceCache[sym]?.schwab?.c || priceCache[sym]?.finnhub?.c || closes[closes.length-1];
  const rsiV = rsi(closes), e9 = ema(closes,9), s20 = sma(closes,20);
  const e21 = ema(closes,21), s50 = sma(closes,50);
  const bands = bb(closes,20), rocV = roc(closes,10), atrV = atr(closes,14);
  const vol = atrV / p;
  let trendScore = 0;
  if(e9>s20)trendScore++;if(e21>s50)trendScore++;if(p>s20)trendScore++;
  if((ema(closes,12)-ema(closes,26))>0)trendScore++;
  const trendBull = trendScore >= 3;
  let mrScore = 0;
  if(rsiV < botSettings.rsiB) mrScore+=2; else if(rsiV<40) mrScore+=1;
  if(p < bands.lower) mrScore+=2; else if(p<bands.mid) mrScore+=1;
  const meanBull = mrScore >= 2;
  const momBull = rocV > 0.5;
  const volOk = vol < 0.03;
  const passed = [trendBull, meanBull, momBull, volOk].filter(Boolean).length;
  return {
    buyGate: trendBull && meanBull && momBull && volOk,
    sellSignal: trendScore <= 1 || (rsiV > botSettings.rsiS && e9 < s20),
    passed, confidence: passed * 25,
    trendScore, mrScore, rocVal: rocV, atrVal: atrV, rsiVal: rsiV
  };
}

// Place order on Schwab paper account
async function placeSchwabOrder(sym, side, qty, price) {
  const token = await getSchwabToken();
  const hash = await getSchwabAccountHash();
  if (!token || !hash) {
    console.log('Schwab not connected — paper trade only');
    return { simulated: true };
  }
  try {
    const order = {
      orderType: 'MARKET',
      session: 'NORMAL',
      duration: 'DAY',
      orderStrategyType: 'SINGLE',
      orderLegCollection: [{
        instruction: side === 'BUY' ? 'BUY' : 'SELL',
        quantity: qty,
        instrument: { symbol: sym, assetType: 'EQUITY' }
      }]
    };
    const r = await fetch(`https://api.schwabapi.com/trader/v1/accounts/${hash}/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(order)
    });
    if (r.status === 201) {
      console.log(`Schwab order placed: ${side} ${qty} ${sym}`);
      return { success: true, status: r.status };
    } else {
      const err = await r.text();
      console.error(`Schwab order failed: ${r.status}`, err);
      return { success: false, error: err };
    }
  } catch(e) {
    console.error('Schwab order error:', e.message);
    return { success: false, error: e.message };
  }
}

// Bot scan loop
async function runBotScan() {
  if (!botRunning) return;
  const now = new Date();
  // Only trade during market hours ET (9:30am - 4:00pm)
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const h = et.getHours(), m = et.getMinutes(), dow = et.getDay();
  const mins = h * 60 + m;
  const isMarketHours = dow >= 1 && dow <= 5 && mins >= 570 && mins < 960;
  if (!isMarketHours) return;

  for (const sym of SYMBOLS) {
    const p = priceCache[sym]?.schwab?.c || priceCache[sym]?.finnhub?.c;
    if (!p) continue;
    const sig = analyze(sym);
    const pos = botPositions[sym];

    if (pos) {
      // Check sell conditions
      const pnlPct = (p - pos.avgPrice) / pos.avgPrice * 100;
      let reason = null;
      if (pnlPct <= -botSettings.slPct) reason = `STOP LOSS (${pnlPct.toFixed(2)}%)`;
      else if (pnlPct >= botSettings.tpPct) reason = `TAKE PROFIT (+${pnlPct.toFixed(2)}%)`;
      else if (sig.sellSignal) reason = 'INDICATOR SELL';
      if (reason) {
        const result = await placeSchwabOrder(sym, 'SELL', pos.qty, p);
        const pnl = (p - pos.avgPrice) * pos.qty;
        cash += p * pos.qty;
        const trade = { time: new Date().toISOString(), side: 'SELL', sym, qty: pos.qty, price: p, pnl: pnl.toFixed(2), reason, schwab: result };
        tradeLog.unshift(trade);
        if (tradeLog.length > 200) tradeLog.pop();
        delete botPositions[sym];
        const emoji = pnl >= 0 ? '✅' : '❌';
        await tg(`${emoji} *SELL ${sym}*\n${pos.qty} shares @ $${p.toFixed(2)}\nP&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%)\nReason: ${reason}\n${result.simulated ? '⚠️ Simulated (Schwab not connected)' : '✓ Placed on Schwab'}`);
      }
    } else {
      // Check buy conditions
      if (sig.buyGate && sig.confidence >= botSettings.minConf) {
        const maxVal = cash * (botSettings.maxPosPct / 100);
        const qty = Math.floor(maxVal / p);
        if (qty > 0 && cash >= qty * p) {
          const result = await placeSchwabOrder(sym, 'BUY', qty, p);
          cash -= p * qty;
          botPositions[sym] = { qty, avgPrice: p, entryTime: new Date().toISOString() };
          const trade = { time: new Date().toISOString(), side: 'BUY', sym, qty, price: p, pnl: null, reason: `ALL 4 PASS (${sig.confidence}%)`, schwab: result };
          tradeLog.unshift(trade);
          if (tradeLog.length > 200) tradeLog.pop();
          await tg(`📈 *BUY ${sym}*\n${qty} shares @ $${p.toFixed(2)}\nTotal: $${(qty*p).toFixed(2)}\nSignal: All 4 strategies agree (${sig.confidence}%)\n${result.simulated ? '⚠️ Simulated (Schwab not connected)' : '✓ Placed on Schwab'}`);
        }
      }
    }
  }
}

// Run bot scan every 30s
setInterval(runBotScan, 30000);

// ── ROUTES ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'SOCA Proxy running',
    dataSource,
    schwabConnected: schwabReady(),
    cacheReady,
    lastCacheUpdate,
    cachedSymbols: Object.keys(priceCache).length,
    botRunning,
    openPositions: Object.keys(botPositions).length
  });
});

// Schwab OAuth — Step 1: get login URL
app.get('/auth', (req, res) => {
  const url = `https://api.schwabapi.com/v1/oauth/authorize?client_id=${SCHWAB_KEY}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code`;
  res.redirect(url);
});

// Schwab OAuth — Step 2: handle callback
app.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing authorization code');
  try {
    const creds = Buffer.from(`${SCHWAB_KEY}:${SCHWAB_SECRET}`).toString('base64');
    const r = await fetch('https://api.schwabapi.com/v1/oauth/token', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI })
    });
    const d = await r.json();
    if (d.access_token) {
      schwabTokens.access_token  = d.access_token;
      schwabTokens.refresh_token = d.refresh_token;
      schwabTokens.expires_at    = Date.now() + (d.expires_in - 60) * 1000;
      await getSchwabAccountHash();
      await fetchSchwabPrices();
      await tg('🟢 *SOCA Bot connected to Schwab!*\nReal-time prices active. Bot ready to trade.');
      res.send(`
        <html><body style="font-family:Arial;text-align:center;padding:60px;background:#f5f5f5">
        <h2 style="color:#1f3864">✅ Schwab Connected!</h2>
        <p>Real-time prices are now active.</p>
        <p>You can close this tab and return to your dashboard.</p>
        <p style="color:#888;font-size:12px">Account hash: ${schwabTokens.account_hash || 'loading...'}</p>
        </body></html>
      `);
    } else {
      res.status(400).send('Auth failed: ' + JSON.stringify(d));
    }
  } catch(e) {
    res.status(500).send('Error: ' + e.message);
  }
});

// Quotes — from cache, instant
app.get('/quote/:symbols', (req, res) => {
  const requested = [...new Set(req.params.symbols.toUpperCase().split(','))];
  const tickers = requested.map(sym => priceCache[sym] || null).filter(Boolean);
  res.json({ tickers, fromCache: true, dataSource, lastUpdate: lastCacheUpdate, ready: cacheReady });
});

// Candles via Polygon
app.get('/candles/:sym/:mult/:span/:from/:to', async (req, res) => {
  if (!POLYGON_KEY) return res.status(500).json({ error: 'POLYGON_KEY not set' });
  try {
    const { sym, mult, span, from, to } = req.params;
    const r = await fetch(`https://api.polygon.io/v2/aggs/ticker/${sym}/range/${mult}/${span}/${from}/${to}?adjusted=true&sort=asc&limit=1000&apiKey=${POLYGON_KEY}`);
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Bot control
app.post('/bot/start', async (req, res) => {
  if (req.body.settings) botSettings = { ...botSettings, ...req.body.settings };
  botRunning = true;
  console.log('Bot started');
  await tg(`▶️ *SOCA Bot STARTED*\nWatching ${SYMBOLS.length} stocks\nSL: ${botSettings.slPct}%  TP: ${botSettings.tpPct}%\nData: ${dataSource}\nSchwab: ${schwabReady() ? '✓ connected' : '⚠️ not connected'}`);
  res.json({ ok: true, botRunning, settings: botSettings });
});

app.post('/bot/stop', async (req, res) => {
  botRunning = false;
  console.log('Bot stopped');
  const totalPnl = tradeLog.filter(t=>t.side==='SELL').reduce((s,t)=>s+(parseFloat(t.pnl)||0),0);
  await tg(`⏹️ *SOCA Bot STOPPED*\nTrades: ${tradeLog.length}\nTotal P&L: ${totalPnl>=0?'+':''}$${totalPnl.toFixed(2)}\nOpen positions: ${Object.keys(botPositions).length}`);
  res.json({ ok: true, botRunning });
});

app.get('/bot/status', (req, res) => {
  const positions = Object.entries(botPositions).map(([sym, pos]) => {
    const cur = priceCache[sym]?.schwab?.c || priceCache[sym]?.finnhub?.c || pos.avgPrice;
    const pnl = (cur - pos.avgPrice) * pos.qty;
    const pnlPct = (cur - pos.avgPrice) / pos.avgPrice * 100;
    return { sym, qty: pos.qty, avgPrice: pos.avgPrice, currentPrice: cur, pnl: +pnl.toFixed(2), pnlPct: +pnlPct.toFixed(2), entryTime: pos.entryTime };
  });
  res.json({ botRunning, positions, tradeLog: tradeLog.slice(0, 50), cash, settings: botSettings, dataSource, schwabConnected: schwabReady() });
});

app.post('/bot/settings', (req, res) => {
  botSettings = { ...botSettings, ...req.body };
  res.json({ ok: true, settings: botSettings });
});

// Close all positions
app.post('/bot/closeall', async (req, res) => {
  const syms = Object.keys(botPositions);
  for (const sym of syms) {
    const pos = botPositions[sym];
    const p = priceCache[sym]?.schwab?.c || priceCache[sym]?.finnhub?.c || pos.avgPrice;
    await placeSchwabOrder(sym, 'SELL', pos.qty, p);
    const pnl = (p - pos.avgPrice) * pos.qty;
    tradeLog.unshift({ time: new Date().toISOString(), side: 'SELL', sym, qty: pos.qty, price: p, pnl: pnl.toFixed(2), reason: req.body.reason || 'MANUAL CLOSE ALL' });
    cash += p * pos.qty;
    delete botPositions[sym];
  }
  res.json({ ok: true, closed: syms.length });
});

// Debug
app.get('/debug/:sym', (req, res) => {
  const sym = req.params.sym.toUpperCase();
  res.json({ sym, cached: priceCache[sym] || null, dataSource, schwabConnected: schwabReady(), lastUpdate: lastCacheUpdate });
});

app.listen(PORT, () => {
  console.log(`SOCA Proxy on port ${PORT}`);
  console.log(`Schwab: ${SCHWAB_KEY ? 'key set' : 'MISSING KEY'}`);
  console.log(`Finnhub: ${FINNHUB_KEY ? 'key set' : 'MISSING'}`);
  console.log(`Polygon: ${POLYGON_KEY ? 'key set' : 'MISSING'}`);
});
