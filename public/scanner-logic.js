/* scanner-logic.js — pure rules for the Volatility Scanner (no page access, so it can be tested in Node).
 *
 * The rule, for every trade type below:
 *   look at the digits listed for that type; each one must appear in LESS than 10% of the scanned ticks.
 *   One digit of the group may sit exactly ON 10%. Any digit above 10% disqualifies the market.
 *
 * Digits checked per trade type (edit DIGITS here if you want a different set):
 *   Over 2 -> 0,1            Over 3 -> 0,1,2          Over 4 -> 0,1,2,3        Over 5 -> 0,1,2,3,4
 *   Under 6 -> 7,8,9         Under 7 -> 8,9           Under 8 -> 9             Under 9 -> 9
 */
(function (root) {
  'use strict';

  const LIMIT = 10;                    // percent
  const RULES = [
    { id: 'OVER2',  direction: 'DIGITOVER',  barrier: 2, label: 'Over 2',  digits: [0, 1] },
    { id: 'OVER3',  direction: 'DIGITOVER',  barrier: 3, label: 'Over 3',  digits: [0, 1, 2] },
    { id: 'OVER4',  direction: 'DIGITOVER',  barrier: 4, label: 'Over 4',  digits: [0, 1, 2, 3] },
    { id: 'OVER5',  direction: 'DIGITOVER',  barrier: 5, label: 'Over 5',  digits: [0, 1, 2, 3, 4] },
    { id: 'UNDER6', direction: 'DIGITUNDER', barrier: 6, label: 'Under 6', digits: [7, 8, 9] },
    { id: 'UNDER7', direction: 'DIGITUNDER', barrier: 7, label: 'Under 7', digits: [8, 9] },
    { id: 'UNDER8', direction: 'DIGITUNDER', barrier: 8, label: 'Under 8', digits: [9] },
    { id: 'UNDER9', direction: 'DIGITUNDER', barrier: 9, label: 'Under 9', digits: [9] }
  ];

  // counts[d] = how many of the last n ticks ended in digit d.
  // Integer maths only (count*100 against LIMIT*n), so "exactly 10%" is never lost to rounding.
  function evaluate(counts, n, digits) {
    if (!(n > 0)) return { ok: false, atLimit: 0, max: 0, pct: [] };
    let atLimit = 0, ok = true, max = 0;
    const pct = digits.map(d => {
      const c = Number(counts[d]) || 0, p = c * 100 / n;
      if (p > max) max = p;
      if (c * 100 > LIMIT * n) ok = false;               // above 10%
      else if (c * 100 === LIMIT * n) atLimit++;         // exactly 10%
      return { digit: d, pct: p };
    });
    if (atLimit > 1) ok = false;                         // only ONE digit may sit on 10%
    return { ok, atLimit, max, pct };
  }

  function countsOf(digits, n) {
    const c = Array(10).fill(0), from = Math.max(0, digits.length - n);
    for (let i = from; i < digits.length; i++) c[digits[i]]++;
    return c;
  }

  // markets: iterable of { symbol, name, vol, ready, digits[] } (TickHub.markets.values()).
  // Only Volatility markets are looked at. Returns the qualifying (market, trade type) pairs, tightest first.
  function scan(markets, windowN, minTicks) {
    const need = minTicks || Math.min(windowN, 100), out = [];
    let scanned = 0;
    for (const mk of markets) {
      if (!mk || !mk.vol || !mk.ready || !mk.digits || mk.digits.length < need) continue;
      scanned++;
      const n = Math.min(windowN, mk.digits.length), counts = countsOf(mk.digits, n);
      for (const rule of RULES) {
        const r = evaluate(counts, n, rule.digits);
        if (r.ok) out.push({ key: mk.symbol + '|' + rule.id, symbol: mk.symbol, name: mk.name, rule, n, pct: r.pct, atLimit: r.atLimit, max: r.max });
      }
    }
    out.sort((a, b) => a.max - b.max || a.name.localeCompare(b.name));
    return { list: out, scanned };
  }

  const api = { LIMIT, RULES, evaluate, countsOf, scan };
  root.ScannerLogic = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
