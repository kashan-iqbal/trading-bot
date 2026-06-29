// ───────────────────────────────────────────────────────────────────────
// server.js — Express + Telegram bot that SCANS for spot trade setups.
//
// You message the bot → server runs the strategy over the coin list → replies
// with the BUY decisions (entry / SL / TP / RR). It does NOT place any orders
// (no placeTradeFromDecision, no liquidateToUSDT) — scan & report only.
//
// ── Flow ──────────────────────────────────────────────────────────────────
//   Telegram → (webhook) → this server → scanTrades() → reply to Telegram
//
// ── Run ─────────────────────────────────────────────────────────────────────
//   1. Start a public HTTPS tunnel:  npx cloudflared tunnel --url http://localhost:9090
//   2. export TELEGRAM_BOT_TOKEN="123:ABC"   (and PUBLIC_URL from the tunnel)
//   3. node server.js
//   4. Register the webhook ONCE (Telegram is blocked here, so via Tor or phone):
//        curl --proxy socks5h://127.0.0.1:9050 \
//          "https://api.telegram.org/bot<TOKEN>/setWebhook?url=<PUBLIC_URL>/telegram/<SECRET>&secret_token=<SECRET>"
//   5. In Telegram send the bot:  /trade
//
//   Outgoing replies go through Tor (USE_TOR=1 default) because this network
//   blocks api.telegram.org. Set USE_TOR=0 if you're on an unblocked network.
// ───────────────────────────────────────────────────────────────────────

require('dotenv').config();   // load .env into process.env (must be FIRST)

const express = require('express');
const { socksDispatcher } = require('fetch-socks');

// read-only helpers from the Binance client — NO order-execution functions
const { getIndicators, getMinNotional, getFreeBalance } = require('./Binance.demo.ac');
const { evaluateSpotStrategy } = require('./strategyFunction');
const db = require('./db');
const { startMonitor, runOnce } = require('./monitor');

// ── config (env-driven; production-safe defaults) ───────────────────────────
// Robust boolean parse — env vars are STRINGS, so '0'/'false' must read false.
const bool = (v, def = false) =>
  v == null || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SECRET = process.env.WEBHOOK_SECRET || 'change-me-secret';
const PORT = process.env.PORT || 8000;             // cloud platforms (Koyeb/Render) inject PORT
const USE_TOR = bool(process.env.USE_TOR, false);  // OFF by default; only a blocked LOCAL network sets USE_TOR=1

