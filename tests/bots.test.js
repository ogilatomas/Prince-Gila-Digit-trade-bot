// Tests for the auto-bot rules (public/bot-logic.js). No network.
const assert = require('assert');
const B = require('../public/bot-logic.js');
const ok = n => console.log('  ✓', n);
const base = { symbol: 'R_100', type: 'DIGITOVER', barrier: 3, ticks: 1, stake: 1, need: 'twice', entryText: '' };

console.log('Entry digits');
assert.deepStrictEqual(B.parseDigits('0,1 & 2'), [0, 1, 2]); assert.deepStrictEqual(B.parseDigits('210'), [0, 1, 2]); ok('typed digits are parsed (any separator)');
assert.deepStrictEqual(B.defaultEntry('DIGITOVER', 3), [0, 1, 2]); ok('Over 3 watches 0,1,2');
assert.deepStrictEqual(B.defaultEntry('DIGITUNDER', 6), [7, 8, 9]); ok('Under 6 watches 7,8,9');
assert.deepStrictEqual(B.defaultEntry('DIGITEVEN'), [1, 3, 5, 7, 9]); assert.deepStrictEqual(B.defaultEntry('DIGITODD'), [0, 2, 4, 6, 8]); ok('Even watches odd digits, Odd watches even digits');
assert.deepStrictEqual(B.effectiveEntry({ ...base, entryText: '4,5' }), [4, 5]); ok('typed digits override the default');

console.log('Validation');
assert.equal(B.validate(base), null); ok('valid config passes');
assert.ok(B.validate({ ...base, type: 'DIGITOVER', barrier: 9 })); ok('Over 9 refused');
assert.ok(B.validate({ ...base, type: 'DIGITUNDER', barrier: 0 })); ok('Under 0 refused');
assert.ok(B.validate({ ...base, barrier: 0 })); ok('Over 0 with no typed digits refused (nothing to watch)');
assert.equal(B.validate({ ...base, barrier: 0, entryText: '0' }), null); ok('Over 0 with typed digits is fine');
assert.ok(B.validate({ ...base, ticks: 0 }) && B.validate({ ...base, ticks: 11 })); ok('ticks must be 1-10');
assert.ok(B.validate({ ...base, stake: 0 })); ok('zero stake refused');
assert.ok(B.validate({ ...base, need: 'four' })); ok('trade entry must be once/twice/thrice');
assert.equal(B.validate({ ...base, type: 'DIGITEVEN', barrier: null }), null); ok('Even needs no barrier');

console.log('Consecutive entry');
let s = B.makeStreak([0, 1, 2], 2), fired = [];
[5, 1, 7, 0, 2, 4].forEach(d => fired.push(s.push(d)));
assert.deepStrictEqual(fired, [false, false, false, false, true, false]); ok('Over 3, twice: fires on the 2nd of two watched digits in a row');
s = B.makeStreak([0, 1, 2], 2); fired = [0, 9, 1].map(d => s.push(d)); assert.deepStrictEqual(fired, [false, false, false]); ok('a non-watched digit breaks the run');
s = B.makeStreak([1, 3, 5, 7, 9], 1); assert.equal(s.push(3), true); ok('Even, once: fires on a single odd digit');
s = B.makeStreak([1, 3, 5, 7, 9], 3); assert.deepStrictEqual([1, 3, 9, 5].map(d => s.push(d)), [false, false, true, false]); ok('thrice needs three in a row, then starts over');

console.log('Trade body');
const body = B.buildBody({ ...base, need: 'twice' }, { confirmReal: false });
assert.equal(body.direction, 'DIGITOVER'); assert.equal(body.barrier, 3); assert.equal(body.duration, 1); assert.equal(body.source, 'bot'); assert.equal(body.confirmReal, false); ok('Over 3, 1 tick, tagged as bot');
assert.equal(B.buildBody({ ...base, type: 'DIGITEVEN' }).barrier, undefined); ok('Even carries no barrier');

console.log('Scanner bot qualification');
const mk = (sym, counts) => ({ symbol: sym, name: sym, digits: counts.flatMap((c, d) => Array(c).fill(d)) });
const A = mk('A', [90, 100, 100, 100, 100, 100, 100, 100, 100, 110]);     // top digit 9, least digit 0
const Bm = mk('B', [100, 100, 100, 100, 100, 100, 100, 100, 110, 90]);   // top digit 8, least digit 9
const Cm = mk('C', [100, 100, 100, 100, 100, 100, 100, 100, 100, 100]);  // flat: nothing qualifies
assert.equal(B.pickMarket('diff', [A, Bm, Cm], 1000).barrier, 9); ok('Differs picks the most frequent digit as the barrier');
assert.equal(B.pickMarket('over0', [A, Bm, Cm], 1000).symbol, 'A'); ok('Over 0 only on a market where 0 is the least frequent digit');
assert.equal(B.pickMarket('under9', [A, Bm, Cm], 1000).symbol, 'B'); ok('Under 9 only on a market where 9 is the least frequent digit');
assert.equal(B.pickMarket('over0', [Bm, Cm], 1000), null); ok('no qualifying market -> null (the bot skips it)');
assert.equal(B.pickMarket('diff', [Cm], 1000), null); ok('a tie for most frequent does not qualify');
assert.equal(B.pickMarket('diff', [{ symbol: 'X', name: 'X', digits: [1, 2, 3] }], 1000, 100), null); ok('too few ticks -> not scanned yet');

