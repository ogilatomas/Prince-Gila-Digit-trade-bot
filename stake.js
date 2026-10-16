// stake.js — risk-based stake suggestion for alerts.
// IMPORTANT: this is position sizing, NOT a profit forecast. Digit contracts are random; no stake
// size makes a losing strategy profitable. It keeps one loss small relative to your bankroll.
function suggestStake({ bankroll, riskPct = 1, maxStake = 500, sessionLossLimit = 500, minStake = 0.35, lossesToSurvive = 5 } = {}) {
  const b = Number(bankroll);
  if (!(b > 0)) return null;
  const pct = Number(riskPct) > 0 ? Number(riskPct) : 1;
  let stake = (b * pct) / 100;
  const caps = [];
  if (Number(maxStake) > 0) caps.push(Number(maxStake));
  if (Number(sessionLossLimit) > 0) caps.push(Number(sessionLossLimit) / lossesToSurvive);   // N losses in a row still fit the session limit
  const cap = caps.length ? Math.min(...caps) : Infinity;
  const capped = stake > cap;
  if (capped) stake = cap;
  stake = Math.floor(stake * 100) / 100;
  let belowMin = false;
  if (stake < minStake) { stake = minStake; belowMin = true; }
  return { stake, bankroll: b, riskPct: pct, capped, belowMin, heavy: stake / b > 0.05 };
}
module.exports = { suggestStake };
