/* strategy-logic.js — pure signal maths for the STANDALONE strategies.
 *
 * Each strategy below is a self-contained definition: its own window, its own
 * evaluator, its own contract. Nothing here touches the page, so it can be tested
 * in Node (see tests/run.js). The Smart Strategy is NOT in this file; it is left
 * exactly as it was in script.js.
 */
(function (root) {
  'use strict';

  const CONFIG = {
    OVER_CANDIDATES: [2, 3, 4],
    UNDER_CANDIDATES: [6, 7, 8],
    EVEN_ODD_MIN_GAP: 5,          // percentage points
    MATCHES_MIN_PCT: 15,
    HOT_PCT: 13, COLD_PCT: 8,
    MAJOR_MIN_COUNT: 50,          // occurrences in 500 ticks (= 10%)
    MAJOR_BREAKOUT_MAX_HIGH: 2,
    FINAL_TWO_CHECK: true,
    HOLD_MS: 10000                // keep a momentary signal visible this long
  };

  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const countsOf = arr => { const c = Array(10).fill(0); arr.forEach(d => c[d]++); return c; };
  const pctOf = (c, n) => c.map(x => (n ? (x / n) * 100 : 0));
  const sum = (p, from, to) => { let s = 0; for (let d = from; d <= to; d++) s += p[d]; return s; };

  // dominant = digits that WIN the contract, breakout = digits that lose it.
  const MAJOR = [
    { id: 'UNDER3', type: 'DIGITUNDER', barrier: 3, dominant: range(0, 2), breakout: range(3, 9), allowDominantMisses: 0 },
    { id: 'UNDER4', type: 'DIGITUNDER', barrier: 4, dominant: range(0, 3), breakout: range(4, 9), allowDominantMisses: 0 },
    { id: 'OVER6',  type: 'DIGITOVER',  barrier: 6, dominant: range(7, 9), breakout: range(0, 6), allowDominantMisses: 0 },
    { id: 'OVER7',  type: 'DIGITOVER',  barrier: 7, dominant: range(8, 9), breakout: range(0, 7), allowDominantMisses: 0 }
  ];

  // ---- Original strategies (1,000-tick window) --------------------------------
  function evalOverUnder(c, n) {
    const p = pctOf(c, n);
    let best = null;
    CONFIG.OVER_CANDIDATES.forEach(N => {
      for (let d = 0; d <= N; d++) if (p[d] >= 10) return;
      const win = sum(p, N + 1, 9), edge = win - (9 - N) * 10;
      if (!best || edge > best.edge) best = {
        name: 'Over/Under', type: 'DIGITOVER', barrier: N, short: `OVER ${N}`, edge, key: `DIGITOVER:${N}`,
        detail: `Over ${N}: digits 0-${N} all below 10%; win share ${win.toFixed(1)}%`
      };
    });
    CONFIG.UNDER_CANDIDATES.forEach(N => {
      for (let d = N; d <= 9; d++) if (p[d] >= 10) return;
      const win = sum(p, 0, N - 1), edge = win - N * 10;
      if (!best || edge > best.edge) best = {
        name: 'Over/Under', type: 'DIGITUNDER', barrier: N, short: `UNDER ${N}`, edge, key: `DIGITUNDER:${N}`,
        detail: `Under ${N}: digits ${N}-9 all below 10%; win share ${win.toFixed(1)}%`
      };
    });
    return best;
  }

  const diffPick = new Map();
  function evalDiffers(symbol, c, n) {
    const max = Math.max(...c);
    const tops = c.map((v, i) => (v === max ? i : -1)).filter(i => i >= 0);
    let d = diffPick.get(symbol);
    if (d === undefined || !tops.includes(d)) {          // random tie-break, then kept stable
      d = tops[Math.floor(Math.random() * tops.length)];
      diffPick.set(symbol, d);
    }
    return {
      name: 'Differs', type: 'DIGITDIFF', barrier: d, short: `DIFF ${d}`, key: `DIGITDIFF:${d}`,
      detail: `Barrier ${d}: most frequent digit (${((c[d] / n) * 100).toFixed(1)}%)`
    };
  }

  function evalEvenOdd(c, n) {
    const even = c[0] + c[2] + c[4] + c[6] + c[8];
    const ep = (even / n) * 100, op = 100 - ep;
    if (Math.abs(ep - op) < CONFIG.EVEN_ODD_MIN_GAP) return null;
    const type = ep < op ? 'DIGITEVEN' : 'DIGITODD';      // the LESS frequent parity
    return {
      name: 'Even/Odd', type, barrier: undefined, short: ep < op ? 'EVEN' : 'ODD', key: type,
      detail: `Even ${ep.toFixed(1)}% vs Odd ${op.toFixed(1)}%: proposing the less frequent`
    };
  }

  function evalMatches(c, n) {
    const max = Math.max(...c), d = c.indexOf(max), pct = (max / n) * 100;
    if (pct < CONFIG.MATCHES_MIN_PCT) return null;
    return {
      name: 'Matches/Equals', type: 'DIGITMATCH', barrier: d, short: `MATCH ${d}`, key: `DIGITMATCH:${d}`,
      detail: `Digit ${d} at ${pct.toFixed(1)}% (needs ${CONFIG.MATCHES_MIN_PCT}%+)`
    };
  }

  // Hot/Cold. The signal rule is unchanged (same classification in two rolling windows).
  // To give it auto-buy, it trades: DIFFERS on the coldest persistent digit, or, if there is
  // no cold digit, MATCHES on the hottest persistent digit.
  function evalHotCold(digits) {
    const a = digits.slice(-500), b = digits.slice(-1000, -500);
    const pa = pctOf(countsOf(a), a.length), pb = pctOf(countsOf(b), b.length);
    const hot = [], cold = [];
    for (let d = 0; d <= 9; d++) {
      if (pa[d] >= CONFIG.HOT_PCT && pb[d] >= CONFIG.HOT_PCT) hot.push(d);
      if (pa[d] <= CONFIG.COLD_PCT && pb[d] <= CONFIG.COLD_PCT) cold.push(d);
    }
    if (!hot.length && !cold.length) return null;
    const label = `Hot ${hot.join(',') || '-'} · Cold ${cold.join(',') || '-'}`;
    let type, barrier, how;
    if (cold.length) {
      barrier = cold.slice().sort((x, y) => pa[x] - pa[y])[0]; type = 'DIGITDIFF';
      how = `trade: DIFFERS ${barrier} (coldest)`;
    } else {
      barrier = hot.slice().sort((x, y) => pa[y] - pa[x])[0]; type = 'DIGITMATCH';
      how = `trade: MATCHES ${barrier} (hottest)`;
    }
    return {
      name: 'Hot/Cold', type, barrier, short: label, key: `HC:${type}:${barrier}`,
      detail: `${label}; ${how}`
    };
  }

  function evalMajor(digits, rule, epoch) {
    const w = digits.slice(-500), c = countsOf(w);
    const domMiss = rule.dominant.filter(d => c[d] < CONFIG.MAJOR_MIN_COUNT).length;
    const brkHigh = rule.breakout.filter(d => c[d] >= CONFIG.MAJOR_MIN_COUNT).length;
    if (domMiss > rule.allowDominantMisses || brkHigh > CONFIG.MAJOR_BREAKOUT_MAX_HIGH) return null;
    let top = rule.breakout[0];
    rule.breakout.forEach(d => { if (c[d] > c[top]) top = d; });
    const last = w[w.length - 1], prev = w[w.length - 2];
    if (last !== top) return null;
    if (CONFIG.FINAL_TWO_CHECK && !rule.breakout.includes(prev)) return null;
    return {
      name: rule.id, type: rule.type, barrier: rule.barrier, short: `${rule.id} (entry ${top})`,
      key: `${rule.type}:${rule.barrier}:${epoch}`,
      detail: `${rule.id}: ${domMiss} dominant misses, ${brkHigh} breakout digits at ${CONFIG.MAJOR_MIN_COUNT}+; last two digits ${prev},${last}`
    };
  }

  // ---- Independent strategy definitions ---------------------------------------
  // run(mk, epoch) -> signal | null. mk = { symbol, digits[], counts[10] }
  const DEFS = [
    { id: 'overunder', label: 'Over/Under',      group: 'Original', window: 1000, momentary: false, run: mk => evalOverUnder(mk.counts, mk.digits.length) },
    { id: 'differs',   label: 'Differs',         group: 'Original', window: 1000, momentary: false, run: mk => evalDiffers(mk.symbol, mk.counts, mk.digits.length) },
    { id: 'evenodd',   label: 'Even/Odd',        group: 'Original', window: 1000, momentary: false, run: mk => evalEvenOdd(mk.counts, mk.digits.length) },
    { id: 'matches',   label: 'Matches/Equals',  group: 'Original', window: 1000, momentary: false, run: mk => evalMatches(mk.counts, mk.digits.length) },
    { id: 'hotcold',   label: 'Hot/Cold',        group: 'Original', window: 1000, momentary: false, run: mk => evalHotCold(mk.digits) },
    ...MAJOR.map(r => ({
      id: r.id, label: r.id, group: 'Major Scanner', window: 500, momentary: true,
      run: (mk, epoch) => evalMajor(mk.digits, r, epoch)
    }))
  ];

  // undefined = not enough ticks yet; null = no signal; object = signal
  function evaluate(def, mk, epoch) {
    if (!mk || mk.digits.length < def.window) return undefined;
    return def.run(mk, epoch) || null;
  }

  const api = { CONFIG, MAJOR, DEFS, evaluate, countsOf, evalOverUnder, evalDiffers, evalEvenOdd, evalMatches, evalHotCold, evalMajor };
  root.StrategyLogic = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