console.log('Continuous mode, trades each time, no skipped entries');
assert.equal(B.validate({ ...base, continuous: true, need: 'bogus', barrier: 0 }), null); ok('Continuous ignores entry digits / entry count');
assert.ok(B.validate({ ...base, times: 0 }) && B.validate({ ...base, times: 11 }) && B.validate({ ...base, times: 2.5 })); ok('trades each time must be 1-10');
assert.equal(B.validate({ ...base, times: 10 }), null); ok('10 trades each time is allowed');
assert.equal(B.tradesToQueue({ continuous: true, times: 3 }, { hit: false, busy: false, pending: 0 }), 3); ok('Continuous: idle tick queues the chosen number of trades');
assert.equal(B.tradesToQueue({ continuous: true, times: 3 }, { hit: false, busy: true, pending: 0 }), 0); ok('Continuous: no pile-up while a trade is open');
assert.equal(B.tradesToQueue({ continuous: true, times: 3 }, { hit: false, busy: false, pending: 2 }), 0); ok('Continuous: waits until the batch has been placed');
assert.equal(B.tradesToQueue({ continuous: false, times: 2 }, { hit: true, busy: true, pending: 5 }), 2); ok('Entry mode: an entry seen while busy is still queued');
assert.equal(B.tradesToQueue({ continuous: false, times: 2 }, { hit: false, busy: false, pending: 0 }), 0); ok('Entry mode: nothing without an entry');
const q = B.makeQueue(); assert.equal(q.add(3), 3); assert.equal(q.take(), true); assert.equal(q.pending, 2); q.clear(); assert.equal(q.take(), false); ok('queue add / take / clear');
const q2 = B.makeQueue(); q2.add(B.MAX_QUEUE); assert.equal(q2.add(1), 0); ok('queue has a runaway cap');
assert.ok(B.buildBody({ ...base, continuous: true }).strategy.includes('continuous')); ok('trade label shows continuous');

// Simulation: Over 3 (entry digits 0,1,2, once). Each trade stays open for 2 ticks. No entry may be lost.
(function () {
  const cfg = { ...base, need: 'once', continuous: false, times: 1 };
  const streak = B.makeStreak(B.effectiveEntry(cfg), 1), queue = B.makeQueue();
  let busyFor = 0, placed = 0;
  const digits = [5, 1, 2, 7, 0, 9, 1, 1, 8, 2];           // entry digits: 1,2,0,1,1,1,2 minus the non-entries -> 6 of them
  const entries = digits.filter(d => [0, 1, 2].includes(d)).length;
  digits.forEach(d => {
    if (busyFor > 0) busyFor--;                            // a trade finishes
    const hit = streak.push(d);
    const add = B.tradesToQueue(cfg, { hit, busy: busyFor > 0, pending: queue.pending });
    queue.add(add);
    if (busyFor === 0 && queue.take()) { placed++; busyFor = 2; }
  });
  while (queue.pending) { if (busyFor > 0) busyFor--; if (busyFor === 0 && queue.take()) { placed++; busyFor = 2; } }
  assert.equal(placed, entries); ok('simulation: every entry digit became a trade (' + placed + ' of ' + entries + ')');
})();

console.log('\nWait after entry digit');
(function () {
  const run = (w, ready) => { const x = B.makeWait(w); return ready.map(r => x.push(r)); };
  assert.deepStrictEqual(run(0, [true, false, true]), [true, false, true]); ok('wait 0: trades on the entry tick (old behaviour)');
  assert.deepStrictEqual(run(3, [true, false, false, false, false]), [false, false, false, true, false]); ok('wait 3: trade is due on the 3rd tick after the entry tick');
  assert.deepStrictEqual(run(1, [true, false, false]), [false, true, false]); ok('wait 1: trade is due on the next tick');
  assert.deepStrictEqual(run(2, [true, true, true, false, true]), [false, false, true, false, false]); ok('entries during the countdown are ignored, then a new entry arms again');
  const x = B.makeWait(4); x.push(true); x.push(false); x.reset();
  assert.deepStrictEqual([x.push(false), x.push(false), x.push(false), x.push(false), x.push(false)], [false, false, false, false, false]); ok('reset() cancels a countdown');
  assert.equal(B.makeWait(500).wait, B.MAX_WAIT); assert.equal(B.makeWait(-3).wait, 0); assert.equal(B.makeWait('abc').wait, 0); ok('wait is clamped to 0-' + B.MAX_WAIT);
  assert.equal(B.validate({ ...base }), null); assert.equal(B.validate({ ...base, waitTicks: '' }), null); assert.equal(B.validate({ ...base, waitTicks: 0 }), null);
  assert.equal(B.validate({ ...base, waitTicks: 50 }), null); ok('valid wait values pass');
  assert.ok(B.validate({ ...base, waitTicks: 51 })); assert.ok(B.validate({ ...base, waitTicks: -1 })); assert.ok(B.validate({ ...base, waitTicks: 2.5 })); assert.ok(B.validate({ ...base, waitTicks: 'x' })); ok('bad wait values refused');

  // Simulation: Over 3, entry digits 0,1,2 once, wait 2. The trade must land exactly 2 ticks after the entry tick.
  const cfg = { ...base, need: 'once', waitTicks: 2 };
  const streak = B.makeStreak(B.effectiveEntry(cfg), 1), wait = B.makeWait(cfg.waitTicks), placedAt = [];
  [5, 1, 8, 8, 7, 0, 9, 9, 4, 2, 6].forEach((d, i) => { if (wait.push(streak.push(d))) placedAt.push(i); });
  assert.deepStrictEqual(placedAt, [3, 7]); ok('simulation: entries at ticks 1 and 5 -> trades exactly 2 ticks later (ticks 3 and 7); entry at tick 9 still counting');
})();
console.log('\nBot tests passed.');
