const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;

// ══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════
const SCHWAB_KEY    = process.env.SCHWAB_KEY;
const SCHWAB_SECRET = process.env.SCHWAB_SECRET;
const REDIRECT_URI  = process.env.REDIRECT_URI || 'https://soca-proxy-production.up.railway.app/callback';
const TG_TOKEN      = process.env.TG_TOKEN;
const TG_CHAT       = process.env.TG_CHAT;
const FINNHUB_KEY   = process.env.FINNHUB_KEY; // Free: https://finnhub.io/register

// Account config - $200k paper account
const ACCOUNT_BALANCE = 200000;

// ══════════════════════════════════════════════════════════════════════════════
// AI LEARNING SYSTEM - Tracks what works
// ══════════════════════════════════════════════════════════════════════════════
let aiMemory = {
  // Strategy performance tracking
  strategyScores: {
    momentum: { wins: 0, losses: 0, totalPnL: 0 },
    rsi: { wins: 0, losses: 0, totalPnL: 0 },
    bb: { wins: 0, losses: 0, totalPnL: 0 },
    ema: { wins: 0, losses: 0, totalPnL: 0 },
    breakout: { wins: 0, losses: 0, totalPnL: 0 },
    news: { wins: 0, losses: 0, totalPnL: 0 },
    quick: { wins: 0, losses: 0, totalPnL: 0 }
  },
  // Symbol performance
  symbolScores: {},
  // Time of day patterns
  hourlyPerformance: {},
  // Adaptive weights (start equal, evolve)
  weights: {
    momentum: 1.0,
    rsi: 1.0,
    bb: 1.0,
    ema: 1.0,
    breakout: 1.0,
    news: 1.5, // News starts with higher weight
    quick: 0.8
  },
  // Confidence threshold (adapts over time)
  entryThreshold: 35,
  // Risk appetite (increases with wins, decreases with losses)
  riskAppetite: 1.0,
  // Total decisions made
  decisionsAnalyzed: 0,
  tradesExecuted: 0
};

// AI thought log - shows reasoning
let aiThoughts = [];

function logThought(thought) {
  const entry = {
    time: new Date().toISOString(),
    thought,
    riskAppetite: aiMemory.riskAppetite.toFixed(2),
    threshold: aiMemory.entryThreshold
  };
  aiThoughts.unshift(entry);
  if (aiThoughts.length > 200) aiThoughts.pop();
  console.log(`🧠 ${thought}`);
}

// Update AI memory after a trade closes
function learnFromTrade(trade) {
  const won = parseFloat(trade.pnl) > 0;
  const pnl = parseFloat(trade.pnl) || 0;
  const strategies = trade.strategies || [];
  const hour = new Date(trade.time).getHours();
  
  // Update strategy scores
  strategies.forEach(strat => {
    if (aiMemory.strategyScores[strat]) {
      if (won) aiMemory.strategyScores[strat].wins++;
      else aiMemory.strategyScores[strat].losses++;
      aiMemory.strategyScores[strat].totalPnL += pnl;
      
      // Adjust weight based on performance
      const stats = aiMemory.strategyScores[strat];
      const winRate = stats.wins / (stats.wins + stats.losses || 1);
      aiMemory.weights[strat] = 0.5 + winRate; // Range: 0.5 to 1.5
    }
  });
  
  // Update symbol scores
  if (!aiMemory.symbolScores[trade.sym]) {
    aiMemory.symbolScores[trade.sym] = { wins: 0, losses: 0, totalPnL: 0 };
  }
  if (won) aiMemory.symbolScores[trade.sym].wins++;
  else aiMemory.symbolScores[trade.sym].losses++;
  aiMemory.symbolScores[trade.sym].totalPnL += pnl;
  
  // Update hourly performance
  if (!aiMemory.hourlyPerformance[hour]) {
    aiMemory.hourlyPerformance[hour] = { wins: 0, losses: 0, totalPnL: 0 };
  }
  if (won) aiMemory.hourlyPerformance[hour].wins++;
  else aiMemory.hourlyPerformance[hour].losses++;
  aiMemory.hourlyPerformance[hour].totalPnL += pnl;
  
  // Adjust risk appetite
  if (won) {
    aiMemory.riskAppetite = Math.min(1.5, aiMemory.riskAppetite + 0.05);
    aiMemory.entryThreshold = Math.max(25, aiMemory.entryThreshold - 1);
    logThought(`WIN on ${trade.sym}! Risk appetite → ${aiMemory.riskAppetite.toFixed(2)}, threshold → ${aiMemory.entryThreshold}`);
  } else {
    aiMemory.riskAppetite = Math.max(0.5, aiMemory.riskAppetite - 0.08);
    aiMemory.entryThreshold = Math.min(50, aiMemory.entryThreshold + 2);
    logThought(`LOSS on ${trade.sym}. Risk appetite → ${aiMemory.riskAppetite.toFixed(2)}, threshold → ${aiMemory.entryThreshold}`);
  }
  
  aiMemory.tradesExecuted++;
}

app.use(cors());
app.use(express.json());

// ══════════════════════════════════════════════════════════════════════════════
// TELEGRAM ALERTS
// ══════════════════════════════════════════════════════════════════════════════
async function tg(msg) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: 'Markdown' })
    });
  } catch(e) { console.error('Telegram error:', e.message); }
}

// ══════════════════════════════════════════════════════════════════════════════
// NEWS SCANNING SYSTEM
// ══════════════════════════════════════════════════════════════════════════════
let newsCache = {}; // sym → [{headline, sentiment, time}]
let recentNews = []; // All recent news for dashboard

// Keywords that suggest bullish news
const BULLISH_KEYWORDS = [
  'beats', 'exceeds', 'raises', 'upgrade', 'buy', 'outperform', 'bullish',
  'record', 'surge', 'soar', 'jump', 'rally', 'breakthrough', 'partnership',
  'deal', 'acquisition', 'growth', 'profit', 'revenue beat', 'guidance raise',
  'fda approval', 'contract', 'win', 'launch', 'expand', 'positive', 'strong'
];

