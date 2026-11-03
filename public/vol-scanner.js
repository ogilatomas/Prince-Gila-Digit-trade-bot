/* vol-scanner.js — floating Volatility Scanner. Drag it anywhere.
 * Scans ONLY the Volatility markets (regular and 1-second) and tells you which ones qualify for
 * Over 2/3/4/5 or Under 6/7/8/9 under the rules in scanner-logic.js. It never places a trade. */
(() => {
  'use strict';
  const L = window.ScannerLogic, Hub = window.TickHub;
  if (!L || !Hub) return;
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const KEY = 'volScanner.v1', RENOTIFY_MS = 60000, NEW_MS = 12000;
  const ui = { x: null, y: null, min: false, sound: true, windowN: 1000, only: {} };
  const state = new Map();                 // pair key -> { on, lastNote, newUntil }
  let el = null, audio = null, first = true;

  const load = () => { try { Object.assign(ui, JSON.parse(localStorage.getItem(KEY)) || {}); } catch (_) {} ui.only = ui.only || {}; };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(ui)); } catch (_) {} };
  const toast = m => { if (typeof window.toast === 'function') return window.toast(m); const t = $('toast'); if (t) { t.textContent = m; t.style.display = 'block'; clearTimeout(toast.t); toast.t = setTimeout(() => { t.style.display = 'none'; }, 6000); } };

  function beep() {
    if (!ui.sound) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = 'sine'; o.frequency.value = 880; g.gain.value = 0.08;
      o.connect(g); g.connect(audio.destination); o.start(); o.stop(audio.currentTime + 0.18);
    } catch (_) { /* sound is optional */ }
  }

  function css() {
    const s = document.createElement('style');
    s.textContent = `
.vsc{position:fixed;left:12px;bottom:12px;z-index:45;width:min(350px,calc(100vw - 24px));background:#06192a;border:1px solid #087fa9;border-radius:12px;color:#d6e9f5;font:13px Inter,Arial,sans-serif;box-shadow:0 8px 28px #000a}
.vsc.flash{animation:vscflash 1s ease 3}@keyframes vscflash{50%{box-shadow:0 0 0 3px #ffe34e,0 8px 28px #000a}}
.vsc header{display:flex;align-items:center;gap:8px;padding:9px 10px;cursor:grab;touch-action:none;user-select:none;border-bottom:1px solid #0a3b54}
.vsc header b{flex:1;font-size:13px}.vsc header button{background:#0b2b45;color:#fff;border:1px solid #087fa9;border-radius:6px;width:28px;height:26px;cursor:pointer}
.vsc .pill{font:700 10px "JetBrains Mono",monospace;padding:3px 8px;border-radius:99px;background:#2b3a48}.vsc .pill.on{background:#063e3b;color:#00f59b}
.vsc .body{padding:8px 10px 10px}.vsc.min .body{display:none}
.vsc .ctl{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px;font-size:11px;color:#91b3c8}
.vsc .ctl select{background:#08243a;color:#fff;border:1px solid #087fa9;border-radius:6px;padding:3px}
.vsc .rule{font-size:10px;color:#91b3c8;margin:0 0 8px;line-height:1.4}
.vsc ul{list-style:none;margin:0;padding:0;max-height:min(46vh,340px);overflow:auto;display:grid;gap:6px}
.vsc li{background:#08243a;border-radius:8px;padding:7px 9px;border-left:3px solid #00f59b}
.vsc li.new{border-left-color:#ffe34e;background:#2a2608}
.vsc li .top{display:flex;justify-content:space-between;gap:8px;align-items:center}.vsc li .top b{font-size:12px}
.vsc li .tag{font:700 11px "JetBrains Mono",monospace;background:#00f59b;color:#00261d;padding:2px 7px;border-radius:6px;white-space:nowrap}
.vsc li.new .tag{background:#ffe34e;color:#241d00}
.vsc li .d{margin-top:4px;font:11px "JetBrains Mono",monospace;color:#9bbdd0;display:flex;flex-wrap:wrap;gap:4px 10px}.vsc li .d i{font-style:normal;color:#fff}
.vsc li .d u{text-decoration:none;color:#ffe34e}
.vsc .empty{color:#91b3c8;font-size:12px;padding:6px 2px}.vsc .fine{font-size:10px;color:#6f93a8;margin:8px 0 0}`;
    document.head.appendChild(s);
  }

  function build() {
    el = document.createElement('aside'); el.className = 'vsc'; el.id = 'volScanner';
    el.innerHTML = `
<header id="vscHead"><b>🔔 VOLATILITY SCANNER</b><span class="pill" id="vscPill">LOADING</span><button type="button" id="vscSound" title="Sound alert on/off">🔊</button><button type="button" id="vscMin" aria-label="Minimise">−</button></header>
<div class="body">
  <div class="ctl"><label>Scan last <select id="vscWin"><option value="100">100</option><option value="500">500</option><option value="1000">1000</option></select> ticks</label><span id="vscCount"></span></div>
  <p class="rule">Qualifies when every checked digit is below 10% (one may sit exactly on 10%). Over 2–5 check the low digits, Under 6–9 check the high digits.</p>
  <ul id="vscList"></ul>
  <p class="fine">Signals only. This scanner never places trades, and a signal is not a prediction.</p>
</div>`;
    document.body.appendChild(el);
    $('vscWin').value = String(ui.windowN);
    $('vscWin').onchange = () => { ui.windowN = Number($('vscWin').value); save(); state.clear(); first = true; scanNow(); };
    $('vscMin').onclick = () => { ui.min = !ui.min; apply(); save(); };
    $('vscSound').onclick = () => { ui.sound = !ui.sound; apply(); save(); if (ui.sound) beep(); };
    drag($('vscHead'));
    apply();
  }

  function apply() {
    el.classList.toggle('min', !!ui.min);
    $('vscMin').textContent = ui.min ? '+' : '−';
    $('vscSound').textContent = ui.sound ? '🔊' : '🔇';
    if (ui.x != null && ui.y != null) { el.style.left = ui.x + 'px'; el.style.top = ui.y + 'px'; el.style.bottom = 'auto'; }
  }

  function drag(handle) {
    handle.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;
      const r = el.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      handle.setPointerCapture(e.pointerId);
      const move = ev => {
        ui.x = Math.min(Math.max(0, ev.clientX - dx), window.innerWidth - 60);
        ui.y = Math.min(Math.max(0, ev.clientY - dy), window.innerHeight - 40);
        apply();
      };
      const up = () => { handle.removeEventListener('pointermove', move); save(); };
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up, { once: true }); handle.addEventListener('pointercancel', up, { once: true });
    });
  }

  function scanNow() {
    if (!el) return;
    const { list, scanned } = L.scan(Hub.markets.values(), ui.windowN);
    const now = Date.now(), live = new Set(list.map(q => q.key)), fresh = [];

    list.forEach(q => {
      const s = state.get(q.key) || { on: false, lastNote: 0, newUntil: 0 };
      if (!s.on && now - s.lastNote > RENOTIFY_MS) { s.lastNote = now; s.newUntil = now + NEW_MS; fresh.push(q); }   // flicker guard: no repeat alert within a minute
      s.on = true; state.set(q.key, s);
    });
    state.forEach((s, k) => { if (!live.has(k)) s.on = false; });

    if (fresh.length) {
      const names = fresh.slice(0, 3).map(q => `${q.name} → ${q.rule.label}`).join(', ') + (fresh.length > 3 ? ` +${fresh.length - 3} more` : '');
      toast('🔔 Qualifies: ' + names);
      beep();
      el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    }
    first = false;

    $('vscPill').textContent = scanned ? 'LIVE' : 'LOADING'; $('vscPill').className = 'pill' + (scanned ? ' on' : '');
    $('vscCount').textContent = scanned ? `${scanned} markets · ${list.length} signal${list.length === 1 ? '' : 's'}` : '';
    $('vscList').innerHTML = !scanned
      ? '<li class="empty" style="border:0;background:none">Loading volatility markets…</li>'
      : list.length
        ? list.map(q => {
            const isNew = (state.get(q.key) || {}).newUntil > now;
            return `<li class="${isNew ? 'new' : ''}"><div class="top"><b>${esc(q.name)}</b><span class="tag">${esc(q.rule.label.toUpperCase())}</span></div>` +
              `<div class="d">${q.pct.map(p => `<span>${p.digit}: ${p.pct >= 10 - 1e-9 && p.pct <= 10 + 1e-9 ? '<u>10.0%</u>' : `<i>${p.pct.toFixed(1)}%</i>`}</span>`).join('')}</div></li>`;
          }).join('')
        : '<li class="empty" style="border:0;background:none">No volatility market qualifies right now. Scanning…</li>';
  }

  load(); css(); build(); Hub.start();
  scanNow(); setInterval(scanNow, 1500);
})();