// Accept a bare domain OR full URL; add https://, strip trailing slash; fall
// back to the platform-provided URL so you don't have to set it by hand.
let PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');
if (PUBLIC_URL && !/^https?:\/\//i.test(PUBLIC_URL)) PUBLIC_URL = 'https://' + PUBLIC_URL;

if (!BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN — set it in env');
const TG = 'https://api.telegram.org';
const HOOK_PATH = `/telegram/${SECRET}`;

// How many coins to analyse in parallel (be nice to the data API).
const SCAN_CONCURRENCY = parseInt(process.env.SCAN_CONCURRENCY || '8', 10);

const torDispatcher = USE_TOR ? socksDispatcher({ type: 5, host: '127.0.0.1', port: 9050 }) : undefined;

// ── Telegram: send a message (via Tor so the block is bypassed) ─────────────
async function tgSend(chatId, text) {
  try {
    const res = await fetch(`${TG}/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      dispatcher: torDispatcher,
      signal: AbortSignal.timeout(60000),
    });
    const data = await res.json();
    if (!data.ok) console.error('tgSend failed:', data.description);
  } catch (e) {
    console.error('tgSend error:', e.message, '(is Tor running on 127.0.0.1:9050?)');
  }
}

// ── register the webhook with Telegram (through Tor, since it's blocked) ────
async function registerWebhook() {
  if (!PUBLIC_URL) {
    console.log('\n⚠️  PUBLIC_URL not set — webhook NOT auto-registered.');
    console.log('   Start a tunnel, then set PUBLIC_URL and restart, e.g.:');
    console.log('   PUBLIC_URL=https://xyz.trycloudflare.com node server.js');
    console.log('   …or register manually via Tor:');
    console.log(`   curl --proxy socks5h://127.0.0.1:9050 "${TG}/bot${BOT_TOKEN}/setWebhook?url=https://arlington-libraries-senior-extending.trycloudflare.com${HOOK_PATH}&secret_token=${SECRET}"\n`);
    return;
  }
  const url = `${PUBLIC_URL}${HOOK_PATH}`;
  try {
    const res = await fetch(`${TG}/bot${BOT_TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, secret_token: SECRET, drop_pending_updates: true }),
      dispatcher: torDispatcher,                 // ← through Tor (same as tgSend)
      signal: AbortSignal.timeout(60000),
    });
    const data = await res.json();
    if (data.ok) console.log(`✅ webhook registered → ${url}`);
    else console.error('❌ setWebhook failed:', data.description);
  } catch (e) {
    console.error('❌ setWebhook error:', e.message, '(is Tor running on 127.0.0.1:9050?)');
  }
}

// ── the full Binance spot universe (ALL trading USDT pairs) ─────────────────
// Pulled from data-api.binance.vision (public, NOT geo-restricted, has every
// listed coin). Returns the coin list + a minNotional map (one fetch, no
// per-coin exchangeInfo calls). Excludes leveraged tokens (UP/DOWN/BULL/BEAR).
const BINANCE_DATA = process.env.BINANCE_DATA || 'https://data-api.binance.vision';
async function getSpotUniverse() {
  const res = await fetch(`${BINANCE_DATA}/api/v3/exchangeInfo?permissions=SPOT&symbolStatus=TRADING`);
  if (!res.ok) throw new Error(`Binance exchangeInfo ${res.status} — geo-blocked? set BINANCE_DATA=https://data-api.binance.vision`);
  const data = await res.json();
  if (!Array.isArray(data.symbols)) throw new Error(`Binance returned no symbols (${data.msg || 'unknown'})`);

  const isLeveraged = s => /(UP|DOWN|BULL|BEAR)USDT$/.test(s);
  const coins = [];
  const minNotional = new Map();
  for (const s of data.symbols) {
    if (s.quoteAsset !== 'USDT' || s.status !== 'TRADING' || !s.isSpotTradingAllowed) continue;
    if (isLeveraged(s.symbol)) continue;
    coins.push(s.symbol);
    const not = s.filters.find(f => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL');
    minNotional.set(s.symbol, not ? parseFloat(not.minNotional || not.notional || 0) : 0);
  }
  return { coins, minNotional };
}

// run an async fn over items with limited concurrency
async function mapPool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]); }
  }));
}

// ── the scan: indicators → strategy decision over ALL spot coins (NO orders) ─
async function scanTrades() {
  const { coins, minNotional } = await getSpotUniverse();
  let usdtFree = 1000;
  try { usdtFree = await getFreeBalance('USDT'); } catch { /* account geo-blocked → use default for sizing */ }

  const trades = [];
  await mapPool(coins, SCAN_CONCURRENCY, async (coin) => {
    try {
      const coinIndicator = await getIndicators(coin);
      coinIndicator.MIN_RR = 1.5;
      coinIndicator.ACCOUNT_RISK_PERCENT = 1;
      coinIndicator.RSI_OVERBOUGHT = 70;
      coinIndicator.EMA_ZONE = `the price band between ema9 and ema21`;

      const decision = evaluateSpotStrategy(coinIndicator, {
        accountBalance: usdtFree,
        minVolume: minNotional.get(coin) || 0,
      });
      decision.symbol = coin;
      if (decision.Execute_Trade) trades.push(decision);
    } catch { /* skip coins with insufficient data / transient errors */ }
  });
  return { trades, scanned: coins.length, usdtFree };
}

// format the decisions into a Telegram message
function formatTrades({ trades, scanned }) {
  if (!trades.length) return `🔍 Scanned ${scanned} coins — <b>no trade setups</b> right now.`;
  const lines = trades.map(d =>
    `✅ <b>${d.symbol}</b>  BUY\n   entry ${d.ENTRY}  SL ${d['STOP LOSS']}  TP ${d['TAKE PROFIT']}  (RR ${d.RR})`
  );
  return `📊 <b>${trades.length} setup(s)</b> from ${scanned} coins:\n\n${lines.join('\n\n')}`;
}