// Keywords that suggest bearish news
const BEARISH_KEYWORDS = [
  'miss', 'below', 'cuts', 'downgrade', 'sell', 'underperform', 'bearish',
  'decline', 'drop', 'fall', 'plunge', 'crash', 'warning', 'lawsuit',
  'investigation', 'recall', 'layoff', 'loss', 'weak', 'guidance cut',
  'fda reject', 'delay', 'fail', 'negative', 'concern', 'risk'
];

function analyzeNewsSentiment(headline) {
  const lower = headline.toLowerCase();
  let score = 0;
  let matches = [];
  
  BULLISH_KEYWORDS.forEach(kw => {
    if (lower.includes(kw)) {
      score += 10;
      matches.push(`+${kw}`);
    }
  });
  
  BEARISH_KEYWORDS.forEach(kw => {
    if (lower.includes(kw)) {
      score -= 10;
      matches.push(`-${kw}`);
    }
  });
  
  return {
    score,
    sentiment: score > 5 ? 'BULLISH' : score < -5 ? 'BEARISH' : 'NEUTRAL',
    matches
  };
}

// Fetch news from Finnhub
async function fetchNews() {
  if (!FINNHUB_KEY) {
    logThought('No FINNHUB_KEY set - news scanning disabled');
    return;
  }
  
  try {
    // Fetch general market news
    const r = await fetch(`https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_KEY}`);
    const news = await r.json();
    
    if (!Array.isArray(news)) return;
    
    const now = Date.now();
    const fiveMinAgo = now - 5 * 60 * 1000;
    
    for (const item of news.slice(0, 30)) {
      // Only process recent news (last 5 min)
      const newsTime = item.datetime * 1000;
      if (newsTime < fiveMinAgo) continue;
      
      const sentiment = analyzeNewsSentiment(item.headline);
      const newsItem = {
        headline: item.headline,
        source: item.source,
        url: item.url,
        time: new Date(newsTime).toISOString(),
        sentiment: sentiment.sentiment,
        score: sentiment.score,
        matches: sentiment.matches,
        related: item.related ? item.related.split(',') : []
      };
      
      // Add to recent news
      recentNews.unshift(newsItem);
      if (recentNews.length > 100) recentNews.pop();
      
      // Process related symbols
      if (item.related) {
        const symbols = item.related.split(',');
        for (const sym of symbols) {
          const cleanSym = sym.trim().toUpperCase();
          if (SCALP_SYMBOLS.includes(cleanSym)) {
            if (!newsCache[cleanSym]) newsCache[cleanSym] = [];
            newsCache[cleanSym].unshift(newsItem);
            if (newsCache[cleanSym].length > 20) newsCache[cleanSym].pop();
            
            // Log significant news
            if (Math.abs(sentiment.score) >= 10) {
              logThought(`📰 ${cleanSym}: "${item.headline.slice(0, 60)}..." → ${sentiment.sentiment} (${sentiment.score > 0 ? '+' : ''}${sentiment.score})`);
              
              // Potentially trigger a trade on very strong news
              if (botRunning && Math.abs(sentiment.score) >= 20) {
                checkNewsSignal(cleanSym, sentiment);
              }
            }
          }
        }
      }
    }
  } catch(e) {
    console.error('News fetch error:', e.message);
  }
}

// Check if news should trigger a trade
function checkNewsSignal(sym, sentiment) {
  if (botPositions[sym]) return; // Already in position
  if (Object.keys(botPositions).length >= botSettings.scalp_max_positions) return;
  
  const price = priceCache[sym]?.lastPrice;
  if (!price) return;
  
  // Only trade on strongly bullish news (we can only go long)
  if (sentiment.sentiment === 'BULLISH' && sentiment.score >= 20) {
    const newsWeight = aiMemory.weights.news || 1.5;
    const adjustedScore = sentiment.score * newsWeight * aiMemory.riskAppetite;
    
    logThought(`🚨 NEWS TRADE SIGNAL: ${sym} | Bullish news (score: ${sentiment.score}) | Adjusted: ${adjustedScore.toFixed(0)}`);
    
    if (adjustedScore >= 25) {
      const signal = {
        sym,
        price,
        direction: 'LONG',
        confidence: Math.min(95, adjustedScore),
        reasons: `NEWS:${sentiment.score}`,
        strategies: ['news'],
        newsHeadline: sentiment.matches.join(', ')
      };
      
      signalLog.unshift({ ...signal, time: new Date().toISOString() });
      executeScalpEntry(sym, price, signal);
    }
  }
}

// Get news sentiment for a symbol (used by main signal checker)
function getNewsSentiment(sym) {
  const news = newsCache[sym];
  if (!news || news.length === 0) return { score: 0, sentiment: 'NEUTRAL', hasNews: false };
  
  // Only consider news from last 10 minutes
  const tenMinAgo = Date.now() - 10 * 60 * 1000;
  const recentNews = news.filter(n => new Date(n.time).getTime() > tenMinAgo);
  
  if (recentNews.length === 0) return { score: 0, sentiment: 'NEUTRAL', hasNews: false };
  
  // Average sentiment of recent news
  const avgScore = recentNews.reduce((sum, n) => sum + n.score, 0) / recentNews.length;
  
  return {
    score: avgScore,
    sentiment: avgScore > 5 ? 'BULLISH' : avgScore < -5 ? 'BEARISH' : 'NEUTRAL',
    hasNews: true,
    headlines: recentNews.slice(0, 3).map(n => n.headline)
  };
}

// Fetch news every 30 seconds
setInterval(fetchNews, 30000);
// Initial fetch
setTimeout(fetchNews, 5000);

