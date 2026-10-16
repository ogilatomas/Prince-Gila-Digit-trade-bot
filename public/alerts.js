/* alerts.js — WhatsApp alert when a strategy signal qualifies.
 * The page reports the signal; the SERVER sends the WhatsApp message (POST /api/notify), so
 * your phone number and API key never reach the browser. Each strategy+market+signal is
 * announced at most once per cooldown. Differs qualifies on almost every tick, so it is
 * excluded unless you tick it. Alerts only work while this dashboard is open in a browser.
 */
(() => {
  'use strict';
  const C = window.BotCore, $ = id => document.getElementById(id);
  const sentAt = new Map();
  const toastMsg = t => { if (typeof window.toast === 'function') window.toast(t); };
  const post = text => fetch('/api/notify', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  const cooldownMs = () => Math.max(1, Number($('alertCooldown').value) || 5) * 60000;
  const shortName = n => String(n || '').replace(/^Volatility\s*/i, 'V').replace(/\s*Index$/i, '');

  C.on('signal', sig => {
    const box = $('alertOn');
    if (!box || !box.checked) return;
    if (sig.sid === 'differs' && !$('alertDiffers').checked) return;
    const k = sig.sid + '|' + sig.key, now = Date.now();
    if (now - (sentAt.get(k) || 0) < cooldownMs()) return;
    sentAt.set(k, now);
    const mode = ($('mode') || {}).value || 'Demo';
    const market = sig.market ? shortName(sig.market) : sig.symbol;
    post(`📡 SIGNAL · ${sig.label} · ${market} · ${sig.short} · ${new Date().toLocaleTimeString()} · ${mode} mode`)
      .then(async r => { if (!r.ok) { const d = await r.json().catch(() => ({})); toastMsg('WhatsApp alert failed: ' + (d.error || r.status)); } })
      .catch(() => {});
  });

  function build() {
    const row = document.querySelector('#controlCenter .cc-settings');
    if (!row || $('alertOn')) return;
    row.insertAdjacentHTML('beforeend', `
      <label class="cc-switch"><input type="checkbox" id="alertOn"> 📲 WhatsApp alert when a signal qualifies</label>
      <label>Alert cooldown (min) <input id="alertCooldown" type="number" min="1" step="1" value="5"></label>
      <label class="cc-switch"><input type="checkbox" id="alertDiffers"> Include Differs (signals constantly)</label>
      <button class="tradebtn" id="alertTest" type="button">Send test alert</button>`);
    $('alertOn').addEventListener('change', async e => {
      if (!e.target.checked) return;
      try {
        const d = await (await fetch('/api/notify/status', { credentials: 'same-origin' })).json();
        if (!d.configured) { e.target.checked = false; toastMsg('WhatsApp is not set up on the server yet (see README).'); return; }
        toastMsg('WhatsApp alerts ON while this page is open.');
      } catch (_) { e.target.checked = false; toastMsg('Server unreachable.'); }
    });
    $('alertTest').addEventListener('click', async () => {
      try {
        const r = await post('✅ Test alert from your DigitTrade Bot.');
        const d = await r.json().catch(() => ({}));
        toastMsg(r.ok ? 'Test alert sent. Check WhatsApp.' : 'Test failed: ' + (d.error || r.status));
      } catch (_) { toastMsg('Server unreachable.'); }
    });
  }
  (function wait() { if ($('controlCenter')) build(); else setTimeout(wait, 500); })();
})();
