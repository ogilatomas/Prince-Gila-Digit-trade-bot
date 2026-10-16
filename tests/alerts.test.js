// Server-side alert monitor tests with a FAKE Deriv feed. No network needed.
const assert = require('assert');
const EventEmitter = require('events');
const { createMonitor } = require('../alert-monitor.js');
const { suggestStake } = require('../stake.js');
const ok = n => console.log('  ✓', n);

// 1000 digits: 0-3 rare (5% each), 4-9 common (~13.3%) -> Over 3 qualifies, Hot/Cold qualifies
const weights = [50, 50, 50, 50, 135, 133, 133, 133, 133, 133];
const digits = []; const cum = []; weights.reduce((a, w, i) => (cum[i] = a + w, a + w), 0);
for (let i = 0; i < 1000; i++) { const x = ((i * 0.6180339887) % 1) * 1000; digits.push(cum.findIndex(c => x < c)); }
const price = d => 1000 + d / 100;

class FakeWS extends EventEmitter {
  constructor(url) { super(); this.readyState = 1; this.sent = []; FakeWS.last = this; setImmediate(() => this.emit('open')); }
  send(s) { this.sent.push(JSON.parse(s)); } close() { this.emit('close'); }
  say(o) { this.emit('message', JSON.stringify(o)); }
}
const tick = (ws, d, epoch) => ws.say({ msg_type: 'tick', tick: { symbol: 'R_10', quote: price(d), pip_size: 2, epoch } });
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('Stake suggestion');
  assert.equal(suggestStake({ bankroll: 200, riskPct: 1 }).stake, 2); ok('1% of $200 = $2.00');
  const big = suggestStake({ bankroll: 100000, riskPct: 1, maxStake: 500, sessionLossLimit: 500 });
  assert.equal(big.stake, 100); assert.ok(big.capped); ok('capped so 5 losses fit the session loss limit');
  const tiny = suggestStake({ bankroll: 5, riskPct: 1 }); assert.equal(tiny.stake, 0.35); assert.ok(tiny.belowMin && tiny.heavy); ok('tiny bankroll -> platform minimum + warning');
  assert.equal(suggestStake({}), null); ok('no bankroll -> no suggestion');

  console.log('Alert monitor');
  const sent = []; let failWith = null;
  const m = createMonitor({
    WebSocketImpl: FakeWS, url: 'wss://fake', log: () => {},
    send: async t => { if (failWith) { const e = new Error('slow'); e.status = failWith; throw e; } sent.push(t); },
    env: { ALERT_BANKROLL: '200', ALERT_RISK_PCT: '1', ALERT_COOLDOWN_MIN: '10' }
  });
  m.start(); await wait(5); const ws = FakeWS.last;
  assert.deepEqual(ws.sent[0], { active_symbols: 'brief', req_id: 1 }); ok('asks Deriv for symbols on connect');
  ws.say({ msg_type: 'active_symbols', active_symbols: [{ underlying_symbol: 'R_10', underlying_symbol_name: 'Volatility 10 Index', pip_size: 0.01 }, { underlying_symbol: 'EURUSD', underlying_symbol_name: 'EUR/USD' }] });
  const hist = ws.sent.find(x => x.ticks_history); assert.equal(hist.ticks_history, 'R_10'); ok('loads history only for Volatility markets');
  ws.say({ msg_type: 'history', req_id: hist.req_id, history: { prices: digits.map(price) } });
  assert.ok(ws.sent.find(x => x.ticks === 'R_10' && x.subscribe === 1)); ok('subscribes to live ticks after history');

  tick(ws, digits[0], 1);
  const text = await m.flush();
  assert.ok(text, 'digest should be sent'); assert.equal(sent.length, 1);
  assert.ok(/Over\/Under · V10 · OVER 3/.test(text)); ok('lists the qualifying Over/Under strategy and market');
  assert.ok(/Hot\/Cold · V10/.test(text)); ok('lists every qualifying strategy in ONE message');
  assert.ok(!/Differs/.test(text)); ok('Differs is excluded by default');
  assert.ok(text.includes('$2.00 per trade')); assert.ok(/No stake guarantees profit/.test(text)); ok('includes suggested stake and the no-guarantee warning');

  tick(ws, digits[1], 2); assert.equal(await m.flush(), null); assert.equal(sent.length, 1); ok('same signals do not repeat inside the cooldown');

  // provider says "too fast": the alert is kept and retried, not lost
  const m2 = createMonitor({ WebSocketImpl: FakeWS, url: 'x', log: () => {}, send: async t => { if (failWith) { const e = new Error('slow'); e.status = failWith; throw e; } sent.push(t); }, env: { ALERT_BANKROLL: '200' } });
  m2.start(); await wait(5); const w2 = FakeWS.last;
  w2.say({ msg_type: 'active_symbols', active_symbols: [{ underlying_symbol: 'R_10', underlying_symbol_name: 'Volatility 10 Index', pip_size: 0.01 }] });
  w2.say({ msg_type: 'history', req_id: w2.sent.find(x => x.ticks_history).req_id, history: { prices: digits.map(price) } });
  tick(w2, digits[0], 1); failWith = 429; await m2.flush(); assert.ok(m2._pending.size > 0);
  failWith = null; const before = sent.length; await m2.flush(); assert.equal(sent.length, before + 1); ok('rate-limited alert is retried, not lost');

  m.stop(); m2.stop();
  console.log('\nAlert tests passed.'); process.exit(0);
})().catch(e => { console.error('\nFAILED:', e.message); process.exit(1); });