// ══════════════════════════════════════════════════════════════════════════════
// SCHWAB AUTHENTICATION
// ══════════════════════════════════════════════════════════════════════════════
let schwabTokens = { 
  access_token: null, 
  refresh_token: null, 
  expires_at: null, 
  account_hash: null,
  streamer_url: null,
  streamer_socket_url: null,
  customer_id: null
};

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
      console.log('✓ Schwab token refreshed');
      return true;
    }
    console.error('✗ Schwab refresh failed:', JSON.stringify(d));
    return false;
  } catch(e) { 
    console.error('✗ Schwab refresh error:', e.message); 
    return false; 
  }
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
      console.log('✓ Got account hash:', schwabTokens.account_hash);
      return schwabTokens.account_hash;
    }
  } catch(e) { console.error('✗ Account hash error:', e.message); }
  return null;
}

// Get user preferences for streaming connection
async function getUserPreferences() {
  const token = await getSchwabToken();
  if (!token) return null;
  try {
    const r = await fetch('https://api.schwabapi.com/trader/v1/userPreference', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const prefs = await r.json();
    if (prefs.streamerInfo) {
      schwabTokens.streamer_socket_url = prefs.streamerInfo[0]?.streamerSocketUrl;
      schwabTokens.customer_id = prefs.streamerInfo[0]?.schwabClientCustomerId;
      console.log('✓ Got streamer info:', schwabTokens.streamer_socket_url);
      return prefs;
    }
  } catch(e) { console.error('✗ User prefs error:', e.message); }
  return null;
}

// Refresh token every 25 min
setInterval(async () => { 
  if (schwabTokens.refresh_token) await refreshSchwabToken(); 
}, 25 * 60 * 1000);

// ══════════════════════════════════════════════════════════════════════════════
// SYMBOLS TO TRADE
// ══════════════════════════════════════════════════════════════════════════════
const SCALP_SYMBOLS = [
  // Large caps - high liquidity
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META',
  // ETFs - extremely liquid
  'SPY', 'QQQ', 'IWM',
  // High volatility - more scalping opportunities
  'TSLA', 'COIN', 'PLTR',
  // Additional volatile stocks
  'AMD', 'MARA', 'RIOT', 'SOFI', 'HOOD', 'RIVN', 'LCID'
];

const OPTIONS_SYMBOLS = [
  'SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'TSLA'
];

// ══════════════════════════════════════════════════════════════════════════════
// REAL-TIME PRICE CACHE (updated by WebSocket)
// ══════════════════════════════════════════════════════════════════════════════
let priceCache = {};
let tickHistory = {}; // Last N ticks per symbol for micro-momentum
let lastCacheUpdate = null;
let dataSource = 'none';

// Initialize tick history
SCALP_SYMBOLS.forEach(sym => { tickHistory[sym] = []; });

// ══════════════════════════════════════════════════════════════════════════════
// SCHWAB WEBSOCKET STREAMING
// ══════════════════════════════════════════════════════════════════════════════
let streamerWs = null;
let streamerConnected = false;
let streamerRequestId = 0;

function getNextRequestId() {
  return ++streamerRequestId;
}

async function connectStreamer() {
  if (!schwabReady()) {
    console.log('⚠ Cannot connect streamer - Schwab not authenticated');
    return false;
  }

  const prefs = await getUserPreferences();
  if (!prefs || !schwabTokens.streamer_socket_url) {
    console.log('⚠ Cannot get streamer URL');
    return false;
  }

  return new Promise((resolve) => {
    try {
      console.log('🔌 Connecting to Schwab streamer...');
      streamerWs = new WebSocket(schwabTokens.streamer_socket_url);

      streamerWs.on('open', async () => {
        console.log('🔌 WebSocket connected, logging in...');
        
        // Send login request
        const loginRequest = {
          requests: [{
            requestid: getNextRequestId().toString(),
            service: 'ADMIN',
            command: 'LOGIN',
            SchwabClientCustomerId: schwabTokens.customer_id,
            SchwabClientCorrelId: `soca-${Date.now()}`,
            parameters: {
              Authorization: schwabTokens.access_token,
              SchwabClientChannel: 'client',
              SchwabClientFunctionId: 'soca-bot'
            }
          }]
        };
        
        streamerWs.send(JSON.stringify(loginRequest));
      });

      streamerWs.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          handleStreamerMessage(msg);
        } catch(e) {
          console.error('✗ Streamer parse error:', e.message);
        }
      });

      streamerWs.on('close', () => {
        console.log('🔌 Streamer disconnected');
        streamerConnected = false;
        // Reconnect after 5 seconds
        setTimeout(() => {
          if (botRunning) connectStreamer();
        }, 5000);
      });

      streamerWs.on('error', (err) => {
        console.error('✗ Streamer error:', err.message);
        resolve(false);
      });

      // Resolve after 5 seconds if connected
      setTimeout(() => resolve(streamerConnected), 5000);

    } catch(e) {
      console.error('✗ Streamer connection error:', e.message);
      resolve(false);
    }
  });
}

function handleStreamerMessage(msg) {
  // Handle login response
  if (msg.response) {
    for (const resp of msg.response) {
      if (resp.service === 'ADMIN' && resp.command === 'LOGIN') {
        if (resp.content?.code === 0) {
          console.log('✓ Streamer logged in successfully');
          streamerConnected = true;
          subscribeToQuotes();
        } else {
          console.error('✗ Streamer login failed:', resp.content);
        }
      }
    }
  }

  // Handle data updates
  if (msg.data) {
    for (const item of msg.data) {
      if (item.service === 'LEVELONE_EQUITIES') {
        processQuoteUpdate(item.content);
      }
      if (item.service === 'TIMESALE_EQUITY') {
        processTimeSale(item.content);
      }
    }
  }
}

