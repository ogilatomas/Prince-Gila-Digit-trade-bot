// Run with: npm test   (Node 18+, no dependencies)
const assert = require('assert');
let calls = [];                       // trade requests that reached the "server"
let script = [];                      // queued fake server responses
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, init) => {
  const body = init && init.body ? JSON.parse(init.body) : null;
  if (String(url).includes('/api/deriv/trade')) { calls.push(body); const r = script.shift(); return r ? r(body) : json(200, { contractId: calls.length, profit: -1, isWin: false }); }
  return json(200, { ok: true });
};
// live feed with one market whose most frequent digit is 7
const counts = Array(10).fill(90); counts[7] = 190;
globalThis.DerivFeed = { markets: new Map([['R_10', { symbol: 'R_10', name: 'Volatility 10 Index', digits: Array(1000).fill(1), counts }]]) };
const C = require('../public/core.js');
const L = require('../public/strategy-logic.js');
const win = b => json(200, { contractId: 1, profit: 0.95, isWin: true });
const loss = b => json(200, { contractId: 2, profit: -1, isWin: false });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const post = body => fetch('/api/deriv/trade', { method: 'POST', body: JSON.stringify(body) });
let active = true; C.registerOrigin('smart', () => active);
const ok = n => console.log('  ✓', n);

