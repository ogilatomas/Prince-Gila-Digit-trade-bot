// Tests for the Volatility Scanner rules (public/scanner-logic.js). No network.
const assert = require('assert');
const S = require('../public/scanner-logic.js');
const ok = n => console.log('  ✓', n);
const rule = id => S.RULES.find(r => r.id === id);
// 1000 ticks: give digits in `over` exactly the listed counts, spread the rest evenly over the other digits.
function counts(spec) {
  const c = Array(10).fill(0); let used = 0;
  Object.entries(spec).forEach(([d, n]) => { c[d] = n; used += n; });
  const rest = Object.keys(c).filter(d => !(d in spec)); let left = 1000 - used;
  rest.forEach((d, i) => { const share = Math.floor(left / (rest.length - i)); c[d] = share; left -= share; });
  return c;
}
const digitsFrom = c => c.flatMap((n, d) => Array(n).fill(d));

console.log('Rule table');
assert.deepStrictEqual(S.RULES.map(r => r.id), ['OVER2', 'OVER3', 'OVER4', 'OVER5', 'UNDER6', 'UNDER7', 'UNDER8', 'UNDER9']); ok('Over 2,3,4,5 and Under 6,7,8,9');
assert.deepStrictEqual(rule('OVER3').digits, [0, 1, 2]); ok('Over 3 checks 0,1,2');
assert.deepStrictEqual(rule('OVER2').digits, [0, 1]); assert.deepStrictEqual(rule('OVER4').digits, [0, 1, 2, 3]); assert.deepStrictEqual(rule('OVER5').digits, [0, 1, 2, 3, 4]); ok('Over 2 / 4 / 5 check the digits below the barrier');
assert.deepStrictEqual(rule('UNDER6').digits, [7, 8, 9]); assert.deepStrictEqual(rule('UNDER7').digits, [8, 9]); assert.deepStrictEqual(rule('UNDER8').digits, [9]); assert.deepStrictEqual(rule('UNDER9').digits, [9]); ok('Under 6..9 check the digits above the barrier (Under 9 checks 9)');

console.log('The 10% rule');
const D = [0, 1, 2];
assert.equal(S.evaluate(counts({ 0: 90, 1: 95, 2: 99 }), 1000, D).ok, true); ok('all below 10% qualifies');
assert.equal(S.evaluate(counts({ 0: 90, 1: 100, 2: 99 }), 1000, D).ok, true); ok('one digit exactly on 10% still qualifies');
assert.equal(S.evaluate(counts({ 0: 100, 1: 100, 2: 90 }), 1000, D).ok, false); ok('two digits on 10% does not qualify');
assert.equal(S.evaluate(counts({ 0: 90, 1: 101, 2: 90 }), 1000, D).ok, false); ok('a digit above 10% (10.1%) does not qualify');
assert.equal(S.evaluate(counts({ 0: 50, 1: 50, 2: 50 }), 1000, D).ok, true); ok('very low digits qualify');
assert.equal(S.evaluate([10, 5, 5, 20, 20, 10, 10, 10, 5, 5], 100, D).ok, true); ok('exact 10% works on a 100-tick window too (10 of 100)');
assert.equal(S.evaluate(Array(10).fill(0), 0, D).ok, false); ok('no ticks -> never qualifies');
assert.equal(S.evaluate(counts({ 9: 100 }), 1000, [9]).ok, true); assert.equal(S.evaluate(counts({ 9: 101 }), 1000, [9]).ok, false); ok('single-digit group (Under 8 / 9): 10% ok, above not');

console.log('Scanning markets');
const good = counts({ 0: 90, 1: 95, 2: 99 });                  // digits 3-9 hold the rest, so 3 is high, 7/8/9 ~ 10.7% -> no Under
const mk = (symbol, vol, c, extra) => Object.assign({ symbol, name: symbol, vol, ready: true, digits: digitsFrom(c) }, extra);
let r = S.scan([mk('R_75', true, good)], 1000);
assert.ok(r.list.some(q => q.rule.id === 'OVER3') && r.list.some(q => q.rule.id === 'OVER2')); ok('a market with low 0,1,2 qualifies for Over 3 (and Over 2)');
assert.ok(!r.list.some(q => q.rule.id === 'OVER4')); ok('...but not for Over 4 when digit 3 is high');
r = S.scan([mk('CRASH500', false, good)], 1000);
assert.equal(r.list.length, 0); assert.equal(r.scanned, 0); ok('non-volatility markets are ignored');
r = S.scan([mk('R_10', true, good, { ready: false })], 1000);
assert.equal(r.scanned, 0); ok('markets still loading are skipped');
r = S.scan([mk('1HZ100V', true, counts({ 7: 80, 8: 90, 9: 95 }))], 1000);
assert.deepStrictEqual(r.list.map(q => q.rule.id).sort(), ['UNDER6', 'UNDER7', 'UNDER8', 'UNDER9']); ok('low 7,8,9 qualifies for Under 6,7,8,9');
const tight = mk('A', true, counts({ 0: 40, 1: 40, 2: 40 })), loose = mk('B', true, counts({ 0: 95, 1: 95, 2: 95 }));
r = S.scan([loose, tight], 1000);
assert.equal(r.list.find(q => q.rule.id === 'OVER3').symbol, 'A'); ok('the tightest market is listed first');
console.log('\nScanner tests passed.');