function subscribeToQuotes() {
  if (!streamerConnected || !streamerWs) return;

  console.log(`📊 Subscribing to ${SCALP_SYMBOLS.length} symbols...`);

  // Subscribe to Level 1 quotes
  const quoteRequest = {
    requests: [{
      requestid: getNextRequestId().toString(),
      service: 'LEVELONE_EQUITIES',
      command: 'SUBS',
      SchwabClientCustomerId: schwabTokens.customer_id,
      SchwabClientCorrelId: `soca-quotes-${Date.now()}`,
      parameters: {
        keys: SCALP_SYMBOLS.join(','),
        fields: '0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52'
      }
    }]
  };
  
  streamerWs.send(JSON.stringify(quoteRequest));

  // Subscribe to Time & Sales for tick-by-tick
  const timeSaleRequest = {
    requests: [{
      requestid: getNextRequestId().toString(),
      service: 'TIMESALE_EQUITY',
      command: 'SUBS',
      SchwabClientCustomerId: schwabTokens.customer_id,
      SchwabClientCorrelId: `soca-timesale-${Date.now()}`,
      parameters: {
        keys: SCALP_SYMBOLS.join(','),
        fields: '0,1,2,3,4'
      }
    }]
  };

  streamerWs.send(JSON.stringify(timeSaleRequest));

  // Set Quality of Service to Express (500ms)
  const qosRequest = {
    requests: [{
      requestid: getNextRequestId().toString(),
      service: 'ADMIN',
      command: 'QOS',
      SchwabClientCustomerId: schwabTokens.customer_id,
      SchwabClientCorrelId: `soca-qos-${Date.now()}`,
      parameters: {
        qoslevel: '0' // Express = 500ms
      }
    }]
  };

  streamerWs.send(JSON.stringify(qosRequest));
}

function processQuoteUpdate(content) {
  if (!Array.isArray(content)) return;
  
  for (const quote of content) {
    const sym = quote.key;
    if (!sym) continue;

    const prev = priceCache[sym] || {};
    
    priceCache[sym] = {
      ticker: sym,
      lastPrice: quote['3'] || quote['LAST_PRICE'] || prev.lastPrice,
      bidPrice: quote['1'] || quote['BID_PRICE'] || prev.bidPrice,
      askPrice: quote['2'] || quote['ASK_PRICE'] || prev.askPrice,
      bidSize: quote['4'] || quote['BID_SIZE'] || prev.bidSize,
      askSize: quote['5'] || quote['ASK_SIZE'] || prev.askSize,
      volume: quote['8'] || quote['TOTAL_VOLUME'] || prev.volume,
      openPrice: quote['28'] || quote['OPEN_PRICE'] || prev.openPrice,
      highPrice: quote['12'] || quote['HIGH_PRICE'] || prev.highPrice,
      lowPrice: quote['11'] || quote['LOW_PRICE'] || prev.lowPrice,
      closePrice: quote['15'] || quote['CLOSE_PRICE'] || prev.closePrice,
      netChange: quote['18'] || quote['NET_CHANGE'] || prev.netChange,
      netChangePct: quote['29'] || quote['NET_CHANGE_PCT'] || prev.netChangePct,
      timestamp: Date.now()
    };

    dataSource = 'schwab-stream';
    lastCacheUpdate = new Date().toISOString();
  }
}

function processTimeSale(content) {
  if (!Array.isArray(content)) return;
  
  for (const sale of content) {
    const sym = sale.key;
    if (!sym || !tickHistory[sym]) continue;

    const tick = {
      price: sale['2'] || sale['LAST_PRICE'],
      size: sale['3'] || sale['LAST_SIZE'],
      time: sale['1'] || Date.now()
    };

    if (tick.price) {
      tickHistory[sym].push(tick);
      // Keep last 100 ticks
      if (tickHistory[sym].length > 100) {
        tickHistory[sym].shift();
      }

      // Update last price
      if (priceCache[sym]) {
        priceCache[sym].lastPrice = tick.price;
        priceCache[sym].timestamp = Date.now();
      }

      // Trigger scalp check on every tick when bot is running
      if (botRunning) {
        checkScalpSignal(sym, tick.price);
      }
    }
  }
}

