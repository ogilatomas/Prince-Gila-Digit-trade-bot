/* accumulator.js -- Accumulators panel for the Manual Trading page.
 * Loaded AFTER manual.js. Talks to /api/deriv/accu/buy, /status and /sell.
 * Reads the market chosen on the page (#market) and the connected account.
 */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const RATES = [1, 2, 3, 4, 5];
  const A = { rate: 1, open: false, timer: null, busy: false, polling: false,
    sym: null, samples: [], entryEpoch: null, entryPrice: null, closed: null };
  const POLL_MS = 500;                       // server answers from memory, so this is cheap
  const MC = () => window.ManualChart || null;

  async function api(url, opts) {
    const res = await fetch(url, Object.assign({ credentials: 'same-origin' }, opts));
    let data = {}; try { data = await res.json(); } catch (_) {}
    return { ok: res.ok, status: res.status, data };
  }
  const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : '—');
  const toast = m => { const t = $('toast'); if (!t) return; t.textContent = m; t.style.display = 'block';
    clearTimeout(toast.t); toast.t = setTimeout(() => { t.style.display = 'none'; }, 4500); };

  function drawRates() {
    const box = $('accuRates'); box.innerHTML = '';
    RATES.forEach(r => {
      const b = document.createElement('button'); b.textContent = r + '%';
      b.className = r === A.rate ? 'active' : '';
      b.disabled = A.open;
      b.onclick = () => { A.rate = r; drawRates(); };
      box.appendChild(b);
    });
  }

  function setOpenUI(open) {
    A.open = open;
    $('accuBuy').disabled = open || A.busy;
    $('accuSell').disabled = !open || A.busy;
    $('accuStake').disabled = open; $('accuTP').disabled = open;
    $('accuLive').style.display = open ? '' : 'none';
    drawRates();
  }

  function showStatus(s) {
    $('accuValue').textContent = fmt(s.currentValue);
    const p = $('accuProfit'); p.textContent = (s.profit >= 0 ? '+' : '') + fmt(s.profit);
    p.className = s.profit >= 0 ? 'pos-g' : 'pos-r';
    $('accuTicks').textContent = Number.isFinite(s.ticksPassed) ? s.ticksPassed : '—';
    $('accuRange').textContent = fmt(s.lowBarrier, 4) + '  –  ' + fmt(s.highBarrier, 4);
    $('accuSpot').textContent = fmt(s.spot, 4);
    recordSample(s);
  }

  // ---- chart overlay: remember the safe range on every tick so it can be drawn as a band ----
  function recordSample(s) {
    if (s.symbol) A.sym = s.symbol;
    if (Number.isFinite(s.entryTime)) A.entryEpoch = s.entryTime;
    if (Number.isFinite(s.entrySpot)) A.entryPrice = s.entrySpot;
    A.ticksPassed = s.ticksPassed; A.profit = s.profit; A.rateShown = s.growthRate;
    if (Number.isFinite(s.lowBarrier) && Number.isFinite(s.highBarrier)) {
      const e = Number.isFinite(s.spotTime) ? s.spotTime : Math.floor(Date.now() / 1000);
      const last = A.samples[A.samples.length - 1];
      if (last && last.e === e) { last.lo = s.lowBarrier; last.hi = s.highBarrier; }
      else { A.samples.push({ e, lo: s.lowBarrier, hi: s.highBarrier }); if (A.samples.length > 1000) A.samples.shift(); }
    }
    redraw();
  }
  function redraw() { const m = MC(); if (m) m.scheduleDraw(); }
  function overlayOn() {
    const m = MC();
    return !!(m && (A.open || A.closed) && A.samples.length && A.sym && m.S.selected === A.sym);
  }
  function clearOverlay() { A.samples = []; A.entryEpoch = null; A.entryPrice = null; A.closed = null; redraw(); }

  function sampleAt(epoch, from) {              // newest barrier sample at or before this tick's time
    let k = from;
    while (k + 1 < A.samples.length && A.samples[k + 1].e <= epoch) k++;
    return k;
  }

  const overlay = {
    range(start, end) {
      if (!overlayOn()) return null;
      const t0 = MC().S.ticks[start] ? MC().S.ticks[start].epoch : 0;
      let lo = Infinity, hi = -Infinity;
      A.samples.forEach(q => { if (q.e >= t0) { if (q.lo < lo) lo = q.lo; if (q.hi > hi) hi = q.hi; } });
      if (!Number.isFinite(lo)) { const q = A.samples[A.samples.length - 1]; lo = q.lo; hi = q.hi; }
      return { lo, hi };
    },
    draw(ctx, g) {
      if (!overlayOn()) return;
      const m = MC(), ticks = m.S.ticks, n = ticks.length;
      let ei = A.entryEpoch != null ? m.idxByEpoch(A.entryEpoch) : -1;
      if (ei < 0) ei = Math.max(0, n - 1 - (Number(A.ticksPassed) || 0));
      let xi = n - 1;                                            // last tick the band covers
      if (A.closed && A.closed.epoch != null) { const c = m.idxByEpoch(A.closed.epoch); if (c >= 0) xi = c; }
      const from = Math.max(ei, g.start), to = Math.min(xi, g.end - 1);
      if (to < from) return;

      // build the per-tick upper / lower barrier path
      let k = 0; while (k + 1 < A.samples.length && A.samples[k + 1].e <= (ticks[from].epoch || 0)) k++;
      const up = [], dn = [];
      for (let i = from; i <= to; i++) {
        k = sampleAt(ticks[i].epoch || 0, k);
        const q = A.samples[k];
        up.push([g.xAt(i), g.yAt(q.hi)]); dn.push([g.xAt(i), g.yAt(q.lo)]);
      }
      const lastQ = A.samples[sampleAt(ticks[to].epoch || 0, k)];
      const knocked = !!(A.closed && A.closed.lost);

      ctx.save();
      ctx.beginPath(); ctx.rect(g.left, g.top, g.right - g.left, g.bottom - g.top); ctx.clip();
      // safe-range band
      ctx.beginPath();
      up.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
      for (let i = dn.length - 1; i >= 0; i--) ctx.lineTo(dn[i][0], dn[i][1]);
      ctx.closePath();
      ctx.fillStyle = knocked ? 'rgba(255,77,106,0.10)' : 'rgba(0,245,155,0.10)'; ctx.fill();
      // barrier lines
      ctx.lineWidth = 1.5; ctx.strokeStyle = knocked ? '#ff4d6a' : '#00f59b'; ctx.setLineDash([]);
      [up, dn].forEach(path => { ctx.beginPath(); path.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.stroke(); });
      // entry marker
      if (ei >= g.start && ei < g.end) {
        const ex = g.xAt(ei), ey = g.yAt(ticks[ei].price);
        ctx.setLineDash([5, 4]); ctx.strokeStyle = '#ffe34e88'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(ex, g.top); ctx.lineTo(ex, g.bottom); ctx.stroke(); ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(ex, ey, 6, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = '#ffe34e'; ctx.stroke();
      }
      // end marker (knocked out / sold)
      if (A.closed && xi >= g.start && xi < g.end) {
        const x = g.xAt(xi), y = g.yAt(ticks[xi].price), col = knocked ? '#ff4d6a' : '#00f59b';
        ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
      }
      ctx.restore();

      // barrier price tags on the right axis
      if (!A.closed) {
        ctx.font = 'bold 10px monospace'; ctx.textAlign = 'left';
        [[lastQ.hi, 'HI'], [lastQ.lo, 'LO']].forEach(([v, tag]) => {
          const y = g.yAt(v);
          ctx.fillStyle = '#0b3b2b'; ctx.fillRect(g.right + 2, y - 8, g.W - g.right - 4, 16);
          ctx.fillStyle = '#00f59b'; ctx.fillText(tag + ' ' + v.toFixed(m.S.decimals), g.right + 4, y + 3);
        });
      }

      // status label on the chart
      const prof = Number(A.profit), txt = A.closed
        ? (knocked ? 'KNOCKED OUT  ' : 'SOLD  ') + (prof >= 0 ? '+' : '') + (Number.isFinite(prof) ? prof.toFixed(2) : '—')
        : 'ACCU ' + (Number.isFinite(A.rateShown) ? Math.round(A.rateShown * 100) : A.rate) + '%  ·  ' +
          (Number.isFinite(A.ticksPassed) ? A.ticksPassed : 0) + ' ticks  ·  ' + (prof >= 0 ? '+' : '') + (Number.isFinite(prof) ? prof.toFixed(2) : '—');
      ctx.font = 'bold 12px monospace'; ctx.textAlign = 'left';
      const w = ctx.measureText(txt).width + 16;
      ctx.fillStyle = 'rgba(6,25,42,0.88)'; ctx.fillRect(g.left + 6, g.top + 6, w, 22);
      ctx.strokeStyle = knocked || prof < 0 ? '#ff4d6a' : '#00f59b'; ctx.lineWidth = 1; ctx.strokeRect(g.left + 6, g.top + 6, w, 22);
      ctx.fillStyle = knocked || prof < 0 ? '#ff4d6a' : '#00f59b'; ctx.fillText(txt, g.left + 14, g.top + 21);
    }
  };
  function attachOverlay() { const m = MC(); if (m) m.S.overlay = overlay; }

  async function poll() {
    if (A.polling) return;
    A.polling = true;
    let ok, data;
    try { ({ ok, data } = await api('/api/deriv/accu/status')); } finally { A.polling = false; }
    if (!ok) return;
    if (!data.open && A.open) {                       // knocked out, hit take-profit, or sold
      stopPolling(); setOpenUI(false);
      const win = data.profit > 0;
      recordSample(data);
      A.closed = { epoch: Number.isFinite(data.spotTime) ? data.spotTime : null, lost: !(data.profit > 0) && String(data.status || '').toLowerCase() !== 'sold', profit: data.profit };
      A.profit = data.profit; redraw();
      $('accuResult').textContent = (win ? 'Closed: +' : 'Closed: ') + fmt(data.profit) + ' (' + (data.status || 'sold') + ')';
      $('accuResult').className = 'fine ' + (win ? 'pos-g' : 'pos-r');
      toast(win ? 'Accumulator closed in profit.' : 'Accumulator closed: stake lost / knocked out.');
      return;
    }
    if (data.open) showStatus(data);
  }
  function startPolling() { stopPolling(); poll(); A.timer = setInterval(poll, POLL_MS); }
  function stopPolling() { if (A.timer) { clearInterval(A.timer); A.timer = null; } }

  async function buy() {
    if (A.open || A.busy) return;
    const stake = Number($('accuStake').value);
    const tpRaw = $('accuTP').value.trim();
    const symbol = $('market').value;
    if (!Number.isFinite(stake) || stake <= 0) return toast('Enter a stake above 0.');
    const acct = $('modeBadge') ? $('modeBadge').textContent : '';
    const real = acct === 'REAL';
    if (acct !== 'DEMO' && acct !== 'REAL') return toast('Connect your Deriv account first.');
    if (real && !window.confirm('REAL MONEY TRADE\n\nAccumulator ' + A.rate + '% on ' + symbol + '\nStake: ' + stake + '\n\nYou lose the whole stake if the price leaves the range.\nPlace this trade?')) return;
    A.busy = true; $('accuBuy').disabled = true;
    $('accuResult').textContent = '';
    clearOverlay(); A.sym = symbol;
    const { ok, data } = await api('/api/deriv/accu/buy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, stake, growthRate: A.rate / 100, takeProfit: tpRaw === '' ? undefined : Number(tpRaw), confirmReal: real })
    });
    A.busy = false;
    if (!ok) { setOpenUI(false); return toast(data.error || 'Accumulator purchase failed.'); }
    setOpenUI(true); startPolling();
  }

  async function sell() {
    if (!A.open || A.busy) return;
    A.busy = true; $('accuSell').disabled = true;
    const { ok, data } = await api('/api/deriv/accu/sell', { method: 'POST' });
    A.busy = false;
    if (!ok) { $('accuSell').disabled = false; return toast(data.error || 'Could not sell.'); }
    stopPolling(); setOpenUI(false);
    A.profit = data.profit; A.closed = { epoch: Number.isFinite(data.spotTime) ? data.spotTime : null, lost: false, profit: data.profit }; redraw();
    $('accuResult').textContent = 'Sold: ' + (data.profit >= 0 ? '+' : '') + fmt(data.profit);
    $('accuResult').className = 'fine ' + (data.profit >= 0 ? 'pos-g' : 'pos-r');
  }

  // manual.js calls this when you click a tab
  window.AccuUI = {
    onTab(isAccu) {
      if (!isAccu && !A.open && (A.closed || A.samples.length)) clearOverlay();   // tidy the chart; a live trade stays visible
      $('accuBox').style.display = isAccu ? '' : 'none';
      $('normalBox').style.display = isAccu ? 'none' : '';
      $('barrierBox').style.display = isAccu ? 'none' : $('barrierBox').style.display;
    }
  };

  $('accuBuy').onclick = buy;
  $('accuSell').onclick = sell;
  attachOverlay();
  drawRates(); setOpenUI(false);
  $('accuBox').style.display = 'none';
  // If you refresh the page while an accumulator is still open, pick it up again.
  api('/api/deriv/accu/status').then(({ ok, data }) => {
    if (!(ok && data.open)) return;
    A.sym = data.symbol || null;
    const sel = $('market');
    if (A.sym && sel && sel.value !== A.sym && Array.prototype.some.call(sel.options, o => o.value === A.sym)) {
      sel.value = A.sym; sel.dispatchEvent(new Event('change'));    // show the market the trade is on
    }
    setOpenUI(true); showStatus(data); startPolling();
  });
})();