// format the audit/performance report for Telegram (complete, easy to read)
function formatAudit(a) {
  const pct = n => `${n >= 0 ? '+' : ''}${(n || 0).toFixed(2)}%`;
  const winList = a.top10.length
    ? a.top10.map((t, i) => `${i + 1}. ${t.coin.replace('USDT', '')}  ${pct(t.pnlPercent)}`).join('\n')
    : '—';
  const lossList = a.slHits.length
    ? a.slHits.map((t, i) => `${i + 1}. ${t.coin.replace('USDT', '')}  ${pct(t.pnlPercent)}`).join('\n')
    : '—';
  const best = a.topProfit ? `${a.topProfit.coin.replace('USDT', '')} ${pct(a.topProfit.pnlPercent)}` : '—';

  return [
    '📊 <b>PERFORMANCE REPORT</b>',
    '──────────────',
    `✅ Wins:   <b>${a.wins}</b>`,
    `❌ Losses: <b>${a.losses}</b>`,
    `🎯 Win rate: <b>${a.winRate.toFixed(1)}%</b>`,
    `⏳ Open trades: <b>${a.open}</b>`,
    '──────────────',
    `📈 Total gain: <b>${pct(a.totalWinPct)}</b>`,
    `📉 Total loss: <b>${pct(a.totalLossPct)}</b>`,
    `💰 Net P&L:   <b>${pct(a.netPct)}</b>`,
    `   avg win ${pct(a.avgWinPct)} · avg loss ${pct(a.avgLossPct)}`,
    `🏆 Top profit: <b>${best}</b>`,
    '',
    '🟢 <b>Top winners (TP hit)</b>',
    winList,
    '',
    '🔴 <b>Hit stop-loss</b>',
    lossList,
  ].join('\n');
}

// ── express app + Telegram webhook ──────────────────────────────────────────
const app = express();
app.use(express.json());

app.post(HOOK_PATH, async (req, res) => {
  res.sendStatus(200);                                // ack fast
  const sig = req.get('X-Telegram-Bot-Api-Secret-Token');
  if (sig && sig !== SECRET) return;

  const msg = req.body.message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim().toLowerCase();
  console.log(`📩 ${chatId}: ${text}`);

  if (text === '/start') {
    return tgSend(chatId, '👋 Send <b>/trade</b> and I will scan the coin list for spot setups.');
  }
  if (text === '/trade' || text === 'trade') {
    await tgSend(chatId, '🔎 Scanning ALL Binance spot coins… (~30–60s)');
    try {
      const result = await scanTrades();
      const saved = db.ready() ? await db.recordSetups(result.trades) : 0;   // persist new setups
      console.log(saved)
      await tgSend(chatId, formatTrades(result) + (db.ready() ? `\n\n💾 stored ${saved} new trade(s) for tracking.` : ''));
    } catch (e) {
      await tgSend(chatId, `❌ scan failed: ${e.message}`);
    }
    return;
  }
  if (text === '/audit' || text === '/stats') {
    try {
      await tgSend(chatId, formatAudit(await db.buildAudit()));
    } catch (e) {
      await tgSend(chatId, `❌ audit failed: ${e.message}`);
    }
    return;
  }
  return tgSend(chatId, 'Commands: <b>/trade</b> to scan, <b>/audit</b> for performance.');
});

// health + manual triggers (browser/curl)
app.get('/', (_req, res) => res.send('trade server running'));

// GET /scan — run the scan AND persist new setups
app.get('/scan', async (_req, res) => {
  try {
    const result = await scanTrades();
    const saved = db.ready() ? await db.recordSetups(result.trades) : 0;
    res.json({ ...result, saved });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /measure — run one monitor pass now (resolve any trades that hit TP/SL)
app.get('/measure', async (_req, res) => {
  try { res.json(await runOnce()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /audit — performance report as JSON
app.get('/audit', async (_req, res) => {
  try { res.json(await db.buildAudit()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// boot: connect Mongo (non-fatal) → listen → register webhook → start monitor
async function start() {
  try {
    await db.connect();
  } catch (e) {
    console.error('⚠️  Mongo not connected:', e.message, '— /audit & tracking disabled until MONGODB_URI is set');
  }
  app.listen(PORT, async () => {
    console.log(`Listening on :${PORT}   webhook ${HOOK_PATH}   Tor:${USE_TOR ? 'on' : 'off'}`);
    await registerWebhook();
    if (db.ready()) startMonitor();   // only run the monitor when the DB is up
  });
}
start().catch(e => { console.error('startup failed:', e.message); process.exit(1); });