// Fallback: Poll Schwab quotes API if streaming fails
async function fetchSchwabPrices() {
  const token = await getSchwabToken();
  if (!token) return false;
  try {
    const symsParam = SCALP_SYMBOLS.join('%2C');
    const r = await fetch(
      `https://api.schwabapi.com/marketdata/v1/quotes?symbols=${symsParam}&fields=quote&indicative=false`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    if (!r.ok) return false;
    const d = await r.json();
    
    for (const sym of SCALP_SYMBOLS) {
      const q = d[sym]?.quote;
      if (!q || !q.lastPrice) continue;
      
      priceCache[sym] = {
        ticker: sym,
        lastPrice: q.lastPrice,
        bidPrice: q.bidPrice,
        askPrice: q.askPrice,
        volume: q.totalVolume,
        openPrice: q.openPrice,
        highPrice: q.highPrice,
        lowPrice: q.lowPrice,
        closePrice: q.closePrice,
        netChange: q.netChange,
        netChangePct: q.netPercentChange,
        timestamp: Date.now()
      };
    }
    
    dataSource = 'schwab-poll';
    lastCacheUpdate = new Date().toISOString();
    return true;
  } catch(e) { 
    console.error('✗ Schwab poll error:', e.message); 
    return false; 
  }
}

// Fallback polling every 5s if streaming not connected
setInterval(async () => {
  if (!streamerConnected && schwabReady()) {
    await fetchSchwabPrices();
  }
}, 5000);

// ══════════════════════════════════════════════════════════════════════════════
// HIGH-FREQUENCY SCALPING ENGINE
// ══════════════════════════════════════════════════════════════════════════════
let botRunning = false;
let botPositions = {}; // sym → { qty, avgPrice, entryTime, side }
let botSettings = {
  // Scalping settings - MORE AGGRESSIVE
  scalp_tp_pct: 0.4,      // Take profit at 0.4%
  scalp_sl_pct: 0.3,      // Stop loss at 0.3%
  scalp_pos_pct: 5,       // 5% of account per position ($10k on $200k)
  scalp_max_positions: 8, // Max concurrent positions (was 5)
  
  // Options mean reversion
  opt_rsi_buy: 28,        // Buy calls when RSI < 28
  opt_rsi_sell: 72,       // Buy puts when RSI > 72
  opt_bb_enabled: true,   // Also check Bollinger Bands
  opt_days_to_exp: 30,    // ~30 DTE options
  opt_tp_pct: 30,         // 30% take profit on options
  opt_sl_pct: 25,         // 25% stop loss on options
  opt_risk_pct: 5,        // 5% of account risk per option trade
  
  // General
  enabled_strategies: ['scalp'], // 'scalp', 'options_mr'
};

let tradeLog = [];
let signalLog = [];
let stats = {
  totalTrades: 0,
  wins: 0,
  losses: 0,
  totalPnL: 0,
  todayPnL: 0,
  todayTrades: 0
};

// ──────────────────────────────────────────────────────────────────────────────
// AGGRESSIVE SCALPING SIGNAL DETECTION
// ──────────────────────────────────────────────────────────────────────────────

// Price history for technical indicators
let priceHistory = {}; // sym → [prices] for longer-term indicators
SCALP_SYMBOLS.forEach(sym => { priceHistory[sym] = []; });

// Update price history on each tick
function updatePriceHistory(sym, price) {
  if (!priceHistory[sym]) priceHistory[sym] = [];
  priceHistory[sym].push({ price, time: Date.now() });
  // Keep last 500 prices (~5-10 min of data)
  if (priceHistory[sym].length > 500) priceHistory[sym].shift();
}

// Simple indicators
function calcRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;
  const changes = [];
  for (let i = prices.length - period; i < prices.length; i++) {
    changes.push(prices[i] - prices[i-1]);
  }
  const gains = changes.filter(c => c > 0).reduce((a,b) => a+b, 0) / period;
  const losses = Math.abs(changes.filter(c => c < 0).reduce((a,b) => a+b, 0)) / period;
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

function calcEMA(prices, period) {
  if (prices.length < period) return prices[prices.length - 1];
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a,b) => a+b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcBollingerBands(prices, period = 20) {
  if (prices.length < period) return { upper: prices[prices.length-1] * 1.02, lower: prices[prices.length-1] * 0.98, mid: prices[prices.length-1] };
  const slice = prices.slice(-period);
  const mid = slice.reduce((a,b) => a+b, 0) / period;
  const variance = slice.reduce((sum, p) => sum + Math.pow(p - mid, 2), 0) / period;
  const std = Math.sqrt(variance);
  return { upper: mid + 2 * std, lower: mid - 2 * std, mid };
}

function checkScalpSignal(sym, currentPrice) {
  if (!botSettings.enabled_strategies.includes('scalp')) return;
  if (botPositions[sym]) return; // Already in position
  if (Object.keys(botPositions).length >= botSettings.scalp_max_positions) return;
  
  // Update price history
  updatePriceHistory(sym, currentPrice);
  
  const ticks = tickHistory[sym];
  const history = priceHistory[sym];
  if (!ticks || ticks.length < 5) return; // Reduced from 10 to 5
  
  const prices = history.map(h => h.price);
  
  // ═══════════════════════════════════════════════════════════════════════════
  // STRATEGY 1: Micro-Momentum (relaxed)
  // ═══════════════════════════════════════════════════════════════════════════
  const recent = ticks.slice(-8); // Last 8 ticks
  const oldest = recent[0].price;
  const newest = recent[recent.length - 1].price;
  const momentum = (newest - oldest) / oldest * 100;

  let upTicks = 0, downTicks = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].price > recent[i-1].price) upTicks++;
    else if (recent[i].price < recent[i-1].price) downTicks++;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STRATEGY 2: RSI Oversold Bounce
  // ═══════════════════════════════════════════════════════════════════════════
  const rsi = calcRSI(prices);
  const rsiOversold = rsi < 35; // Buy when oversold
  const rsiRising = prices.length > 3 && prices[prices.length-1] > prices[prices.length-3];

  // ═══════════════════════════════════════════════════════════════════════════
  // STRATEGY 3: Bollinger Band Bounce
  // ═══════════════════════════════════════════════════════════════════════════
  const bb = calcBollingerBands(prices);
  const nearLowerBand = currentPrice < bb.lower * 1.005; // Within 0.5% of lower band
  const bouncingUp = prices.length > 2 && prices[prices.length-1] > prices[prices.length-2];

  // ═══════════════════════════════════════════════════════════════════════════
  // STRATEGY 4: EMA Crossover
  // ═══════════════════════════════════════════════════════════════════════════
  const ema5 = calcEMA(prices, 5);
  const ema13 = calcEMA(prices, 13);
  const emaBullish = ema5 > ema13;
  const priceAboveEma = currentPrice > ema5;

  // ═══════════════════════════════════════════════════════════════════════════
  // STRATEGY 5: Breakout Detection
  // ═══════════════════════════════════════════════════════════════════════════
  let recentHigh = 0;
  if (prices.length >= 20) {
    recentHigh = Math.max(...prices.slice(-20));
  }
  const breakout = recentHigh > 0 && currentPrice > recentHigh * 0.999; // Breaking recent high

  // ═══════════════════════════════════════════════════════════════════════════
  // SIGNAL SCORING - AI ADAPTIVE with NEWS
  // ═══════════════════════════════════════════════════════════════════════════
  let score = 0;
  let reasons = [];
  let strategies = [];
  
  aiMemory.decisionsAnalyzed++;

  // Get current hour for time-based adjustments
  const currentHour = new Date().getHours();
  const hourlyStats = aiMemory.hourlyPerformance[currentHour];
  const hourMultiplier = hourlyStats ? 
    (hourlyStats.wins / (hourlyStats.wins + hourlyStats.losses || 1) > 0.5 ? 1.1 : 0.9) : 1.0;

  // Symbol historical performance
  const symStats = aiMemory.symbolScores[sym];
  const symMultiplier = symStats ?
    (symStats.wins / (symStats.wins + symStats.losses || 1) > 0.5 ? 1.1 : 0.9) : 1.0;

  // Momentum (relaxed: 5+ up ticks instead of 7)
  if (upTicks >= 5 && momentum > 0.01) {
    const baseScore = 30 * aiMemory.weights.momentum;
    score += baseScore;
    reasons.push(`MOM:${upTicks}up`);
    strategies.push('momentum');
  }

  // RSI oversold bounce
  if (rsiOversold && rsiRising) {
    const baseScore = 35 * aiMemory.weights.rsi;
    score += baseScore;
    reasons.push(`RSI:${rsi.toFixed(0)}`);
    strategies.push('rsi');
  }

  // Bollinger bounce
  if (nearLowerBand && bouncingUp) {
    const baseScore = 30 * aiMemory.weights.bb;
    score += baseScore;
    reasons.push('BB:bounce');
    strategies.push('bb');
  }

  // EMA bullish
  if (emaBullish && priceAboveEma) {
    const baseScore = 20 * aiMemory.weights.ema;
    score += baseScore;
    reasons.push('EMA:bull');
    strategies.push('ema');
  }

  // Breakout
  if (breakout) {
    const baseScore = 25 * aiMemory.weights.breakout;
    score += baseScore;
    reasons.push('BREAKOUT');
    strategies.push('breakout');
  }

  // Quick scalp (momentum alone)
  if (upTicks >= 4 && momentum > 0.005 && score < 40) {
    const baseScore = 25 * aiMemory.weights.quick;
    score += baseScore;
    reasons.push('QUICK');
    strategies.push('quick');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NEWS SENTIMENT BOOST
  // ═══════════════════════════════════════════════════════════════════════════
  const newsSentiment = getNewsSentiment(sym);
  if (newsSentiment.hasNews && newsSentiment.sentiment === 'BULLISH') {
    const newsBoost = newsSentiment.score * aiMemory.weights.news;
    score += newsBoost;
    reasons.push(`NEWS:+${newsSentiment.score}`);
    strategies.push('news');
    logThought(`${sym}: News boost +${newsBoost.toFixed(0)} from "${newsSentiment.headlines?.[0]?.slice(0, 40)}..."`);
  } else if (newsSentiment.hasNews && newsSentiment.sentiment === 'BEARISH') {
    // Reduce score on bearish news
    score -= Math.abs(newsSentiment.score) * 0.5;
    reasons.push(`NEWS:${newsSentiment.score}`);
    logThought(`${sym}: News penalty ${newsSentiment.score} - skipping or reducing confidence`);
  }

  // Apply multipliers
  score = score * hourMultiplier * symMultiplier * aiMemory.riskAppetite;

  const signal = {
    sym,
    price: currentPrice,
    momentum: momentum.toFixed(4),
    upTicks,
    downTicks,
    rsi: rsi.toFixed(1),
    direction: null,
    confidence: Math.round(score),
    reasons: reasons.join(' + '),
    strategies,
    newsContext: newsSentiment.hasNews ? newsSentiment.headlines?.[0]?.slice(0, 50) : null
  };

  // ENTRY THRESHOLD: Uses adaptive threshold from AI memory
  const threshold = aiMemory.entryThreshold;
  
  if (score >= threshold) {
    signal.direction = 'LONG';
    signalLog.unshift({ ...signal, time: new Date().toISOString() });
    if (signalLog.length > 100) signalLog.pop();
    
    logThought(`⚡ ENTRY SIGNAL: ${sym} @ $${currentPrice.toFixed(2)} | Score: ${Math.round(score)}/${threshold} | ${reasons.join(' + ')}`);
    executeScalpEntry(sym, currentPrice, signal);
  } else if (score >= threshold * 0.6) {
    // Log near-misses for learning
    signal.direction = 'WATCH';
    signalLog.unshift({ ...signal, time: new Date().toISOString() });
    if (signalLog.length > 100) signalLog.pop();
    
    if (aiMemory.decisionsAnalyzed % 50 === 0) {
      logThought(`👀 WATCHING: ${sym} | Score: ${Math.round(score)}/${threshold} | ${reasons.join(' + ')}`);
    }
  }
}

