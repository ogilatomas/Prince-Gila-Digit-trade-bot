/* accumulator.js -- Accumulators panel for the Manual Trading page.
 * Loaded AFTER manual.js. Talks to /api/deriv/accu/buy, /status and /sell.
 * Reads the market chosen on the page (#market) and the connected account.
 */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const RATES = [1, 2, 3, 4, 5];
  const A = { rate: 1, open: false, timer: null, busy: false };

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
  }

  async function poll() {
    const { ok, data } = await api('/api/deriv/accu/status');
    if (!ok) return;
    if (!data.open && A.open) {                       // knocked out, hit take-profit, or sold
      stopPolling(); setOpenUI(false);
      const win = data.profit > 0;
      $('accuResult').textContent = (win ? 'Closed: +' : 'Closed: ') + fmt(data.profit) + ' (' + (data.status || 'sold') + ')';
      $('accuResult').className = 'fine ' + (win ? 'pos-g' : 'pos-r');
      toast(win ? 'Accumulator closed in profit.' : 'Accumulator closed: stake lost / knocked out.');
      return;
    }
    if (data.open) showStatus(data);
  }
  function startPolling() { stopPolling(); poll(); A.timer = setInterval(poll, 1000); }
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
    $('accuResult').textContent = 'Sold: ' + (data.profit >= 0 ? '+' : '') + fmt(data.profit);
    $('accuResult').className = 'fine ' + (data.profit >= 0 ? 'pos-g' : 'pos-r');
  }

  // manual.js calls this when you click a tab
  window.AccuUI = {
    onTab(isAccu) {
      $('accuBox').style.display = isAccu ? '' : 'none';
      $('normalBox').style.display = isAccu ? 'none' : '';
      $('barrierBox').style.display = isAccu ? 'none' : $('barrierBox').style.display;
    }
  };

  $('accuBuy').onclick = buy;
  $('accuSell').onclick = sell;
  drawRates(); setOpenUI(false);
  $('accuBox').style.display = 'none';
  // If you refresh the page while an accumulator is still open, pick it up again.
  api('/api/deriv/accu/status').then(({ ok, data }) => { if (ok && data.open) { setOpenUI(true); showStatus(data); startPolling(); } });
})();
