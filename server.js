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

// ── config (from .env) ──────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SECRET = process.env.WEBHOOK_SECRET || 'change-me-secret';
const PORT = process.env.PORT || 9090;
const USE_TOR = process.env.USE_TOR !== '0';      // route Telegram calls via Tor by default
const PUBLIC_URL = (process.env.PUBLIC_URL || '').trim(); // your https tunnel, e.g. https://xyz.trycloudflare.com

if (!BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN — set it in .env');
const TG = 'https://api.telegram.org';
const HOOK_PATH = `/telegram/${SECRET}`;

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

// ── only keep coins that are live, trading USDT spot pairs (real market) ────
async function validateCoins(wanted) {
  const res = await fetch('https://api.binance.com/api/v3/exchangeInfo?permissions=SPOT&symbolStatus=TRADING');
  const { symbols } = await res.json();
  const live = new Set(symbols.filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING').map(s => s.symbol));
  return wanted.filter(c => live.has(c));
}

// ── the scan: indicators → strategy decision (NO order placement) ───────────
async function scanTrades() {
  const valid = await validateCoins(COINS);
  const usdtFree = await getFreeBalance('USDT');   // read-only
  const trades = [];

  for (const coin of valid) {
    const coinIndicator = await getIndicators(coin);
    coinIndicator.MIN_RR = 1.5;
    coinIndicator.ACCOUNT_RISK_PERCENT = 1;
    coinIndicator.RSI_OVERBOUGHT = 70;
    coinIndicator.EMA_ZONE = `the price band between ema9 and ema21`;

    const decision = evaluateSpotStrategy(coinIndicator, {
      accountBalance: usdtFree,
      minVolume: (await getMinNotional(coin)).minNotional,
    });
    decision.symbol = coin;
    if (decision.Execute_Trade) trades.push(decision);
  }
  return { trades, scanned: valid.length, usdtFree };
}

// format the decisions into a Telegram message
function formatTrades({ trades, scanned }) {
  if (!trades.length) return `🔍 Scanned ${scanned} coins — <b>no trade setups</b> right now.`;
  const lines = trades.map(d =>
    `✅ <b>${d.symbol}</b>  BUY\n   entry ${d.ENTRY}  SL ${d['STOP LOSS']}  TP ${d['TAKE PROFIT']}  (RR ${d.RR})`
  );
  return `📊 <b>${trades.length} setup(s)</b> from ${scanned} coins:\n\n${lines.join('\n\n')}`;
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
    await tgSend(chatId, '🔎 Scanning the market… (~20s)');
    try {
      const result = await scanTrades();
      await tgSend(chatId, formatTrades(result));
    } catch (e) {
      await tgSend(chatId, `❌ scan failed: ${e.message}`);
    }
    return;
  }
  return tgSend(chatId, 'Commands: <b>/trade</b> to scan for setups.');
});

// health + manual trigger (browser): GET /scan returns the JSON decisions
app.get('/', (_req, res) => res.send('trade server running'));
app.get('/scan', async (_req, res) => {
  try { res.json(await scanTrades()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, async () => {
  console.log(`Listening on :${PORT}   webhook ${HOOK_PATH}   Tor:${USE_TOR ? 'on' : 'off'}`);
  await registerWebhook();   // auto-registers through Tor if PUBLIC_URL is set
});
