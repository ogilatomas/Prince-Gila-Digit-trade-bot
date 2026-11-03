/* bot-logic.js — pure rules for the Over/Under & Even/Odd auto-bot and the golden floating scanner bot.
 * No page access here, so it can be tested in Node (tests/bots.test.js). The server still enforces
 * stake limits, loss limits and real-money confirmation on every trade. */
(function (root) {
  'use strict';

  const TYPES = {
    DIGITOVER:  { label: 'Over',  barrier: true, min: 0, max: 8 },
    DIGITUNDER: { label: 'Under', barrier: true, min: 1, max: 9 },
    DIGITEVEN:  { label: 'Even' },
    DIGITODD:   { label: 'Odd' }
  };
  const NEEDS = { once: 1, twice: 2, thrice: 3 };

  // "0,1,2" / "012" / "0 1 2" -> [0,1,2]
  function parseDigits(text) {
    const out = new Set();
    String(text == null ? '' : text).replace(/\d/g, d => { out.add(Number(d)); return d; });
    return [...out].sort((a, b) => a - b);
  }

  // The digits that would make the chosen trade LOSE (the bot waits for a run of these, then enters).
  //   Over 3  -> 0,1,2     Under 6 -> 7,8,9     Even -> odd digits     Odd -> even digits
  function defaultEntry(type, barrier) {
    const b = Number(barrier), all = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    if (type === 'DIGITOVER') return all.filter(d => d < b);
    if (type === 'DIGITUNDER') return all.filter(d => d > b);
    if (type === 'DIGITEVEN') return all.filter(d => d % 2 === 1);
    if (type === 'DIGITODD') return all.filter(d => d % 2 === 0);
    return [];
  }

  function effectiveEntry(cfg) {
    const typed = parseDigits(cfg.entryText);
    return typed.length ? typed : defaultEntry(cfg.type, cfg.barrier);
  }

  function validate(cfg) {
    const t = TYPES[cfg.type];
    if (!t) return 'Choose Over, Under, Even or Odd.';
    if (!cfg.symbol) return 'Pick a market.';
    const ticks = Number(cfg.ticks);
    if (!Number.isInteger(ticks) || ticks < 1 || ticks > 10) return 'Ticks must be a whole number from 1 to 10.';
    const times = cfg.times === undefined || cfg.times === null || cfg.times === '' ? 1 : Number(cfg.times);
    if (!Number.isInteger(times) || times < 1 || times > 10) return 'Trades each time must be a whole number from 1 to 10.';
    const stake = Number(cfg.stake);
    if (!Number.isFinite(stake) || stake <= 0) return 'Enter a stake above 0.';
    if (Number.isFinite(Number(cfg.maxStake)) && Number(cfg.maxStake) > 0 && stake > Number(cfg.maxStake)) return `Stake is above your Max Stake (${cfg.maxStake}).`;
    if (t.barrier) {
      const b = Number(cfg.barrier);
      if (cfg.barrier === null || cfg.barrier === undefined || cfg.barrier === '' || !Number.isInteger(b) || b < t.min || b > t.max)
        return `${t.label} needs a digit barrier from ${t.min} to ${t.max}.`;
    }
    if (!cfg.continuous) {                       // Continuous mode ignores entry digits, so only check them otherwise
      if (!NEEDS[cfg.need]) return 'Pick Once, Twice or Thrice for the trade entry.';
      if (!effectiveEntry(cfg).length) return 'Type the digits the bot should watch for (nothing to watch by default for this barrier).';
    }
    return null;
  }

  // Trade body for POST /api/deriv/trade. source/sid 'bot' keeps these out of the strategy alerts and the auto-switch rule.
  function buildBody(cfg, extra) {
    const t = TYPES[cfg.type];
    const body = { symbol: cfg.symbol, direction: cfg.type, duration: Number(cfg.ticks), stake: Math.round(Number(cfg.stake) * 100) / 100, sid: 'bot', source: 'bot' };
    let label = t.label;
    if (t.barrier) { body.barrier = Number(cfg.barrier); label += ' ' + body.barrier; }
    body.strategy = `AutoBot · ${label} · ${cfg.continuous ? 'continuous' : cfg.need}`;
    return Object.assign(body, extra || {});
  }

  // Counts consecutive ticks whose last digit is in `set`. push() returns true the moment the run reaches `need`.
  function makeStreak(set, need) {
    const watch = new Set(set); let n = 0;
    return {
      push(d) { if (watch.has(d)) n++; else n = 0; if (n >= need) { n = 0; return true; } return false; },
      get count() { return n; },
      reset() { n = 0; }
    };
  }

  // ---- trade queue: no entry chance is skipped ----------------------------------------------
  // Deriv trades run one at a time. An entry that appears while a trade is still open is queued and
  // placed the moment that trade settles. MAX_QUEUE is only a runaway guard.
  const MAX_QUEUE = 50;

  // How many trades one tick should add to the queue.
  //   Continuous ON : every tick, but only when nothing is open or waiting (so it never piles up).
  //   Continuous OFF: only when the entry digits have just appeared (`hit`), even if a trade is open.
  function tradesToQueue(cfg, ev) {
    const times = Math.min(10, Math.max(1, Math.floor(Number(cfg.times)) || 1));
    if (cfg.continuous) return !ev.busy && !ev.pending ? times : 0;
    return ev.hit ? times : 0;
  }

  function makeQueue() {
    let pending = 0;
    return {
      get pending() { return pending; },
      add(n) { const room = Math.max(0, MAX_QUEUE - pending), a = Math.min(Math.max(0, n | 0), room); pending += a; return a; },
      take() { if (pending > 0) { pending--; return true; } return false; },
      clear() { pending = 0; }
    };
  }

  // ---- floating scanner bot: market qualification --------------------------------------------
  const STAGES = [
    { id: 'diff',   label: 'Differs',  short: 'DIFF' },
    { id: 'over0',  label: 'Over 0',   short: 'OVER 0' },
    { id: 'under9', label: 'Under 9',  short: 'UNDER 9' }
  ];

  function countsOf(digits, n) {
    const c = Array(10).fill(0), start = Math.max(0, digits.length - n);
    for (let i = start; i < digits.length; i++) c[digits[i]]++;
    return c;
  }

  // Does a market qualify for this stage?  Returns { direction, barrier, score, label } or null.
  //   diff   : Differs, barrier = the single most frequent digit
  //   over0  : Over 0, only if digit 0 is the single least frequent digit
  //   under9 : Under 9, only if digit 9 is the single least frequent digit
  function stageCheck(id, counts) {
    const total = counts.reduce((a, b) => a + b, 0);
    if (!total) return null;
    const pct = counts.map(c => c / total * 100);
    if (id === 'diff') {
      const mx = Math.max(...counts);
      if (counts.filter(c => c === mx).length !== 1) return null;
      const d = counts.indexOf(mx);
      return { direction: 'DIGITDIFF', barrier: d, score: pct[d], label: 'Differs ' + d };
    }
    const lowDigit = id === 'over0' ? 0 : id === 'under9' ? 9 : -1;
    if (lowDigit < 0) return null;
    const mn = Math.min(...counts);
    if (counts[lowDigit] !== mn || counts.filter(c => c === mn).length !== 1) return null;
    return id === 'over0'
      ? { direction: 'DIGITOVER', barrier: 0, score: 100 - pct[0], label: 'Over 0' }
      : { direction: 'DIGITUNDER', barrier: 9, score: 100 - pct[9], label: 'Under 9' };
  }

  // Best qualifying market for a stage (largest margin), or null when none qualifies.
  function pickMarket(id, markets, windowN, minTicks) {
    let best = null;
    for (const mk of markets) {
      if (!mk.digits || mk.digits.length < (minTicks || 100)) continue;
      const q = stageCheck(id, countsOf(mk.digits, Math.min(windowN, mk.digits.length)));
      if (q && (!best || q.score > best.score)) best = Object.assign({ symbol: mk.symbol, name: mk.name }, q);
    }
    return best;
  }

  const api = { TYPES, NEEDS, STAGES, parseDigits, defaultEntry, effectiveEntry, validate, buildBody, makeStreak, tradesToQueue, makeQueue, MAX_QUEUE, countsOf, stageCheck, pickMarket };
  root.BotLogic = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
