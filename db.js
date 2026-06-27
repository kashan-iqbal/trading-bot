// db.js — MongoDB persistence for the trade audit.
//
// Stores every generated setup, lets the monitor resolve it (TP/SL), and builds
// the performance report. Uses MongoDB Atlas (free) so data survives Koyeb
// redeploys (the local filesystem there is ephemeral).
//
// Set MONGODB_URI in .env / Koyeb env, e.g.
//   MONGODB_URI=mongodb+srv://user:pass@cluster0.xxxx.mongodb.net/?retryWrites=true&w=majority

const { MongoClient } = require('mongodb');

const URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || 'trading_bot';

let _client = null;
let _trades = null;

// Connect once and cache the collection.
async function connect() {
  if (_trades) return _trades;
  if (!URI) throw new Error('Missing MONGODB_URI — set it in .env / Koyeb env');
  _client = new MongoClient(URI);
  await _client.connect();
  _trades = _client.db(DB_NAME).collection('trades');
  // one OPEN trade per coin is enforced in recordSetups(); index speeds lookups
  await _trades.createIndex({ coin: 1, status: 1 });
  console.log(`🗄️  Mongo connected → ${DB_NAME}.trades`);
  return _trades;
}

function ready() {
  return !!_trades;
}

function trades() {
  if (!_trades) throw new Error('DB not connected (set MONGODB_URI)');
  return _trades;
}

// Store new setups. Skips a coin that already has an OPEN (unresolved) trade.
// `setups` are decision objects: { symbol, ENTRY, 'STOP LOSS', 'TAKE PROFIT', RR }
async function recordSetups(setups = []) {
  const col = trades();
  let inserted = 0;
  for (const d of setups) {
    const coin = d.symbol;
    const open = await col.findOne({ coin, status: 'OPEN' });
    if (open) continue; // one open trade per coin
    await col.insertOne({
      coin,
      entry: d.ENTRY,
      sl: d['STOP LOSS'],
      tp: d['TAKE PROFIT'],
      rr: d.RR,
      createdAt: new Date(),
      status: 'OPEN',
      tpHit: null,
      exitPrice: null,
      pnlPercent: null,
      resolvedAt: null,
    });
    inserted++;
  }
  return inserted;
}

async function getOpenTrades() {
  return trades().find({ status: 'OPEN' }).toArray();
}

// Mark a trade WIN/LOSS with its exit price + pnl%.
async function resolveTrade(id, { status, exitPrice, pnlPercent, tpHit }) {
  return trades().updateOne(
    { _id: id },
    { $set: { status, exitPrice, pnlPercent, tpHit, resolvedAt: new Date() } }
  );
}

// Aggregate the performance report.
async function buildAudit() {
  const col = trades();
  const all = await col.find({}).toArray();

  const wins = all.filter(t => t.status === 'WIN');
  const losses = all.filter(t => t.status === 'LOSS');
  const open = all.filter(t => t.status === 'OPEN');

  const resolved = wins.length + losses.length;
  const sum = arr => arr.reduce((s, t) => s + (t.pnlPercent || 0), 0);
  const totalWinPct = sum(wins);
  const totalLossPct = sum(losses);     // negative
  const netPct = totalWinPct + totalLossPct;

  const top10 = [...wins]
    .sort((a, b) => (b.pnlPercent || 0) - (a.pnlPercent || 0))
    .slice(0, 10);

  return {
    total: all.length,
    wins: wins.length,
    losses: losses.length,
    open: open.length,
    winRate: resolved ? (wins.length / resolved) * 100 : 0,
    totalWinPct,
    totalLossPct,
    netPct,
    top10,
  };
}

module.exports = { connect, ready, trades, recordSetups, getOpenTrades, resolveTrade, buildAudit };
