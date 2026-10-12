/* strategies.js — Original Strategies + Major Scanner for the DigitTrade dashboard.
 *
 * Reads the live ticks from live-feed.js (window.DerivFeed), works out the signals,
 * fills the two floating panels, and (only if you switch it on) sends trades to the
 * server, which applies your loss limits.
 *
 * Add to public/index.html AFTER risk.js:
 *   <script src="strategies.js"></script>
 *
 * Everything you may want to tune is in the CONFIG block below.
 */
(() => {
  'use strict';

  // ===========================================================================
  // CONFIG
  // ===========================================================================
  const CONFIG = {
    WINDOW_ORIGINAL: 1000,          // ticks used by the Original strategies
    WINDOW_MAJOR: 500,              // ticks used by the Major Scanner
    OVER_CANDIDATES: [2, 3, 4],     // Over/Under strategy: same barriers as your Smart Strategy rules
    UNDER_CANDIDATES: [6, 7, 8],
    EVEN_ODD_MIN_GAP: 5,            // percentage points
    MATCHES_MIN_PCT: 15,
    HOT_PCT: 13, COLD_PCT: 8,
    MAJOR_MIN_COUNT: 50,            // occurrences needed in 500 ticks (= 10%)
    MAJOR_BREAKOUT_MAX_HIGH: 2,     // breakout digits allowed to reach MAJOR_MIN_COUNT
    FINAL_TWO_CHECK: true,          // Major Scanner: the last TWO digits must both be breakout digits
    HOLD_MS: 10000,                 // keep a momentary Major signal visible this long
    LOG_THROTTLE_MS: 60000,         // at most one log row per strategy+market per minute
    BUY_COOLDOWN_MS: 15000,         // minimum gap between ANY two auto-buys
    PER_KEY_COOLDOWN_MS: 120000     // minimum gap per strategy+market
  };

  // Major Scanner rules. dominant = digits that WIN the contract, breakout = digits that lose it.
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const MAJOR = [
    { id: 'UNDER3', type: 'DIGITUNDER', barrier: 3, dominant: range(0, 2), breakout: range(3, 9), allowDominantMisses: 0 },
    { id: 'UNDER4', type: 'DIGITUNDER', barrier: 4, dominant: range(0, 3), breakout: range(4, 9), allowDominantMisses: 0 },
    { id: 'OVER6',  type: 'DIGITOVER',  barrier: 6, dominant: range(7, 9), breakout: range(0, 6), allowDominantMisses: 0 },
    { id: 'OVER7',  type: 'DIGITOVER',  barrier: 7, dominant: range(8, 9), breakout: range(0, 7), allowDominantMisses: 0 }
  ];

  const ORIGINAL_IDS = ['overunder', 'differs', 'evenodd', 'matches', 'hotcold'];
  const MAJOR_IDS = MAJOR.map(r => r.id);
  const ALL_IDS = [...ORIGINAL_IDS, ...MAJOR_IDS];
  const MOMENTARY = new Set(MAJOR_IDS);
  const NOT_TRADABLE = new Set(['hotcold']);

  // ===========================================================================
  // Pure signal calculations (no page access)
  // ===========================================================================
  const countsOf = arr => { const c = Array(10).fill(0); arr.forEach(d => c[d]++); return c; };
  const pctOf = (c, n) => c.map(x => (n ? (x / n) * 100 : 0));
  const sum = (p, from, to) => { let s = 0; for (let d = from; d <= to; d++) s += p[d]; return s; };

  function evalOverUnder(c, n) {
    const p = pctOf(c, n);
    let best = null;
    CONFIG.OVER_CANDIDATES.forEach(N => {            // Over N loses on digits 0..N
      for (let d = 0; d <= N; d++) if (p[d] >= 10) return;
      const win = sum(p, N + 1, 9), edge = win - (9 - N) * 10;
      if (!best || edge > best.edge) best = {
        name: 'Over/Under', type: 'DIGITOVER', barrier: N, short: `OVER ${N}`, edge,
        key: `DIGITOVER:${N}`,
        detail: `Over ${N}: digits 0-${N} all below 10%; win share ${win.toFixed(1)}% (${edge >= 0 ? '+' : ''}${edge.toFixed(1)} vs uniform)`
      };
    });
    CONFIG.UNDER_CANDIDATES.forEach(N => {           // Under N loses on digits N..9
      for (let d = N; d <= 9; d++) if (p[d] >= 10) return;
      const win = sum(p, 0, N - 1), edge = win - N * 10;
      if (!best || edge > best.edge) best = {
        name: 'Over/Under', type: 'DIGITUNDER', barrier: N, short: `UNDER ${N}`, edge,
        key: `DIGITUNDER:${N}`,
        detail: `Under ${N}: digits ${N}-9 all below 10%; win share ${win.toFixed(1)}% (${edge >= 0 ? '+' : ''}${edge.toFixed(1)} vs uniform)`
      };
    });
    return best;
  }

  const diffPick = new Map(); // symbol -> barrier kept stable between ticks (random tie-break once)
  function evalDiffers(symbol, c, n) {
    const max = Math.max(...c);
    const tops = c.map((v, i) => (v === max ? i : -1)).filter(i => i >= 0);
    let d = diffPick.get(symbol);
    if (d === undefined || !tops.includes(d)) {
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
    const type = ep < op ? 'DIGITEVEN' : 'DIGITODD';          // propose the LESS frequent parity
    return {
      name: 'Even/Odd', type, barrier: undefined, short: ep < op ? 'EVEN' : 'ODD', key: type,
      detail: `Even ${ep.toFixed(1)}% vs Odd ${op.toFixed(1)}%: proposing the less frequent (${ep < op ? 'Even' : 'Odd'})`
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

  function evalHotCold(digits) {                    // two rolling windows: last 500 and the 500 before
    const a = digits.slice(-500), b = digits.slice(-1000, -500);
    const pa = pctOf(countsOf(a), a.length), pb = pctOf(countsOf(b), b.length);
    const hot = [], cold = [];
    for (let d = 0; d <= 9; d++) {
      if (pa[d] >= CONFIG.HOT_PCT && pb[d] >= CONFIG.HOT_PCT) hot.push(d);
      if (pa[d] <= CONFIG.COLD_PCT && pb[d] <= CONFIG.COLD_PCT) cold.push(d);
    }
    if (!hot.length && !cold.length) return null;
    return {
      name: 'Hot/Cold', type: null, short: `Hot ${hot.join(',') || '-'} · Cold ${cold.join(',') || '-'}`,
      key: `HC:${hot.join('')}:${cold.join('')}`, tradable: false,
      detail: `Hot (>=${CONFIG.HOT_PCT}% in both windows): ${hot.join(', ') || 'none'}; Cold (<=${CONFIG.COLD_PCT}%): ${cold.join(', ') || 'none'}`
    };
  }

  function evalMajor(digits, rule, epoch) {
    const w = digits.slice(-CONFIG.WINDOW_MAJOR), c = countsOf(w);
    const domMiss = rule.dominant.filter(d => c[d] < CONFIG.MAJOR_MIN_COUNT).length;
    const brkHigh = rule.breakout.filter(d => c[d] >= CONFIG.MAJOR_MIN_COUNT).length;
    if (domMiss > rule.allowDominantMisses || brkHigh > CONFIG.MAJOR_BREAKOUT_MAX_HIGH) return null;
    let top = rule.breakout[0];
    rule.breakout.forEach(d => { if (c[d] > c[top]) top = d; });
    const last = w[w.length - 1], prev = w[w.length - 2];
    if (last !== top) return null;                                   // entry: latest digit = most frequent breakout digit
    if (CONFIG.FINAL_TWO_CHECK && !rule.breakout.includes(prev)) return null;
    return {
      name: rule.id, type: rule.type, barrier: rule.barrier, short: `${rule.id} (entry ${top})`,
      key: `${rule.type}:${rule.barrier}:${epoch}`,
      detail: `${rule.id}: ${domMiss} dominant misses, ${brkHigh} breakout digits at ${CONFIG.MAJOR_MIN_COUNT}+; last two digits ${prev},${last}`
    };
  }

  function evaluateDigits(symbol, digits, counts, epoch) {
    const out = {};
    if (digits.length >= CONFIG.WINDOW_ORIGINAL) {
      const n = digits.length;
      out.overunder = evalOverUnder(counts, n);
      out.differs = evalDiffers(symbol, counts, n);
      out.evenodd = evalEvenOdd(counts, n);
      out.matches = evalMatches(counts, n);
      out.hotcold = evalHotCold(digits);
    }
    if (digits.length >= CONFIG.WINDOW_MAJOR) {
      MAJOR.forEach(r => { out[r.id] = evalMajor(digits, r, epoch); });
    }
    return out;                                    // missing id = not enough ticks yet; null = no signal
  }

  // ===========================================================================
  // Page wiring
  // ===========================================================================
  const $ = id => document.getElementById(id);
  const sigs = {}; ALL_IDS.forEach(id => { sigs[id] = new Map(); });   // id -> Map(symbol -> signal|null)
  const lastKey = new Map(), lastLog = new Map(), lastBuy = new Map();
  let lastAnyBuy = 0, busy = false, dirty = true;

  const shortName = n => String(n || '').replace(/^Volatility\s*/i, 'V').replace(/\s*Index$/i, '');

  function logRow(strategy, barrier, stake, status) {
    const tbody = $('tradeRows');
    if (!tbody) return;
    if (tbody.querySelector('td[colspan]')) tbody.innerHTML = '';
    const tr = document.createElement('tr');
    [new Date().toLocaleTimeString(), strategy, barrier === undefined ? '—' : barrier, stake, status].forEach(v => {
      const td = document.createElement('td'); td.textContent = v; tr.appendChild(td);
    });
    tbody.prepend(tr);
    while (tbody.children.length > 40) tbody.lastElementChild.remove();
  }

  const autoOn = id => {
    const el = $(MAJOR_IDS.includes(id) ? 'autoMajor' : 'autoOriginal');
    return !!(el && el.checked);
  };
  function turnOffAuto() {
    ['autoOriginal', 'autoMajor'].forEach(i => { const el = $(i); if (el) el.checked = false; });
  }

  async function maybeBuy(id, mk, sig, k) {
    if (NOT_TRADABLE.has(id) || sig.tradable === false || !sig.type || !autoOn(id)) return;
    const now = Date.now();
    if (busy || now - lastAnyBuy < CONFIG.BUY_COOLDOWN_MS || now - (lastBuy.get(k) || 0) < CONFIG.PER_KEY_COOLDOWN_MS) return;
    busy = true; lastAnyBuy = now; lastBuy.set(k, now);
    const stake = Number($('stake').value);
    const label = `${sig.name} · ${shortName(mk.name)}`;
    try {
      const maxStake = Number($('maxStake').value);
      if (!(stake > 0) || stake > maxStake) throw new Error('Stake must be positive and not above Max Stake.');
      if ($('mode').value !== 'Demo') throw new Error('Auto-buy for these strategies is demo-only.');
      const acc = await (await fetch('/api/deriv/accounts', { credentials: 'same-origin' })).json();
      const active = acc.connected && (acc.accounts || []).find(a => a.loginid === acc.active);
      if (!active || !active.isVirtual) throw new Error('Connect a Deriv DEMO account first.');
      const body = { symbol: mk.symbol, direction: sig.type, duration: Number($('tradeTicks')?.value || 5), stake, strategy: sig.name, confirmReal: false };
      if (sig.barrier !== undefined) body.barrier = sig.barrier;
      const res = await fetch('/api/deriv/trade', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      const d = await res.json().catch(() => ({}));
      if (res.status === 409) return;                                  // another trade still running: skip quietly
      if (res.status === 403 && d.halted) {                            // risk limit reached
        turnOffAuto();
        logRow(label, sig.barrier, stake, 'AUTO-BUY OFF: ' + d.error);
        return;
      }
      if (!res.ok) throw new Error(d.error || 'Purchase failed.');
      logRow(label, sig.barrier, stake, `BOUGHT #${d.contractId} · P/L ${d.profit}`);
    } catch (err) {
      logRow(label, sig.barrier, stake, 'NOT BOUGHT: ' + err.message);
    } finally {
      busy = false;
    }
  }

  function store(id, symbol, sig) {
    const m = sigs[id], prev = m.get(symbol);
    if (sig) { sig.at = Date.now(); m.set(symbol, sig); }
    else if (MOMENTARY.has(id) && prev && Date.now() - prev.at < CONFIG.HOLD_MS) { /* keep showing it briefly */ }
    else m.set(symbol, null);
  }

  function onTick(ev) {
    const feed = window.DerivFeed;
    const mk = feed && feed.markets.get(ev.symbol);
    if (!mk) return;
    const result = evaluateDigits(mk.symbol, mk.digits, mk.counts, ev.epoch);
    Object.keys(result).forEach(id => {
      const sig = result[id];
      store(id, mk.symbol, sig);
      const k = id + '|' + mk.symbol;
      const key = sig ? sig.key : null, prev = lastKey.get(k);
      lastKey.set(k, key);
      if (!sig || key === prev || sig.tradable === false) return;      // act only on a NEW signal
      const now = Date.now();
      if (now - (lastLog.get(k) || 0) >= CONFIG.LOG_THROTTLE_MS) {
        lastLog.set(k, now);
        logRow(`${sig.name} · ${shortName(mk.name)}`, sig.barrier, '—', 'SIGNAL');
      }
      maybeBuy(id, { symbol: mk.symbol, name: mk.name }, sig, k);
    });
    dirty = true;
  }

  // ---- floating panels -------------------------------------------------------
  const PANELS = [{ panel: 'monitor1', ids: ORIGINAL_IDS }, { panel: 'monitor2', ids: MAJOR_IDS }];

  function paint() {
    if (!dirty) return;
    dirty = false;
    const feed = window.DerivFeed;
    PANELS.forEach(p => {
      const rows = document.querySelectorAll('#' + p.panel + ' > div');
      p.ids.forEach((id, i) => {
        const row = rows[i], b = row && row.querySelector('b');
        if (!b) return;
        const m = sigs[id];
        let text, colour, title = '';
        if (m.size === 0) { text = 'Waiting'; colour = '#ffc857'; }
        else {
          const active = [...m.entries()].filter(([, s]) => s);
          if (!active.length) { text = 'No signal'; colour = '#9fb7c9'; }
          else {
            const nameOf = sym => shortName((feed && feed.markets.get(sym) || {}).name || sym);
            const [sym0, s0] = active[0];
            text = `${nameOf(sym0)} ${s0.short}` + (active.length > 1 ? ` +${active.length - 1}` : '');
            colour = '#00f59b';
            title = active.map(([sym, s]) => `${nameOf(sym)}: ${s.detail}`).join('\n');
          }
        }
        b.textContent = text; b.style.color = colour; row.title = title;
      });
    });
  }

  // ---- auto-buy switches (added under the Smart Strategy rule boxes) ---------
  function addControls() {
    const anchor = document.querySelector('#smartStrategy .smart-rules');
    if (!anchor || $('stratControls')) return;
    const box = document.createElement('div');
    box.className = 'smart-rules'; box.id = 'stratControls';
    box.innerHTML =
      '<label><input type="checkbox" id="autoOriginal"> Auto-buy: Original strategies (Over/Under, Differs, Even/Odd, Matches)</label>' +
      '<label><input type="checkbox" id="autoMajor"> Auto-buy: Major Scanner (UNDER3, UNDER4, OVER6, OVER7)</label>' +
      '<span class="muted">Off by default. Demo accounts only. Your loss limits apply.</span>';
    anchor.insertAdjacentElement('afterend', box);
    ['autoOriginal', 'autoMajor'].forEach(id => {
      $(id).addEventListener('change', e => {
        if (!e.target.checked) return;
        if ($('mode').value !== 'Demo') { e.target.checked = false; alert('Switch the dashboard to Demo first.'); return; }
        const ok = window.confirm(
          'Turn on auto-buy?\n\nEvery new signal in this group will buy a ' + $('stake').value +
          ' contract on your connected DEMO account, subject to your loss limits.\n\nSignals are statistics, not predictions.');
        if (!ok) e.target.checked = false;
      });
    });
  }

  function start() {
    const note = document.querySelector('#monitor2 small');
    if (note) note.textContent = 'Signals are not predictions. Auto-buy is off unless you switch it on (demo only).';
    addControls();
    setInterval(paint, 500);
    window.DerivFeed.onTick(onTick);
  }

  // Test hook: lets the signal maths be checked without a browser.
  window.StrategyEngine = { CONFIG, MAJOR, evaluateDigits, evalOverUnder, evalEvenOdd, evalMatches, evalHotCold, evalMajor };

  (function waitForFeed() {
    if (window.DerivFeed && window.DerivFeed.markets) start();
    else setTimeout(waitForFeed, 500);
  })();
})();