(async () => {
  console.log('Switch rule');
  // 1. Smart Over/Under WIN -> next trade is Differs on the most frequent digit, same stake/ticks
  calls = []; script = [win, win];
  await post({ symbol: 'R_10', direction: 'DIGITOVER', barrier: 3, duration: 1, stake: 2, strategy: 'OVER 3' });
  await sleep(50);
  assert.equal(calls.length, 2); assert.equal(calls[1].direction, 'DIGITDIFF'); assert.equal(calls[1].barrier, 7);
  assert.equal(calls[1].stake, 2); assert.equal(calls[1].duration, 1); ok('OVER win -> DIFFERS (barrier 7, same stake & ticks)');
  assert.equal(C.state.pendingSwitch, null); ok('switch clears after the Differs trade');
  // 2. UNDER win also switches
  calls = []; script = [win, loss];
  await post({ symbol: 'R_10', direction: 'DIGITUNDER', barrier: 7, duration: 1, stake: 1, strategy: 'UNDER 7' }); await sleep(50);
  assert.equal(calls[1].direction, 'DIGITDIFF'); ok('UNDER win -> DIFFERS');
  // 3. A LOSS does not switch
  calls = []; script = [loss];
  await post({ symbol: 'R_10', direction: 'DIGITOVER', barrier: 3, duration: 1, stake: 1 }); await sleep(50);
  assert.equal(calls.length, 1); ok('Over/Under loss -> no switch');
  // 4. A Differs win does not chain
  calls = []; script = [win];
  await post({ symbol: 'R_10', direction: 'DIGITDIFF', barrier: 5, duration: 1, stake: 1 }); await sleep(50);
  assert.equal(calls.length, 1); ok('Differs win -> nothing queued');
  // 5. Rule can be turned off
  C.setSwitchEnabled(false); calls = []; script = [win];
  await post({ symbol: 'R_10', direction: 'DIGITOVER', barrier: 3, duration: 1, stake: 1 }); await sleep(50);
  assert.equal(calls.length, 1); C.setSwitchEnabled(true); ok('rule OFF -> no switch');
  // 6. While the Differs is pending, a new Over/Under entry is held back (never reaches the server)
  calls = []; let release; script = [win, () => new Promise(r => { release = () => r(json(200, { contractId: 9, profit: 0.9, isWin: true })); })];
  await post({ symbol: 'R_10', direction: 'DIGITOVER', barrier: 3, duration: 1, stake: 1 }); await sleep(30);
  const blocked = await post({ symbol: 'R_10', direction: 'DIGITUNDER', barrier: 7, duration: 1, stake: 1, strategy: 'UNDER 7' });
  assert.equal(blocked.status, 409); assert.equal(calls.length, 2); ok('Over/Under entry paused while Differs is pending');
  release(); await sleep(30);
  const after = await post({ symbol: 'R_10', direction: 'DIGITUNDER', barrier: 7, duration: 1, stake: 1 }); assert.equal(after.status, 200); ok('Over/Under resumes after the Differs');

  console.log('Instant stop');
  // 7. Smart stopped before the Differs fires -> Differs never sent
  C.state.queue.length = 0; calls = [];
  script = [() => new Promise(r => setTimeout(() => r(json(200, { contractId: 7, profit: 0.9, isWin: true })), 40))];
  const pending = post({ symbol: 'R_10', direction: 'DIGITOVER', barrier: 3, duration: 1, stake: 1 });
  await sleep(10); active = false;                       // user presses Stop while the Over/Under is still settling
  await pending; await sleep(50); assert.equal(calls.length, 1); active = true; ok('stop while Over/Under settles -> no Differs follow-up');
  // 8. stopRun cancels queued jobs of that run and reports to the server
  calls = []; script = [() => new Promise(r => setTimeout(() => r(json(200, { contractId: 5, profit: -1, isWin: false })), 80))];
  let alive = true, dropped = 0, bought = 0;
  const mk = n => ({ body: { symbol: 'R_10', direction: 'DIGITEVEN', duration: 1, stake: 1, runId: 'run-A', sid: 'evenodd' }, isActive: () => alive && !C.state.stopped.has('run-A'), onDone: r => { r.dropped ? dropped++ : bought++; } });
  C.enqueue(mk(1)); C.enqueue(mk(2)); C.enqueue(mk(3));
  await sleep(10); C.stopRun('run-A'); await sleep(200);
  assert.equal(calls.length, 1); assert.equal(dropped, 2); ok('stop mid-queue: running trade settles, other 2 cancelled, nothing new sent');
  // 9. halted risk limit raises the event
  let halted = null; C.on('halt', e => halted = e); script = [() => json(403, { error: 'Session loss limit reached.', halted: true })];
  await post({ symbol: 'R_10', direction: 'DIGITEVEN', duration: 1, stake: 1 }); assert.ok(halted); ok('risk halt event fires');

  console.log('Strategy logic');
  const mkM = digits => ({ symbol: 'R_10', digits, counts: L.countsOf(digits) });
  const flat = []; for (let i = 0; i < 1000; i++) flat.push(i % 10);
  const get = id => L.DEFS.find(d => d.id === id);
  assert.equal(L.DEFS.length, 9); ok('9 independent strategy definitions');
  assert.equal(L.evaluate(get('differs'), mkM(flat.slice(0, 500)), 1), undefined); ok('not ready until its window is full');
  assert.equal(L.evaluate(get('differs'), mkM(flat), 1).type, 'DIGITDIFF'); ok('Differs always has a barrier');
  const odd = flat.map((d, i) => (i % 3 === 0 ? 1 : d)); // skew parity
  const eo = L.evaluate(get('evenodd'), mkM(odd), 1); assert.ok(eo === null || /EVEN|ODD/.test(eo.type)); ok('Even/Odd evaluates');
  const heavy = flat.map((d, i) => (i % 4 === 0 ? 6 : d)); const m = L.evaluate(get('matches'), mkM(heavy), 1);
  assert.equal(m.type, 'DIGITMATCH'); assert.equal(m.barrier, 6); ok('Matches picks the dominant digit');
  const cold = []; for (let i = 0; i < 1000; i++) cold.push([1,2,3,4,5,6,7,8,9][i % 9] === 3 && i % 2 ? 4 : [1,2,3,4,5,6,7,8,9][i % 9]);
  const hc = L.evaluate(get('hotcold'), mkM(cold), 1); assert.ok(hc && hc.type === 'DIGITDIFF'); ok('Hot/Cold now has a tradable contract (DIFFERS on coldest)');
  console.log('\nAll tests passed.');
})().catch(e => { console.error('\nFAILED:', e.message); process.exit(1); });