async function executeScalpEntry(sym, price, signal) {
  const positionValue = ACCOUNT_BALANCE * (botSettings.scalp_pos_pct / 100);
  const qty = Math.floor(positionValue / price);
  
  if (qty < 1) return;

  logThought(`📈 ENTERING: ${sym} @ $${price.toFixed(2)} | ${qty} shares | Reasons: ${signal.reasons}`);

  const result = await placeSchwabOrder(sym, 'BUY', qty, price);
  
  if (result.success || result.simulated) {
    botPositions[sym] = {
      qty,
      avgPrice: price,
      entryTime: Date.now(),
      side: 'LONG',
      tp: price * (1 + botSettings.scalp_tp_pct / 100),
      sl: price * (1 - botSettings.scalp_sl_pct / 100),
      strategies: signal.strategies || [],
      reasons: signal.reasons
    };

    const trade = {
      time: new Date().toISOString(),
      side: 'BUY',
      sym,
      qty,
      price,
      strategy: 'SCALP',
      signal: signal.confidence,
      reasons: signal.reasons,
      strategies: signal.strategies,
      schwab: result
    };
    tradeLog.unshift(trade);
    if (tradeLog.length > 500) tradeLog.pop();
    
    stats.totalTrades++;
    stats.todayTrades++;

    await tg(`📈 *SCALP ENTRY: ${sym}*
${qty} shares @ $${price.toFixed(2)}
Value: $${(qty * price).toFixed(2)}
TP: $${botPositions[sym].tp.toFixed(2)} (+${botSettings.scalp_tp_pct}%)
SL: $${botPositions[sym].sl.toFixed(2)} (-${botSettings.scalp_sl_pct}%)
Signal: ${signal.confidence}% confidence
${result.simulated ? '⚠️ Paper trade' : '✓ Schwab order placed'}`);
  }
}

