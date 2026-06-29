// Binance trading client — DEMO (testnet) by default, switchable to LIVE.
//
// ── The ONLY thing you change to go live ──────────────────────────
//   set env var:  BINANCE_ENV=live
//   and provide live keys. Everything else (orders, signing) is identical,
//   because Binance testnet and mainnet share the exact same API.
//
// ── Get DEMO keys ─────────────────────────────────────────────────
//   https://testnet.binance.vision/  -> log in with GitHub
//   -> "Generate HMAC_SHA256 Key" -> copy API key + secret.
//
// ── Get LIVE keys (later) ─────────────────────────────────────────
//   binance.com -> API Management -> create key (enable Spot trading).
//
// ── Run ───────────────────────────────────────────────────────────
//   export BINANCE_API_KEY="...testnet key..."
//   export BINANCE_API_SECRET="...testnet secret..."
//   node Binance.demo.ac.js

const crypto = require('crypto');
const TI = require('technicalindicators');
const { evaluateSpotStrategy } = require('./strategyFunction');

// --- environment switch -------------------------------------------------
const ENV = process.env.BINANCE_ENV || 'demo'; // 'demo' | 'live'

const CONFIG = {
  demo: { base: 'https://testnet.binance.vision' },
  live: { base: 'https://api.binance.com' },
};


// zcsKFWsJZq64FlhP51y84f1vwu0pCNQhVKRnTuk4NuO7cKVNEiJ0io9gERvToLOX

// clLlSx5Ei7TcjUpBGeveYFkfrDndbhB6DzdMTzo4VMTIPxTtZnX1U1GxjpHtoxFw
const BASE = CONFIG[ENV].base;
const API_KEY = `pq9qs5P9gkArmILGduQuKB74uJ4qwMjQNI0zAwB9JKM3WqqsWAonmkYGbfNFMdo7`;
const API_SECRET = `OzNAWOSou1ZIjLUbQAcAGq7UN1owXXakijcbaQf2gVQMc0fFovCuoRuFZaoNhzES`;

if (!API_KEY || !API_SECRET) {
  throw new Error('Missing BINANCE_API_KEY / BINANCE_API_SECRET env vars');
}
console.log(`Binance client running in ${ENV.toUpperCase()} mode -> ${BASE}`);

// --- low-level signed request ------------------------------------------
// Binance "signed" endpoints (orders, account) require:
//   1. a timestamp
//   2. an HMAC-SHA256 signature of the query string using your API secret
//   3. the API key in the X-MBX-APIKEY header
function sign(queryString) {
  return crypto.createHmac('sha256', API_SECRET).update(queryString).digest('hex');
}

// Binance rejects requests whose timestamp drifts past recvWindow. Sync to the
// server clock once and apply the offset to every signed request.
let _timeOffset = null;
async function syncTime() {
  const r = await (await fetch(`${BASE}/api/v3/time`)).json();
  _timeOffset = r.serverTime - Date.now();
  return _timeOffset;
}

