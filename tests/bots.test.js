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
console.log('\nBot tests passed.');
