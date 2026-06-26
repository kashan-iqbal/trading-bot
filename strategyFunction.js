/**
 * Evaluates the SPOT EMA + Support/Resistance Pullback strategy on one coin.
 * Pure deterministic logic — same input always gives same output.
 *
 * @param {Object} d - indicator object (price, ema9, ema21, rsi14, lastClosed, swingLow, swingHigh, resistance, support, MIN_RR, etc.)
 * @param {Object} [opts] - optional { accountBalance, minVolume }
 * @returns {Object} decision object
 */
export function evaluateSpotStrategy(d, opts = {}) {
  const { accountBalance = null, minVolume = null } = opts;

  // Base result template
  const result = {
    symbol: d?.symbol ?? null,
    Execute_Trade: false,
    DECISION: 'NO TRADE',
    REASON: '',
    ENTRY: null,
    'STOP LOSS': null,
    'TAKE PROFIT': null,
    RR: null,
    POSITION_SIZE: null,
    FLAGS: [],
  };

  // ---- STEP 0: REQUIRED DATA CHECK ----
  const requiredTop = ['price', 'ema9', 'ema21', 'rsi14', 'lastClosed',
    'swingLow', 'swingHigh', 'resistance', 'support', 'MIN_RR', 'RSI_OVERBOUGHT'];
  const requiredCandle = ['open', 'close', 'high', 'low', 'volume', 'bullish'];

  const missing = [];
  for (const k of requiredTop) {
    if (d[k] === undefined || d[k] === null) missing.push(k);
  }
  if (d.lastClosed && typeof d.lastClosed === 'object') {
    for (const k of requiredCandle) {
      if (d.lastClosed[k] === undefined || d.lastClosed[k] === null) {
        missing.push(`lastClosed.${k}`);
      }
    }
  }
  if (missing.length > 0) {
    result.REASON = `Missing data: ${missing.join(', ')}`;
    return result;
  }

  const {
    price, ema9, ema21, rsi14, lastClosed,
    swingLow, resistance, MIN_RR, RSI_OVERBOUGHT,
  } = d;


  if (d.swingLow >= d.price || d.swingHigh <= d.price) {
    result.REASON = 'NO TRADE — invalid swing data (swingLow/High not bracketing price)';
    return result;
  }
  if (d.support >= d.price || d.resistance <= d.price) {
    result.REASON = 'NO TRADE — invalid S/R data';
    return result;
  }

  // ---- STEP 1: TREND FILTER ----
  if (ema9 <= ema21) {
    result.REASON = 'NO TRADE — not an uptrend';
    return result;
  }

  // ---- STEP 2: PULLBACK CHECK ----
  // EMA zone = band between ema21 (lower) and ema9 (upper) in an uptrend.
  const zoneLow = Math.min(ema9, ema21);
  const zoneHigh = Math.max(ema9, ema21);
  // "touched or entered": last candle's range overlapped the band.
  const touchedZone = lastClosed.low <= zoneHigh && lastClosed.high >= zoneLow;
  if (!touchedZone) {
    result.REASON = 'NO TRADE — no pullback';
    return result;
  }

  // ---- STEP 3: BOUNCE CONFIRMATION ----
  if (lastClosed.bullish !== true) {
    result.REASON = 'NO TRADE — no bounce confirmation';
    return result;
  }

  // ---- STEP 4: RSI FILTER ----
  if (rsi14 >= RSI_OVERBOUGHT) {
    result.REASON = 'NO TRADE — overbought';
    return result;
  }

  // ---- STEP 5: VOLUME FILTER ----
  if (minVolume === null) {
    result.FLAGS.push('volume not verified');
  } else if (lastClosed.volume < minVolume) {
    result.REASON = 'NO TRADE — volume too low';
    return result;
  }



  // News check — no data field provided
  result.FLAGS.push('news not checked');

  // STEP 6 — choose TP method
  const stopLoss = swingLow;
  const risk_tp = price - stopLoss;
  const takeProfit = price + (MIN_RR * risk_tp);   // fixed RR target instead of resistance

  // ---- STEP 7: REWARD:RISK CHECK ----
  const risk = price - stopLoss;     // distance to stop
  const reward = takeProfit - price; // distance to target

  // Guard against invalid geometry
  if (risk <= 0) {
    result.REASON = 'NO TRADE — invalid stop (price at or below swingLow)';
    return result;
  }
  if (reward <= 0) {
    result.REASON = 'NO TRADE — invalid target (resistance at or below price)';
    return result;
  }

  const RR = +(reward / risk).toFixed(2);

  if (RR < MIN_RR) {
    result.REASON = `NO TRADE — reward:risk too low (RR ${RR} < MIN_RR ${MIN_RR})`;
    result.ENTRY = price;
    result['STOP LOSS'] = stopLoss;
    result['TAKE PROFIT'] = takeProfit;
    result.RR = RR;
    return result;
  }

  // ---- STEP 8: POSITION SIZE ----
  let positionSize = null;
  if (accountBalance !== null) {
    const riskPct = (d.ACCOUNT_RISK_PERCENT ?? 1) / 100;
    const riskAmount = accountBalance * riskPct;
    positionSize = +(riskAmount / risk).toFixed(6); // units of the coin
  }

  // ---- ALL CHECKS PASSED → BUY ----
  result.Execute_Trade = true;
  result.DECISION = 'BUY';
  result.REASON = `All conditions met (RR ${RR} >= MIN_RR ${MIN_RR})`;
  result.ENTRY = price;
  result['STOP LOSS'] = stopLoss;
  result['TAKE PROFIT'] = takeProfit;
  result.RR = RR;
  result.POSITION_SIZE = positionSize;

  return result;
}