// Check exits on every price update
function checkScalpExits() {
  for (const [sym, pos] of Object.entries(botPositions)) {
    if (!pos || pos.strategy === 'OPTIONS') continue;
    
    const current = priceCache[sym]?.lastPrice;
    if (!current) continue;

    let exitReason = null;
    
    if (current >= pos.tp) {
      exitReason = `TAKE PROFIT (+${botSettings.scalp_tp_pct}%)`;
    } else if (current <= pos.sl) {
      exitReason = `STOP LOSS (-${botSettings.scalp_sl_pct}%)`;
    }

    if (exitReason) {
      executeScalpExit(sym, current, exitReason);
    }
  }
}

async function executeScalpExit(sym, price, reason) {
  const pos = botPositions[sym];
  if (!pos) return;

  const pnl = (price - pos.avgPrice) * pos.qty;
  const pnlPct = (price - pos.avgPrice) / pos.avgPrice * 100;
  const holdTime = ((Date.now() - pos.entryTime) / 1000).toFixed(1);

  logThought(`📉 EXITING: ${sym} @ $${price.toFixed(2)} | P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | ${reason}`);

  const result = await placeSchwabOrder(sym, 'SELL', pos.qty, price);

  const trade = {
    time: new Date().toISOString(),
    side: 'SELL',
    sym,
    qty: pos.qty,
    price,
    pnl: pnl.toFixed(2),
    pnlPct: pnlPct.toFixed(3),
    reason,
    holdTime: `${holdTime}s`,
    strategy: 'SCALP',
    strategies: pos.strategies || [],
    reasons: pos.reasons || '',
    schwab: result
  };
  tradeLog.unshift(trade);
  if (tradeLog.length > 500) tradeLog.pop();

  stats.totalPnL += pnl;
  stats.todayPnL += pnl;
  if (pnl > 0) stats.wins++;
  else stats.losses++;
  
  // AI LEARNING: Update memory based on trade outcome
  learnFromTrade(trade);

  delete botPositions[sym];

  const emoji = pnl >= 0 ? '✅' : '❌';
  await tg(`${emoji} *SCALP EXIT: ${sym}*
${pos.qty} shares @ $${price.toFixed(2)}
P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(3)}%)
Hold time: ${holdTime}s
Reason: ${reason}
${result.simulated ? '⚠️ Paper trade' : '✓ Schwab order placed'}`);
}

// Check exits frequently
setInterval(checkScalpExits, 100); // Every 100ms

// ══════════════════════════════════════════════════════════════════════════════
// SCHWAB ORDER EXECUTION
// ══════════════════════════════════════════════════════════════════════════════
// SIMULATION MODE - Set to false to enable real trading
const SIMULATION_MODE = true;

async function placeSchwabOrder(sym, side, qty, price) {
  // Force simulation mode - no real orders
  if (SIMULATION_MODE) {
    console.log(`📝 SIMULATED: ${side} ${qty} ${sym} @ $${price.toFixed(2)}`);
    return { simulated: true, side, sym, qty, price };
  }

  const token = await getSchwabToken();
  const hash = await getSchwabAccountHash();
  
  if (!token || !hash) {
    console.log('⚠ Schwab not connected — simulating order');
    return { simulated: true, side, sym, qty, price };
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
      const location = r.headers.get('location');
      const orderId = location?.split('/').pop();
      console.log(`✓ Schwab order placed: ${side} ${qty} ${sym} | Order ID: ${orderId}`);
      return { success: true, orderId, status: r.status };
    } else {
      const err = await r.text();
      console.error(`✗ Schwab order failed: ${r.status}`, err);
      return { success: false, error: err, simulated: true };
    }
  } catch(e) {
    console.error('✗ Schwab order error:', e.message);
    return { success: false, error: e.message, simulated: true };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// OPTIONS MEAN REVERSION (Coming soon)
// ══════════════════════════════════════════════════════════════════════════════
// TODO: Implement options chain fetching and trading
// RSI < 28 + below BB lower → buy ATM calls, 30 DTE
// RSI > 72 + above BB upper → buy ATM puts, 30 DTE

// ══════════════════════════════════════════════════════════════════════════════
// MARKET HOURS CHECK
// ══════════════════════════════════════════════════════════════════════════════
function isMarketOpen() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const h = et.getHours(), m = et.getMinutes(), dow = et.getDay();
  const mins = h * 60 + m;
  // 9:30 AM = 570 mins, 4:00 PM = 960 mins
  return dow >= 1 && dow <= 5 && mins >= 570 && mins < 960;
}

function getMarketStatus() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const h = et.getHours(), m = et.getMinutes(), dow = et.getDay();
  const mins = h * 60 + m;
  
  if (dow === 0 || dow === 6) return 'WEEKEND';
  if (mins < 570) return 'PRE-MARKET';
  if (mins >= 960) return 'AFTER-HOURS';
  return 'OPEN';
}

// ══════════════════════════════════════════════════════════════════════════════
// API ROUTES
// ══════════════════════════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({
    status: 'SOCA HFT Engine Running',
    version: '2.0.0',
    dataSource,
    schwabConnected: schwabReady(),
    streamerConnected,
    lastCacheUpdate,
    cachedSymbols: Object.keys(priceCache).length,
    botRunning,
    marketStatus: getMarketStatus(),
    openPositions: Object.keys(botPositions).length,
    stats
  });
});

// Schwab OAuth — Step 1
app.get('/auth', (req, res) => {
  const url = `https://api.schwabapi.com/v1/oauth/authorize?client_id=${SCHWAB_KEY}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code`;
  res.redirect(url);
});

