// monitor.js — live background watcher that resolves OPEN trades.
//
// Every MONITOR_SECONDS it checks each open trade's current price:
//   price >= tp  → WIN   (tpHit true,  pnl = (tp-entry)/entry*100)
//   price <= sl  → LOSS  (tpHit false, pnl = (sl-entry)/entry*100, negative)
// otherwise the trade stays OPEN.
//
// Stored entry/SL/TP now come from REAL-market indicators (data-api), so we poll
// the REAL-market price (getMarketPrice) to measure TP/SL hits consistently.

const { getMarketPrice } = require('./Binance.demo.ac');
const { getOpenTrades, resolveTrade } = require('./db');

const MONITOR_SECONDS = parseInt(process.env.MONITOR_SECONDS || '20', 10);

let _timer = null;

// resolve a single open trade if its price crossed TP or SL; returns the result
async function checkTrade(t, onResolve) {
  const price = parseFloat(await getMarketPrice(t.coin));
  if (!Number.isFinite(price)) return null;

  let status, exitPrice, tpHit;
  if (price >= t.tp) { status = 'WIN'; exitPrice = t.tp; tpHit = true; }
  else if (price <= t.sl) { status = 'LOSS'; exitPrice = t.sl; tpHit = false; }
  else return null; // still open

  const pnlPercent = +(((exitPrice - t.entry) / t.entry) * 100).toFixed(3);
  await resolveTrade(t._id, { status, exitPrice, pnlPercent, tpHit });
  const result = { coin: t.coin, status, pnlPercent };
  console.log(`${status === 'WIN' ? '🎯' : '🛑'} ${t.coin} ${status} ${pnlPercent >= 0 ? '+' : ''}${pnlPercent}%`);
  if (onResolve) await onResolve(result);
  return result;
}

// one pass over all open trades (also exposed for the GET /measure route)
async function runOnce(onResolve) {
  const open = await getOpenTrades();
  const resolved = [];
  for (const t of open) {
    try {
      const r = await checkTrade(t, onResolve);
      if (r) resolved.push(r);
    } catch (e) {
      console.error(`monitor ${t.coin} error:`, e.message);
    }
  }
  return { checked: open.length, resolved };
}

// start the recurring background monitor
function startMonitor(onResolve) {
  if (_timer) return;
  console.log(`👁️  monitor started — every ${MONITOR_SECONDS}s`);
  const tick = () => runOnce(onResolve).catch(e => console.error('monitor tick error:', e.message));
  _timer = setInterval(tick, MONITOR_SECONDS * 1000);
  tick(); // run immediately on boot
}

module.exports = { startMonitor, runOnce };
