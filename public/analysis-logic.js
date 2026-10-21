/* analysis-logic.js — honest statistics for the Analysis Lab (randomness check + backtester).
 * Pure functions, no page access; tested in tests/analysis.test.js. */
(function (root) {
  'use strict';
  const BL = root.BotLogic || (typeof require !== 'undefined' ? require('./bot-logic.js') : null);

  // ---- chi-square p-value (regularised upper incomplete gamma) ----
  function lgamma(x) {
    const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    let y = x, t = x + 5.5; t -= (x + 0.5) * Math.log(t);
    let s = 1.000000000190015; for (let j = 0; j < 6; j++) s += c[j] / ++y;
    return -t + Math.log(2.5066282746310005 * s / x);
  }
  function gammaQ(a, x) {
    if (x <= 0) return 1;
    if (x < a + 1) {
      let sum = 1 / a, term = sum, n = a;
      for (let i = 0; i < 500; i++) { n++; term *= x / n; sum += term; if (Math.abs(term) < Math.abs(sum) * 1e-14) break; }
      return Math.max(0, 1 - sum * Math.exp(-x + a * Math.log(x) - lgamma(a)));
    }
    let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
    for (let i = 1; i < 500; i++) {
      const an = -i * (i - a); b += 2; d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
      c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300; d = 1 / d;
      const del = d * c; h *= del; if (Math.abs(del - 1) < 1e-14) break;
    }
    return Math.min(1, Math.exp(-x + a * Math.log(x) - lgamma(a)) * h);
  }
  const chiP = (chi2, df) => gammaQ(df / 2, chi2 / 2);

  // Are the 10 digits equally frequent?  (df = 9)
  function uniformity(digits) {
    const n = digits.length, c = Array(10).fill(0); digits.forEach(d => c[d]++);
    if (n < 50) return { n, p: null, chi2: null };
    const e = n / 10, chi2 = c.reduce((s, o) => s + (o - e) * (o - e) / e, 0);
    return { n, chi2, p: chiP(chi2, 9), counts: c };
  }

  // Does the digit that follows depend on the digit before?  (10x10 table, df = 81)
  function dependence(digits) {
    const n = digits.length - 1;
    if (n < 500) return { n, p: null, chi2: null };
    const t = Array.from({ length: 10 }, () => Array(10).fill(0)), r = Array(10).fill(0), k = Array(10).fill(0);
    for (let i = 0; i < n; i++) { t[digits[i]][digits[i + 1]]++; r[digits[i]]++; k[digits[i + 1]]++; }
    let chi2 = 0;
    for (let a = 0; a < 10; a++) for (let b = 0; b < 10; b++) { const e = r[a] * k[b] / n; if (e > 0) chi2 += (t[a][b] - e) ** 2 / e; }
    return { n, chi2, p: chiP(chi2, 81) };
  }

  // ---- backtester for the Over/Under & Even/Odd bot ----
  const winOf = (type, barrier, d) => type === 'DIGITOVER' ? d > barrier : type === 'DIGITUNDER' ? d < barrier : type === 'DIGITEVEN' ? d % 2 === 0 : d % 2 === 1;
  const chanceOf = (type, b) => type === 'DIGITOVER' ? (9 - b) / 10 : type === 'DIGITUNDER' ? b / 10 : 0.5;

  // Wilson 95% interval for a win rate
  function wilson(w, n) {
    if (!n) return [0, 1];
    const z = 1.96, p = w / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
    return [(c - m) / d, (c + m) / d];
  }

  // Replays the bot on one array of digits. A trade fires when the entry digits have appeared `need` times in a
  // row; it settles `ticks` ticks later and counting restarts after that — the same as the live bot.
  function backtest(digits, cfg, marginPct) {
    const need = BL.NEEDS[cfg.need], ticks = Number(cfg.ticks) || 1, stake = Number(cfg.stake) || 1;
    const barrier = Number(cfg.barrier), p = chanceOf(cfg.type, barrier);
    const profitRatio = (1 - (Number(marginPct) || 0) / 100) / p - 1;      // estimated payout; Deriv's real quote differs
    const streak = BL.makeStreak(BL.effectiveEntry(cfg), need);
    let wins = 0, trades = 0, pl = 0, peak = 0, maxDD = 0, i = 0;
    while (i < digits.length - ticks) {
      if (streak.push(digits[i])) {
        const won = winOf(cfg.type, barrier, digits[i + ticks]);
        trades++; if (won) { wins++; pl += stake * profitRatio; } else pl -= stake;
        peak = Math.max(peak, pl); maxDD = Math.max(maxDD, peak - pl);
        streak.reset(); i += ticks + 1; continue;
      }
      i++;
    }
    const rate = trades ? wins / trades : 0, ci = wilson(wins, trades), breakEven = 1 / (1 + profitRatio);
    let verdict = 'No trades triggered in this sample.';
    if (trades) verdict = ci[1] < breakEven ? 'Loses money in this sample.' : ci[0] > breakEven ? 'Profitable in this sample. Confirm on fresh ticks before trusting it.' : "Can't tell. The result is within what chance alone produces.";
    return { trades, wins, losses: trades - wins, rate, expected: p, breakEven, ci, pl, maxDD, profitRatio, verdict };
  }

  const api = { chiP, uniformity, dependence, backtest, wilson, chanceOf };
  root.AnalysisLogic = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