// Schwab OAuth — Step 2
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
      await connectStreamer();
      
      await tg(`🟢 *SOCA HFT Bot Connected!*
Account: ${schwabTokens.account_hash?.slice(0,8)}...
Streamer: ${streamerConnected ? '✓ Connected' : '⚠️ Fallback to polling'}
Symbols: ${SCALP_SYMBOLS.length}
Ready to scalp!`);

      res.send(`
        <html>
        <body style="font-family:system-ui;background:#0a0a0a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
          <div style="text-align:center">
            <h1 style="color:#00ff88">✓ SOCA Connected!</h1>
            <p>Streaming: ${streamerConnected ? 'Active' : 'Polling mode'}</p>
            <p style="color:#666">You can close this tab</p>
          </div>
        </body>
        </html>
      `);
    } else {
      res.status(400).send('Auth failed: ' + JSON.stringify(d));
    }
  } catch(e) {
    res.status(500).send('Error: ' + e.message);
  }
});

// Get quotes
app.get('/quote/:symbols', (req, res) => {
  const requested = [...new Set(req.params.symbols.toUpperCase().split(','))];
  const tickers = requested.map(sym => priceCache[sym] || null).filter(Boolean);
  res.json({ 
    tickers, 
    dataSource, 
    streamerConnected,
    lastUpdate: lastCacheUpdate 
  });
});

// Bot control
app.post('/bot/start', async (req, res) => {
  if (req.body.settings) {
    botSettings = { ...botSettings, ...req.body.settings };
  }
  
  botRunning = true;
  
  // Connect streamer if not already
  if (!streamerConnected && schwabReady()) {
    await connectStreamer();
  }
  
  console.log('▶ Bot started');
  await tg(`▶️ *SOCA HFT Bot STARTED*
Symbols: ${SCALP_SYMBOLS.join(', ')}
Scalp TP: ${botSettings.scalp_tp_pct}% | SL: ${botSettings.scalp_sl_pct}%
Position size: ${botSettings.scalp_pos_pct}% ($${(ACCOUNT_BALANCE * botSettings.scalp_pos_pct / 100).toLocaleString()})
Max positions: ${botSettings.scalp_max_positions}
Data: ${dataSource}
Streamer: ${streamerConnected ? '✓ Real-time' : '⚠️ Polling'}`);

  res.json({ ok: true, botRunning, settings: botSettings, streamerConnected });
});

app.post('/bot/stop', async (req, res) => {
  botRunning = false;
  
  console.log('⏹ Bot stopped');
  const winRate = stats.totalTrades > 0 ? (stats.wins / stats.totalTrades * 100).toFixed(1) : 0;
  
  await tg(`⏹️ *SOCA Bot STOPPED*
Trades: ${stats.totalTrades} (${stats.wins}W/${stats.losses}L)
Win rate: ${winRate}%
Total P&L: ${stats.totalPnL >= 0 ? '+' : ''}$${stats.totalPnL.toFixed(2)}
Open positions: ${Object.keys(botPositions).length}`);

  res.json({ ok: true, botRunning, stats });
});

app.get('/bot/status', (req, res) => {
  const positions = Object.entries(botPositions).map(([sym, pos]) => {
    const cur = priceCache[sym]?.lastPrice || pos.avgPrice;
    const pnl = (cur - pos.avgPrice) * pos.qty;
    const pnlPct = (cur - pos.avgPrice) / pos.avgPrice * 100;
    return { 
      sym, 
      qty: pos.qty, 
      avgPrice: pos.avgPrice, 
      currentPrice: cur, 
      pnl: +pnl.toFixed(2), 
      pnlPct: +pnlPct.toFixed(3),
      tp: pos.tp,
      sl: pos.sl,
      holdTime: ((Date.now() - pos.entryTime) / 1000).toFixed(1) + 's',
      strategies: pos.strategies,
      reasons: pos.reasons
    };
  });

  res.json({ 
    botRunning, 
    positions, 
    tradeLog: tradeLog.slice(0, 100),
    signalLog: signalLog.slice(0, 50),
    stats,
    settings: botSettings, 
    dataSource, 
    streamerConnected,
    marketStatus: getMarketStatus(),
    schwabConnected: schwabReady(),
    // AI Learning Data
    ai: {
      thoughts: aiThoughts.slice(0, 50),
      memory: aiMemory,
      recentNews: recentNews.slice(0, 20)
    }
  });
});

app.post('/bot/settings', (req, res) => {
  botSettings = { ...botSettings, ...req.body };
  res.json({ ok: true, settings: botSettings });
});

app.post('/bot/closeall', async (req, res) => {
  const syms = Object.keys(botPositions);
  let closed = 0;
  
  for (const sym of syms) {
    const pos = botPositions[sym];
    const price = priceCache[sym]?.lastPrice || pos.avgPrice;
    await executeScalpExit(sym, price, req.body.reason || 'MANUAL CLOSE ALL');
    closed++;
  }
  
  res.json({ ok: true, closed });
});

// Debug
app.get('/debug/:sym', (req, res) => {
  const sym = req.params.sym.toUpperCase();
  res.json({ 
    sym, 
    cached: priceCache[sym] || null, 
    ticks: tickHistory[sym]?.slice(-20) || [],
    position: botPositions[sym] || null,
    dataSource, 
    streamerConnected,
    lastUpdate: lastCacheUpdate 
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    ok: true, 
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    streamerConnected,
    schwabConnected: schwabReady()
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// STARTUP
// ══════════════════════════════════════════════════════════════════════════════
app.listen(PORT, async () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║              SOCA HFT SCALPING ENGINE v2.0                   ║
╠══════════════════════════════════════════════════════════════╣
║  Port: ${PORT}                                                    ║
║  Schwab: ${SCHWAB_KEY ? '✓ Key configured' : '✗ MISSING KEY'}                              ║
║  Telegram: ${TG_TOKEN ? '✓ Configured' : '⚠️ Not configured'}                              ║
║  Symbols: ${SCALP_SYMBOLS.length} stocks                                        ║
║  Scalp: ${botSettings.scalp_tp_pct}% TP / ${botSettings.scalp_sl_pct}% SL                                    ║
╚══════════════════════════════════════════════════════════════╝
  `);

  // Initial price fetch
  if (SCHWAB_KEY) {
    await fetchSchwabPrices();
  }
});