async function signedRequest(method, path, params = {}) {
  if (_timeOffset === null) await syncTime();
  const query = new URLSearchParams({
    ...params,
    timestamp: Date.now() + _timeOffset,
    recvWindow: 10000,
  }).toString();

  const signature = sign(query);
  const url = `${BASE}${path}?${query}&signature=${signature}`;

  const res = await fetch(url, {
    method,
    headers: { 'X-MBX-APIKEY': API_KEY },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Binance ${res.status}: ${data.msg || JSON.stringify(data)} (code ${data.code})`);
  }
  return data;
}

// --- public (unsigned) market data --------------------------------------
// Market data comes from the REAL market via data-api.binance.vision (public,
// NOT geo-restricted, has ALL spot coins) so indicators work for every listed
// coin and from cloud hosts. Account/orders still use BASE (testnet/live).
const DATA = process.env.BINANCE_DATA || 'https://data-api.binance.vision';

// Testnet price (matches the trading venue) — used by order monitors (executor).
async function getPrice(symbol = 'BTCUSDT') {
  const res = await fetch(`${BASE}/api/v3/ticker/price?symbol=${symbol}`);
  return (await res.json()).price;
}

// Real-market price (data-api) — for scanners/audit that use real prices.
async function getMarketPrice(symbol = 'BTCUSDT') {
  const res = await fetch(`${DATA}/api/v3/ticker/price?symbol=${symbol}`);
  return (await res.json()).price;
}

// Candlestick (kline) data — your chart (REAL market via data-api).
//   interval: '1m','5m','15m','1h','4h','1d', ...
//   limit:    how many candles (max 1000). 10 days of 1h = 240.
async function getKlines(symbol = 'BTCUSDT', interval = '1h', limit = 240) {
  const url = `${DATA}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance ${res.status}: ${await res.text()}`);
  const raw = await res.json();

  // each candle is an array -> map to readable objects
  return raw.map(k => ({
    openTime: new Date(k[0]),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    closeTime: new Date(k[6]),
  }));
}

// --- indicators (computed from Binance candles) ------------------------
// Binance does NOT serve EMA/RSI — we fetch closes and calculate them.

// RSI — momentum oscillator (0-100). >70 overbought, <30 oversold.
//   period 14 is standard. Returns the LATEST value by default.
async function getRSI(symbol = 'BTCUSDT', interval = '1h', period = 14) {
  const candles = await getKlines(symbol, interval, period + 100); // extra history for accuracy
  const values = TI.RSI.calculate({ period, values: candles.map(c => c.close) });
  return values.at(-1); // most recent RSI
}

// EMA — exponential moving average (trend). e.g. period 50 or 200.
//   Returns the LATEST value by default.
async function getEMA(symbol = 'BTCUSDT', interval = '1h', period = 50) {
  const candles = await getKlines(symbol, interval, period + 200); // EMA needs long history
  const values = TI.EMA.calculate({ period, values: candles.map(c => c.close) });
  return values.at(-1); // most recent EMA
}

// --- price structure (swings, support/resistance, last candle) ---------

// Detect pivots: a swing HIGH is a candle whose high is the highest within
// `window` bars on BOTH sides (a local peak); a swing LOW is a local trough.
function findPivots(candles, window = 3) {
  const highs = [], lows = [];
  for (let i = window; i < candles.length - window; i++) {
    const h = candles[i].high, l = candles[i].low;
    let isHigh = true, isLow = true;
    for (let j = i - window; j <= i + window; j++) {
      if (j === i) continue;
      if (candles[j].high >= h) isHigh = false;
      if (candles[j].low <= l) isLow = false;
    }
    if (isHigh) highs.push({ price: h, time: candles[i].openTime });
    if (isLow) lows.push({ price: l, time: candles[i].openTime });
  }
  return { highs, lows };
}

// Pure helper: derive structure from an array of candles.
function structureFrom(candles, window = 3) {
  const closed = candles.slice(0, -1);   // drop the still-forming candle
  const last = closed.at(-1);
  const price = last.close;
  const { highs, lows } = findPivots(closed, window);

  // most recent swing pivot on each side
  const swingHigh = highs.at(-1) || null;
  const swingLow = lows.at(-1) || null;

  // nearest resistance = lowest pivot high ABOVE price
  const resistance = highs.filter(h => h.price > price).sort((a, b) => a.price - b.price)[0] || null;
  // nearest support = highest pivot low BELOW price
  const support = lows.filter(l => l.price < price).sort((a, b) => b.price - a.price)[0] || null;

  return {
    lastClosed: {
      openTime: last.openTime,
      open: last.open,
      close: last.close,
      high: last.high,
      low: last.low,
      volume: last.volume,
      bullish: last.close >= last.open, // green vs red candle
    },
    swingHigh: swingHigh ? swingHigh.price : null,
    swingLow: swingLow ? swingLow.price : null,
    resistance: resistance ? resistance.price : null,
    support: support ? support.price : null,
  };
}

// 24h rolling stats for the coin: volume, price change %, high/low (REAL market).
async function get24h(symbol = 'BTCUSDT') {
  const res = await fetch(`${DATA}/api/v3/ticker/24hr?symbol=${symbol}`);
  if (!res.ok) throw new Error(`Binance ${res.status}: ${await res.text()}`);
  return res.json();
}

// Just the price structure (swings, S/R, last closed candle, volume).
async function getMarketStructure(symbol = 'BTCUSDT', interval = '1h', window = 3) {
  const candles = await getKlines(symbol, interval, 300);
  return { symbol, interval, ...structureFrom(candles, window) };
}

// Convenience: indicators + price structure in one call.
async function getIndicators(symbol = 'BTCUSDT', interval = '1h') {
  const [candles, stats] = await Promise.all([
    getKlines(symbol, interval, 300),
    get24h(symbol),
  ]);
  const close = candles.map(c => c.close);
  return {
    symbol,
    interval,
    price: close.at(-1),
    rsi14: TI.RSI.calculate({ period: 14, values: close }).at(-1),
    ema9: TI.EMA.calculate({ period: 9, values: close }).at(-1),
    ema21: TI.EMA.calculate({ period: 21, values: close }).at(-1),
    volume24h: parseFloat(stats.volume),       // 24h volume in the coin (e.g. LINK)
    quoteVolume24h: parseFloat(stats.quoteVolume), // 24h volume in USDT
    priceChangePercent24h: parseFloat(stats.priceChangePercent),
    ...structureFrom(candles), // swingHigh/Low, support, resistance, lastClosed
  };
}

// --- account ------------------------------------------------------------
// Your balances. On testnet you start with fake funds (USDT, BTC, etc.).
async function getAccount() {
  return signedRequest('GET', '/api/v3/account');
}

async function getBalances() {
  const acct = await getAccount();
  return acct.balances.filter(b => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0);
}

// --- orders -------------------------------------------------------------
// MARKET order: buy/sell immediately at current price.
//   side = 'BUY' | 'SELL'
//   quantity = amount of the BASE asset (e.g. BTC in BTCUSDT)
async function marketOrder(symbol, side, quantity) {
  return signedRequest('POST', '/api/v3/order', {
    symbol,
    side,
    type: 'MARKET',
    quantity,
  });
}

// LIMIT order: buy/sell only at (or better than) a price you set.
async function limitOrder(symbol, side, quantity, price) {
  return signedRequest('POST', '/api/v3/order', {
    symbol,
    side,
    type: 'LIMIT',
    timeInForce: 'GTC', // good-til-cancelled
    quantity,
    price,
  });
}

async function getOpenOrders(symbol) {
  return signedRequest('GET', '/api/v3/openOrders', symbol ? { symbol } : {});
}

async function cancelOrder(symbol, orderId) {
  return signedRequest('DELETE', '/api/v3/order', { symbol, orderId });
}

// Query a single order's current status.
async function getOrder(symbol, orderId) {
  return signedRequest('GET', '/api/v3/order', { symbol, orderId });
}

// Full order history for a symbol (open, filled, cancelled).
async function getAllOrders(symbol, limit = 20) {
  return signedRequest('GET', '/api/v3/allOrders', { symbol, limit });
}

// Your actual executed trades (fills) for a symbol.
async function getMyTrades(symbol, limit = 20) {
  return signedRequest('GET', '/api/v3/myTrades', { symbol, limit });
}

// --- exchange rules + quantity rounding --------------------------------
// Every symbol has filters (step size, min notional). Orders that don't
// match are rejected with LOT_SIZE / MIN_NOTIONAL. This rounds for you.
async function getSymbolInfo(symbol) {
  const res = await fetch(`${BASE}/api/v3/exchangeInfo?symbol=${symbol}`);
  const data = await res.json();
  return data.symbols[0];
}

// Round a quantity DOWN to the symbol's allowed step size.
async function roundQty(symbol, quantity) {
  const info = await getSymbolInfo(symbol);
  const lot = info.filters.find(f => f.filterType === 'LOT_SIZE');
  const step = parseFloat(lot.stepSize);
  const decimals = (lot.stepSize.split('.')[1] || '').replace(/0+$/, '').length;
  const rounded = Math.floor(quantity / step) * step;
  return Number(rounded.toFixed(decimals));
}

// Minimum tradeable "volume" for a coin = the smallest order Binance accepts.
//   minNotional : smallest order VALUE in USDT (the real floor for an order)
//   minQty      : smallest base-asset quantity (LOT_SIZE)
// An order must satisfy BOTH (qty >= minQty AND qty*price >= minNotional).
async function getMinNotional(symbol) {
  const info = await getSymbolInfo(symbol);
  const notional = info.filters.find(f => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL');
  const lot = info.filters.find(f => f.filterType === 'LOT_SIZE');
  return {
    symbol,
    minNotional: notional ? parseFloat(notional.minNotional || notional.notional || 0) : 0,
    minQty: lot ? parseFloat(lot.minQty) : 0,
  };
}

// Round a price to the symbol's tick size (PRICE_FILTER).
async function roundPrice(symbol, price) {
  const info = await getSymbolInfo(symbol);
  const f = info.filters.find(x => x.filterType === 'PRICE_FILTER');
  const tick = parseFloat(f.tickSize);
  const decimals = (f.tickSize.split('.')[1] || '').replace(/0+$/, '').length;
  return Number((Math.round(price / tick) * tick).toFixed(decimals));
}

// Free (available) balance of one asset, as a NUMBER (e.g. USDT for sizing).
async function getFreeBalance(asset = 'USDT') {
  const acct = await getAccount();
  const b = acct.balances.find(x => x.asset === asset);
  return b ? parseFloat(b.free) : 0;
}

// Round a quantity UP to the step size (so a min-notional bump never drops back under).
async function roundQtyUp(symbol, quantity) {
  const info = await getSymbolInfo(symbol);
  const lot = info.filters.find(f => f.filterType === 'LOT_SIZE');
  const step = parseFloat(lot.stepSize);
  const decimals = (lot.stepSize.split('.')[1] || '').replace(/0+$/, '').length;
  return Number((Math.ceil(quantity / step) * step).toFixed(decimals));
}

// Protective OCO SELL: take-profit (limit) + stop-loss (stop-limit) in one order.
// When one side fills, the other is auto-cancelled.
async function ocoSell(symbol, quantity, takeProfit, stopLoss) {
  const tp = await roundPrice(symbol, takeProfit);
  const stopPrice = await roundPrice(symbol, stopLoss);
  const stopLimitPrice = await roundPrice(symbol, stopLoss * 0.999); // limit just below the trigger
  return signedRequest('POST', '/api/v3/order/oco', {
    symbol, side: 'SELL', quantity,
    price: tp, stopPrice, stopLimitPrice, stopLimitTimeInForce: 'GTC',
  });
}

// Realized P&L from your ACTUAL Binance fills (getMyTrades), per symbol.
// Matches buys against sells; only symbols you BOTH bought and sold show a
// realized result. Returns rows + totals. Percentages are PnL / cost-basis.
async function realizedPnL(symbols) {
  const rows = [];
  for (const symbol of symbols) {
    let trades;
    try { trades = await getMyTrades(symbol, 500); } catch { continue; }
    if (!trades.length) continue;

    let buyQty = 0, buyCost = 0, sellQty = 0, sellProceeds = 0, feeUSDT = 0;
    for (const t of trades) {
      const qty = +t.qty, quote = +t.quoteQty;
      if (t.isBuyer) { buyQty += qty; buyCost += quote; } else { sellQty += qty; sellProceeds += quote; }
      if (t.commissionAsset === 'USDT') feeUSDT += +t.commission;
    }
    const matched = Math.min(buyQty, sellQty);
    if (matched <= 0) continue;                       // not a round-trip — skip

    const avgBuy = buyCost / buyQty, avgSell = sellProceeds / sellQty;
    const pnl = matched * (avgSell - avgBuy) - feeUSDT;
    const cost = matched * avgBuy;
    rows.push({ symbol, avgBuy, avgSell, qty: matched, pnl, pct: (pnl / cost) * 100, cost });
  }

  const totalPnl = rows.reduce((s, r) => s + r.pnl, 0);
  const totalCost = rows.reduce((s, r) => s + r.cost, 0);
  const totalPct = totalCost ? (totalPnl / totalCost) * 100 : 0;
  return { rows, totalPnl, totalCost, totalPct };
}

// Pretty-print the realized P&L report.
async function printPnL(symbols) {
  const { rows, totalPnl, totalPct } = await realizedPnL(symbols);
  if (!rows.length) { console.log('No round-trip trades found for those symbols.'); return; }
  console.log('\n══════════ REALIZED P&L (your actual fills) ══════════');
  for (const r of rows) {
    console.log(`${r.symbol.padEnd(10)} buy ${r.avgBuy.toFixed(4)} → sell ${r.avgSell.toFixed(4)}  ` +
      `PnL ${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(2)} USDT  (${r.pct >= 0 ? '+' : ''}${r.pct.toFixed(2)}%)`);
  }
  console.log('──────────────────────────────────────────────────────');
  console.log(`TOTAL  ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} USDT  (${totalPct >= 0 ? '+' : ''}${totalPct.toFixed(2)}% on cost)`);
  console.log('══════════════════════════════════════════════════════\n');
}

// Cancel every open order on the account (frees coins locked by OCO/limits).
async function cancelAllOpenOrders() {
  const open = await getOpenOrders();
  const seen = new Set();
  for (const o of open) {
    const key = `${o.symbol}:${o.orderId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try { await cancelOrder(o.symbol, o.orderId); }
    catch (e) { /* sibling OCO leg already gone */ }
  }
  return open.length;
}

// If USDT balance is below `minUsdt`, sell ALL holdings back to USDT.
// Only sells assets that have a TRADING USDT pair on this venue and clear the
// minimum order value; dust and pairs that don't exist are skipped.
async function liquidateToUSDT({ minUsdt = 100, dryRun = false } = {}) {
  const before = await getFreeBalance('USDT');
  console.log(`USDT free: ${before.toFixed(2)}  (threshold ${minUsdt})`);
  if (before >= minUsdt) {
    console.log('Balance is fine — nothing sold.');
    return { sold: [], before, after: before };
  }
  console.log('Balance low → liquidating holdings to USDT…');

  // free up coins locked in open orders first
  if (!dryRun) await cancelAllOpenOrders();

  // Build all symbol metadata (pair, step size, min notional) from ONE
  // exchangeInfo fetch — avoids hundreds of per-asset calls.
  const info = await (await fetch(`${BASE}/api/v3/exchangeInfo`)).json();
  const meta = new Map();   // baseAsset -> { symbol, step, decimals, minNotional }
  for (const s of info.symbols) {
    if (!(s.quoteAsset === 'USDT' && s.status === 'TRADING' && s.isSpotTradingAllowed)) continue;
    const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
    const not = s.filters.find(f => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL');
    meta.set(s.baseAsset, {
      symbol: s.symbol,
      step: parseFloat(lot.stepSize),
      decimals: (lot.stepSize.split('.')[1] || '').replace(/0+$/, '').length,
      minNotional: not ? parseFloat(not.minNotional || not.notional || 0) : 0,
    });
  }
  const prices = new Map((await (await fetch(`${BASE}/api/v3/ticker/price`)).json()).map(p => [p.symbol, parseFloat(p.price)]));

  const sold = [];
  for (const b of await getBalances()) {
    const asset = b.asset;
    const free = parseFloat(b.free);
    if (asset === 'USDT' || free <= 0) continue;
    const m = meta.get(asset);
    if (!m) continue;                               // no USDT pair on this venue
    const price = prices.get(m.symbol);
    if (!price) continue;
    const qty = Number((Math.floor(free / m.step) * m.step).toFixed(m.decimals));
    if (qty <= 0 || qty * price < m.minNotional) continue; // dust — can't sell
    const symbol = m.symbol;
    if (dryRun) { console.log(`[dry] sell ${qty} ${asset} (~${(qty * price).toFixed(2)} USDT)`); sold.push({ asset, qty, usdt: qty * price }); continue; }
    try {
      const o = await marketOrder(symbol, 'SELL', qty);
      const got = parseFloat(o.cummulativeQuoteQty);
      sold.push({ asset, qty, usdt: got });
      console.log(`sold ${qty} ${asset} → ${got.toFixed(2)} USDT`);
    } catch (e) { console.warn(`skip ${asset}: ${e.message}`); }
  }

  const after = await getFreeBalance('USDT');
  console.log(`\nDone. Sold ${sold.length} assets. USDT ${before.toFixed(2)} → ${after.toFixed(2)} (+${(after - before).toFixed(2)})`);
  return { sold, before, after };
}

// Sell every coin you BOUGHT TODAY (closes today's purchases at market).
// Looks at your real fills: an asset qualifies if it has a BUY filled today,
// then sells the quantity you currently hold. Cancels open orders first so
// coins locked in OCO/limit orders can be sold.
async function sellBoughtToday({ dryRun = false } = {}) {
  const today = new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD
  if (!dryRun) await cancelAllOpenOrders();

  // symbol metadata from ONE exchangeInfo fetch
  const info = await (await fetch(`${BASE}/api/v3/exchangeInfo`)).json();
  const meta = new Map();
  for (const s of info.symbols) {
    if (!(s.quoteAsset === 'USDT' && s.status === 'TRADING' && s.isSpotTradingAllowed)) continue;
    const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
    const not = s.filters.find(f => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL');
    meta.set(s.baseAsset, {
      symbol: s.symbol,
      step: parseFloat(lot.stepSize),
      decimals: (lot.stepSize.split('.')[1] || '').replace(/0+$/, '').length,
      minNotional: not ? parseFloat(not.minNotional || not.notional || 0) : 0,
    });
  }
  const prices = new Map((await (await fetch(`${BASE}/api/v3/ticker/price`)).json()).map(p => [p.symbol, parseFloat(p.price)]));

  const sold = [];
  for (const b of await getBalances()) {
    const asset = b.asset;
    const free = parseFloat(b.free);
    if (asset === 'USDT' || free <= 0) continue;
    const m = meta.get(asset);
    if (!m) continue;
    const price = prices.get(m.symbol);
    if (!price) continue;

    // did we BUY this today?
    let trades;
    try { trades = await getMyTrades(m.symbol, 100); } catch { continue; }
    const boughtToday = trades.some(t => t.isBuyer && new Date(t.time).toLocaleDateString('en-CA') === today);
    if (!boughtToday) continue;

    const qty = Number((Math.floor(free / m.step) * m.step).toFixed(m.decimals));
    if (qty <= 0 || qty * price < m.minNotional) { console.log(`skip ${asset}: dust (~${(free * price).toFixed(2)} USDT)`); continue; }
    if (dryRun) { console.log(`[dry] sell ${qty} ${asset} (~${(qty * price).toFixed(2)} USDT)`); sold.push({ asset, qty, usdt: qty * price }); continue; }
    try {
      const o = await marketOrder(m.symbol, 'SELL', qty);
      const got = parseFloat(o.cummulativeQuoteQty);
      sold.push({ asset, qty, usdt: got });
      console.log(`sold ${qty} ${asset} → ${got.toFixed(2)} USDT`);
    } catch (e) { console.warn(`skip ${asset}: ${e.message}`); }
  }
  console.log(`\nDone — sold ${sold.length} coin(s) bought today.`);
  return sold;
}

// Place a full trade from a strategy decision object:
//   MARKET BUY (entry) + OCO SELL (take-profit & stop-loss).
//   decision = { symbol, Execute_Trade, ENTRY, 'STOP LOSS', 'TAKE PROFIT', POSITION_SIZE }
//   opts.usdt = fallback budget if POSITION_SIZE is missing.
async function placeTradeFromDecision(decision, { usdt = null } = {}) {
  if (!decision.Execute_Trade) {
    console.log(`⏭️  ${decision.symbol}: ${decision.REASON}`);
    return null;
  }
  const symbol = decision.symbol;
  const entry = decision.ENTRY;
  const sl = decision['STOP LOSS'];
  const tp = decision['TAKE PROFIT'];

  // desired quantity: prefer the strategy's POSITION_SIZE, else a USDT budget
  let qty = Number.isFinite(decision.POSITION_SIZE) && decision.POSITION_SIZE > 0
    ? decision.POSITION_SIZE
    : (usdt ? usdt / entry : 0);

  // Floor the size so BOTH the buy AND both OCO legs clear minNotional. The
  // OCO stop-loss leg sits at the LOWEST price (sl), so size against that
  // (with a 15% buffer) and round UP so we never fall back under the minimum.
  const { minNotional } = await getMinNotional(symbol);
  const lowestLeg = Math.min(entry, sl || entry);
  const floorQty = (minNotional * 1.15) / lowestLeg;
  qty = await roundQtyUp(symbol, Math.max(qty, floorQty));
  if (qty <= 0) throw new Error(`${symbol}: quantity rounds to 0`);

  // Affordability check — turns the cryptic -2010 into a clear skip.
  const need = qty * entry;
  const usdtFree = await getFreeBalance('USDT');
  if (need > usdtFree) {
    console.log(`⏭️  ${symbol}: need ~${need.toFixed(2)} USDT but only ${usdtFree.toFixed(2)} free — skipped`);
    return null;
  }

  // 1) ENTRY — market buy
  const buy = await marketOrder(symbol, 'BUY', qty);
  const filled = parseFloat(buy.executedQty);
  const avg = parseFloat(buy.cummulativeQuoteQty) / filled;
  console.log(`✅ BUY ${filled} ${symbol} @ ${avg.toFixed(4)} (orderId ${buy.orderId})`);

  // 2) PROTECT — OCO sell (take-profit + stop-loss)
  try {
    const oco = await ocoSell(symbol, filled, tp, sl);
    console.log(`🛡️  OCO set — TP ${tp}  SL ${sl}  (listId ${oco.orderListId})`);
    return { buy, oco };
  } catch (e) {
    console.error(`⚠️  OCO failed for ${symbol}: ${e.message} — position is OPEN & UNPROTECTED`);
    return { buy, oco: null };
  }
}

module.exports = {
  ENV, getPrice, getMarketPrice, getKlines, getRSI, getEMA, getIndicators,
  getMarketStructure, findPivots, get24h,
  getAccount, getBalances, getFreeBalance,
  marketOrder, limitOrder, getOpenOrders, cancelOrder,
  getOrder, getAllOrders, getMyTrades, getSymbolInfo, roundQty, roundQtyUp, roundPrice,
  getMinNotional, ocoSell, placeTradeFromDecision,
  cancelAllOpenOrders, liquidateToUSDT, sellBoughtToday, realizedPnL, printPnL,
};

// --- demo run: only when called directly (node Binance.demo.ac.js) ------
if (require.main === module) {
  (async () => {
    console.log('BTC price:', await getPrice('BTCUSDT'));

    console.log('\nYour non-zero balances:');
    // console.table(await getBalances());

    console.log('\nYour BTC indicator:');
    // console.log(await getIndicators("ETHUSDT"));

    const COINS = [
      'AVAXUSDT', 'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'LINKUSDT',
      'ADAUSDT', 'DOGEUSDT', 'TRXUSDT', 'DOTUSDT', 'POLUSDT', 'LTCUSDT', 'BCHUSDT',
      'NEARUSDT', 'UNIUSDT', 'ATOMUSDT', 'ETCUSDT', 'XLMUSDT', 'FILUSDT', 'APTUSDT',
      'ARBUSDT', 'OPUSDT', 'INJUSDT', 'SUIUSDT', 'SEIUSDT', 'TIAUSDT', 'RUNEUSDT',
      'AAVEUSDT', 'GRTUSDT', 'ALGOUSDT', 'EGLDUSDT', 'FLOWUSDT', 'SANDUSDT', 'MANAUSDT',
      'AXSUSDT', 'THETAUSDT', 'XTZUSDT', 'CHZUSDT', 'EOSUSDT', 'IMXUSDT', 'LDOUSDT',
      'RENDERUSDT', 'STXUSDT', 'MKRUSDT', 'SNXUSDT', 'CRVUSDT', 'COMPUSDT', '1INCHUSDT',
      'ENJUSDT', 'ZILUSDT', 'BATUSDT', 'DASHUSDT', 'ZECUSDT', 'KSMUSDT', 'QTUMUSDT',
      'IOTAUSDT', 'NEOUSDT', 'GALAUSDT', 'APEUSDT', 'GMTUSDT', 'DYDXUSDT', 'FLOKIUSDT',
      'PEPEUSDT', 'SHIBUSDT', 'BONKUSDT', 'WIFUSDT', 'JUPUSDT', 'PYTHUSDT', 'JTOUSDT',
      'WLDUSDT', 'ORDIUSDT', 'ARUSDT', 'ROSEUSDT', 'ICPUSDT', 'KAVAUSDT', 'MINAUSDT',
      'CFXUSDT', 'ASTRUSDT', 'ENSUSDT', 'GMXUSDT', 'SSVUSDT', 'BLURUSDT', 'MASKUSDT',
      'LRCUSDT', 'ANKRUSDT', 'CELOUSDT', 'SKLUSDT', 'ONEUSDT', 'HBARUSDT', 'VETUSDT',
      'ZRXUSDT', 'BANDUSDT', 'STORJUSDT', 'KNCUSDT', 'YFIUSDT', 'SUSHIUSDT', 'BALUSDT',
      'RSRUSDT', 'FETUSDT', 'RADUSDT'
    ];



    async function validateCoins(wanted) {
      const res = await fetch(
        'https://api.binance.com/api/v3/exchangeInfo?permissions=SPOT&symbolStatus=TRADING'
      );
      const { symbols } = await res.json();

      // Set of all currently-trading USDT spot pairs
      const live = new Set(
        symbols
          .filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING')
          .map(s => s.symbol)
      );

      const valid = wanted.filter(c => live.has(c));
      const invalid = wanted.filter(c => !live.has(c));

      console.log(`✅ valid:   ${valid.length}`);
      console.log(`❌ invalid: ${invalid.length}`, invalid);
      return valid;
    }

    const ValidCOINS = await validateCoins(COINS);

    // If USDT is low, free it up by selling all holdings back to USDT.
    const MIN_USDT = 100;
    if (await getFreeBalance('USDT') < MIN_USDT) {
      await liquidateToUSDT({ minUsdt: MIN_USDT });
    }

    const usdtFree = await getFreeBalance('USDT');   // a NUMBER — fixes POSITION_SIZE NaN
    console.log(`USDT balance: ${usdtFree}`);

    const tradeCoin = []
    for (const coin of ValidCOINS) {
      const coinIndicator = await getIndicators(coin);
      coinIndicator.MIN_RR = 1.5;
      coinIndicator.ACCOUNT_RISK_PERCENT = 1;
      coinIndicator.RSI_OVERBOUGHT = 70;
      coinIndicator.EMA_ZONE = `the price band between ema9 and ema21`;

      const decision = evaluateSpotStrategy(coinIndicator, {
        accountBalance: usdtFree,
        minVolume: (await getMinNotional(coin)).minNotional,
      });

      console.log(`\n===== ${coin} =====`);
      console.log('decision:', decision);

      if (decision.Execute_Trade) {
        tradeCoin.push(decision)
      }
    }

    console.log('\nTrades to place:', tradeCoin.length, tradeCoin);

    // Place each BUY decision on the TESTNET account (entry + OCO SL/TP).
    for (const decision of tradeCoin) {
      try {
        await placeTradeFromDecision(decision, { usdt: 50 }); // fallback 50 USDT if POSITION_SIZE missing
      } catch (e) {
        console.error(`order failed for ${decision.symbol}:`, e.message);
      }
    }

    console.log(await printPnL(COINS))
  })().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
// const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];