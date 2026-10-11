const $=id=>document.getElementById(id);const sample=[['Volatility 10 Index',7,[5.2,6.1,4.8,5.5,6.3,7.1,6.6,8.2,7.6,8.5],'Over 5'],['Volatility 25 Index',3,[6.2,4.7,6.7,6.3,7.2,5.6,6.9,7.4,5.8,6.2],'Over 5'],['Volatility 50 Index',6,[2.8,3.9,5.1,6.7,7.3,6.1,5.9,6.8,7.8,8.0],'Over 5'],['Volatility 75 Index',2,[6.2,7.1,5.8,4.9,6.7,5.2,4.8,5.6,7.1,6.4],'Under 5'],['Volatility 100 Index',4,[8.3,7.2,6.5,5.8,5.1,4.3,3.6,4.9,4.9,5.9],'Under 5'],['Volatility 200 Index',9,[5.4,6.2,7.1,8.3,6.9,5.7,6.8,7.2,8.6,9.5],'Over 5']];$('marketRows').innerHTML=sample.map((r,i)=>`<tr><td>${i+1}</td><td>${r[0]}</td><td><b>${r[1]}</b></td>${r[2].map(v=>`<td class="digit">${v}%</td>`).join('')}<td style="color:${r[3].startsWith('Over')?'#00f59b':'#ffe34e'}">${r[3]}<br><small>Example</small></td><td><button class="tradebtn" data-signal="${r[0]}">Signal</button></td></tr>`).join('');$('chart').innerHTML=[5.2,6.1,4.8,5.5,7.3,12.6,9.8,8.5,6.4,7.2].map((v,i)=>`<div class="bar" style="height:${v*6}px;background:${i===5?'linear-gradient(#66ff7a,#00bd6d)':i===6?'linear-gradient(#c77dff,#6e50c8)':'linear-gradient(#39b8ff,#1765db)'}"><b>${v}%</b><span>${i}</span></div>`).join('');function toast(t){$('toast').textContent=t;$('toast').style.display='block';setTimeout(()=>$('toast').style.display='none',2800)}document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-tab]').forEach(x=>x.classList.remove('active'));b.classList.add('active');toast('Showing '+b.textContent+' sample view. Connect live data for real ticks.')});document.querySelectorAll('[data-signal]').forEach(b=>b.onclick=()=>toast('Signal view only for '+b.dataset.signal+'. Digit-contract purchasing is not enabled.'));$('stake').oninput=()=>{$('stakeKes').textContent=(Number($('stake').value||0)*125).toLocaleString('en-US',{maximumFractionDigits:2})};async function selectMode(mode){const r=await fetch('/api/deriv/accounts',{credentials:'same-origin'});const d=await r.json();if(!d.connected){$('mode').value='Demo';toast('Connect Deriv first, then choose an account.');return false}const target=d.accounts.find(a=>mode==='Real'?!a.isVirtual:a.isVirtual);if(!target){$('mode').value=d.accounts.some(a=>a.isVirtual)?'Demo':'Real';toast('No '+mode+' trading account is available on this Deriv login.');return false}const sr=await fetch('/api/deriv/select',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({loginid:target.loginid})});const sd=await sr.json();if(!sr.ok){toast(sd.error||'Could not select account.');return false}$('mode').value=mode;$('accountModeLabel').textContent='('+mode+' · '+target.loginid+')';$('demoBtn').classList.toggle('active',mode==='Demo');$('realBtn').classList.toggle('active',mode==='Real');toast('Selected '+mode+' account '+target.loginid);return true} $('mode').onchange=()=>selectMode($('mode').value);$('demoBtn').onclick=()=>selectMode('Demo');$('realBtn').onclick=()=>selectMode('Real');$('startBot').onclick=()=>{if($('mode').value!=='Demo'){toast('Use demo mode for testing.');return}$('botStatus').textContent='● Demo running';$('botStatus').style.color='#00f59b';$('startBot').disabled=true;$('stopBot').disabled=false;toast('Demo dashboard started. No real or digit-contract purchase has been placed.')};$('stopBot').onclick=()=>{$('botStatus').textContent='● Stopped';$('botStatus').style.color='#ffc857';$('startBot').disabled=false;$('stopBot').disabled=true;toast('Demo dashboard stopped.')};document.querySelectorAll('[data-min]').forEach(b=>b.onclick=()=>{const el=$(b.dataset.min);el.classList.toggle('minimized');const children=[...el.children].slice(1);children.forEach(ch=>ch.style.display=el.classList.contains('minimized')?'none':'');b.textContent=el.classList.contains('minimized')?'+':'−'});$('apiState').textContent='Waiting for server/API';document.querySelectorAll('nav a').forEach(a=>a.onclick=()=>{document.querySelectorAll('nav a').forEach(n=>n.classList.remove('selected'));a.classList.add('selected')});$('tradeRows').innerHTML='<tr><td colspan="5">No recorded trades yet — sample scanner figures are illustrative.</td></tr>';

// -----------------------------------------------------------------------------
// Independent Smart Strategy: 500-tick rule + optional-by-start auto-purchase.
// Auto purchases are server-restricted to authenticated virtual/demo accounts.
// -----------------------------------------------------------------------------
(() => {
  const el = id => document.getElementById(id);
  const APP_ID = 1089;
  const WINDOW = 500, REQUIRED = 50, ALLOW = 2;
  const rules = [
    {name:'OVER 2', barrier:2, type:'DIGITOVER', dominant:[3,4,5,6,7,8,9], breakout:[0,1,2]},
    {name:'OVER 3', barrier:3, type:'DIGITOVER', dominant:[4,5,6,7,8,9], breakout:[0,1,2,3]},
    {name:'OVER 4', barrier:4, type:'DIGITOVER', dominant:[5,6,7,8,9], breakout:[0,1,2,3,4]},
    {name:'UNDER 6', barrier:6, type:'DIGITUNDER', dominant:[0,1,2,3,4,5], breakout:[6,7,8,9]},
    {name:'UNDER 7', barrier:7, type:'DIGITUNDER', dominant:[0,1,2,3,4,5,6], breakout:[7,8,9]},
    {name:'UNDER 8', barrier:8, type:'DIGITUNDER', dominant:[0,1,2,3,4,5,6,7], breakout:[8,9]}
  ];
  let ws = null, running = false, initialized = false, busy = false, realConfirmed = false;
  const marketData = new Map(), inFlight = new Set(), lastSignal = new Map();
  const subscriptions = new Set();
  const selectedRules = () => new Set([...document.querySelectorAll('.smartRule:checked')].map(x=>x.value));
  const status = (message, state='') => { el('smartProgress').textContent=message; el('smartStatus').textContent='● '+(state || (running?'Running':'Stopped')); };
     const digitFromQuote = (quote, pip) => {
     const p = Number(pip);
     const dec = (!Number.isFinite(p) || p <= 0) ? 2 : (p >= 1 && Number.isInteger(p)) ? Math.min(p, 8) : Math.min(8, Math.max(0, Math.round(-Math.log10(p))));
     return Number(Number(quote).toFixed(dec).slice(-1));
   };
  const getCounts = digits => { const c=Array(10).fill(0); digits.forEach(d=>c[d]++); return c; };
  function checkRule(digits, rule) {
    if (digits.length < WINDOW) return null;
    const count=getCounts(digits), domBelow=rule.dominant.filter(d=>count[d]<REQUIRED);
    const breakAbove=rule.breakout.filter(d=>count[d]>=REQUIRED);
    if(domBelow.length>ALLOW || breakAbove.length>ALLOW) return null;
    let entry=rule.breakout[0];
    for(const d of rule.breakout) if(count[d]>count[entry]) entry=d;
    if(digits[digits.length-1]!==entry) return null;
    return {entry, freq:count[entry], domBelow, breakAbove};
  }
  function renderRow(symbol, market, state, rule, result) {
    const id=`${symbol}-${rule.name}`.replace(/[^a-zA-Z0-9_-]/g,'_');
    let tr=document.getElementById(id);
    if(!tr){tr=document.createElement('tr');tr.id=id;el('smartRows').prepend(tr);}
    tr.innerHTML=`<td>${market}</td><td>${symbol}</td><td>${state.digits.length}/500</td><td>${state.digits.length?state.digits[state.digits.length-1]:'—'}</td><td>${rule.name}</td><td>${result?result.entry:'—'}</td><td>${result?result.freq:'—'}</td><td class="${result?'smart-signal':'smart-wait'}">${result?'SIGNAL':'Scanning'}</td>`;
  }
  async function buySignal(symbol, market, rule, result, tickKey) {
    const key=`${symbol}|${rule.name}`;
    if(busy || inFlight.has(key) || lastSignal.get(key)===tickKey) return;
    lastSignal.set(key,tickKey); inFlight.add(key); busy=true;
    try {
      const accountsResponse=await fetch('/api/deriv/accounts',{credentials:'same-origin'});
      const accounts=await accountsResponse.json();
      if(!accounts.connected || !accounts.active) throw new Error('Connect Deriv and select a virtual/demo account before starting Smart Strategy.');
      const active=accounts.accounts.find(a=>a.loginid===accounts.active);
      const requestedMode=el('mode').value;
      if(!active) throw new Error('No active Deriv account selected.');
      if(requestedMode==='Demo' && !active.isVirtual) throw new Error('Selected account is real, but dashboard mode is Demo.');
      if(requestedMode==='Real' && active.isVirtual) throw new Error('Selected account is virtual, but dashboard mode is Real.');
      if(!active.isVirtual && !realConfirmed) throw new Error('Real-account confirmation is required before auto-buy.');
      if(!running) throw new Error('Smart Strategy was stopped before the purchase request.');
      const stake=Number(el('stake').value), maxStake=Number(el('maxStake').value);
      if(!Number.isFinite(stake)||stake<=0||stake>maxStake) throw new Error('Stake must be positive and no greater than Max Stake.');
      const response=await fetch('/api/deriv/trade',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol,direction:rule.type,barrier:rule.barrier,duration:1,stake,confirmReal:!active.isVirtual && realConfirmed})});
      const payload=await response.json();
      if(!response.ok) throw new Error(payload.error||'Deriv purchase failed.');
      const resultText=`BOUGHT #${payload.contractId} · P/L ${payload.profit}`;
      renderRow(symbol,market,marketData.get(symbol),rule,{...result, entry:result.entry});
      const row=document.getElementById(`${symbol}-${rule.name}`.replace(/[^a-zA-Z0-9_-]/g,'_'));
      if(row) row.lastElementChild.textContent=resultText;
      addTradeLog(rule.name, rule.barrier, stake, resultText);
      status(`Purchased ${rule.name} on ${market}; contract ${payload.contractId}.`, 'Running');
    } catch(err) {
      status(`Signal ${rule.name} on ${market}; not purchased: ${err.message}`, 'Needs attention');
      addTradeLog(rule.name, rule.barrier, Number(el('stake').value), 'NOT BOUGHT: '+err.message);
    } finally { inFlight.delete(key); busy=false; }
  }
  function addTradeLog(strategy, barrier, stake, result) {
    const tbody=el('tradeRows');
    if(tbody.querySelector('td[colspan]')) tbody.innerHTML='';
    const tr=document.createElement('tr');
    [new Date().toLocaleTimeString(),strategy,barrier,`$${stake}`,result].forEach(v=>{const td=document.createElement('td');td.textContent=v;tr.appendChild(td)});
    tbody.prepend(tr); while(tbody.children.length>30) tbody.lastElementChild.remove();
  }
  function onTick(tick) {
   if(tick && !tick.symbol && tick.underlying_symbol) tick.symbol=tick.underlying_symbol; 
    if(!running || !tick || !tick.symbol) return;
    const state=marketData.get(tick.symbol); if(!state) return;
    const digitFromQuote = (quote, pip) => {
  const p = Number(pip);
  const dec = (!Number.isFinite(p) || p <= 0) ? 2 : (p >= 1 && Number.isInteger(p)) ? Math.min(p, 8) : Math.min(8, Math.max(0, Math.round(-Math.log10(p))));
  return Number(Number(quote).toFixed(dec).slice(-1));
};
      const signal=checkRule(state.digits,rule);
      renderRow(tick.symbol,state.name,state,rule,signal);
      if(signal) buySignal(tick.symbol,state.name,rule,signal,tickKey);
    }
  }
  function stop(reason='Stopped by user') {
    running=false; busy=false;
    if(ws) { try{ws.close();}catch(_){} ws=null; }
    subscriptions.clear(); initialized=false;
    el('smartStart').disabled=false; el('smartStop').disabled=true;
    status(reason,'Stopped');
  }
  function send(obj){ if(ws && ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
  function start() {
    if(running) return;
    if(!selectedRules().size){toast('Select at least one Smart Strategy rule.');return;}
    realConfirmed=false;
    if(el('mode').value==='Real'){if(!window.confirm('REAL MONEY WARNING: Smart Strategy will automatically purchase digit contracts using your selected REAL Deriv account. Losses are possible. Confirm you want to enable real-money auto-buy?')) return; realConfirmed=true;}
    running=true; el('smartStart').disabled=true; el('smartStop').disabled=false;
    status('Connecting to Deriv market data…','Connecting');
    ws=new WebSocket('wss://api.derivws.com/trading/v1/options/ws/public');
    ws.onopen=()=>send({active_symbols:'brief', req_id:1});
    ws.onerror=()=>status('Market data connection error. Check network and retry.','Connection error');
    ws.onclose=()=>{ if(running){running=false;el('smartStart').disabled=false;el('smartStop').disabled=true;status('Market data disconnected. Restart Smart Strategy to reconnect.','Disconnected');} };
    ws.onmessage=async event=>{
      let msg; try{msg=JSON.parse(event.data)}catch(_){return;}
      if(msg.error){status('Deriv data error: '+msg.error.message,'API error');return;}
      if(msg.msg_type==='active_symbols' && !initialized){
        initialized=true;
       let symbols=(msg.active_symbols||[]).map(s=>({...s,symbol:s.underlying_symbol||s.symbol,display_name:s.underlying_symbol_name||s.display_name})).filter(s=>s.exchange_is_open!==0 && s.symbol && s.pip_size!==undefined);
        const filter=el('smartMarketFilter').value;
        if(filter==='synthetic') symbols=symbols.filter(s=>String(s.market||'').toLowerCase().includes('synthetic') || String(s.submarket||'').toLowerCase().includes('continuous'));
        // Limit subscription fan-out to active symbols available from this API response.
        symbols=symbols.slice(0,80);
        if(!symbols.length){status('No eligible symbols returned by Deriv.','No markets');return;}
        status(`Loading 500-tick histories for ${symbols.length} markets…`,'Loading history');
        for(let i=0;i<symbols.length && running;i++){
          const sym=symbols[i];
          try {
            const history=await new Promise((resolve,reject)=>{
              const reqId=1000+i;
              const handler=e=>{let d;try{d=JSON.parse(e.data)}catch(_){return;}if(d.req_id!==reqId)return;ws.removeEventListener('message',handler);d.error?reject(new Error(d.error.message)):resolve(d);};
              ws.addEventListener('message',handler);send({ticks_history:sym.symbol,adjust_start_time:1,count:WINDOW,end:'latest',style:'ticks',req_id:reqId});
              setTimeout(()=>{ws.removeEventListener('message',handler);reject(new Error('History timeout'));},12000);
            });
            const digits=(history.history?.prices||[]).map(q=>digitFromQuote(q,sym.pip_size));
            const state={name:sym.display_name||sym.symbol,pipSize:sym.pip_size,digits:digits.slice(-WINDOW)};
            marketData.set(sym.symbol,state);
            send({ticks:sym.symbol,subscribe:1}); subscriptions.add(sym.symbol);
            // Render initial waiting rows while the live tick stream warms up.
            for(const rule of rules) if(selectedRules().has(rule.name)) renderRow(sym.symbol,state.name,state,rule,null);
          } catch(err) { /* skip unavailable symbols and continue scanning other markets */ }
          status(`Subscribed ${marketData.size}/${symbols.length} markets`,'Running');
        }
        status(`Smart Strategy running on ${marketData.size} subscribed markets. Auto-buy enabled for selected account mode. Real mode uses real funds.`,'Running');
      }
      if(msg.msg_type==='tick' && msg.tick) onTick(msg.tick);
    };
  }
  el('smartStart').addEventListener('click',start);
  el('smartStop').addEventListener('click',()=>stop());
  window.addEventListener('beforeunload',()=>{try{if(ws)ws.close()}catch(_){}});
})();
// ---- Deriv connection status ----
async function refreshDeriv(){
  try{
    const d=await (await fetch('/api/deriv/accounts',{credentials:'same-origin'})).json();
    if(!d.connected){
      $('apiState').textContent=d.configured?'Not connected — click Connect':'Server missing DERIV_CLIENT_ID';
      return;
    }
    const active=d.accounts.find(a=>a.loginid===d.active);
    $('apiState').textContent='Connected · '+d.active;
    $('mode').value=active&&active.isVirtual?'Demo':'Real';
    const b=await (await fetch('/api/deriv/balance',{credentials:'same-origin'})).json();
    if(b.balance!==undefined){
      const t=b.currency+' '+Number(b.balance).toLocaleString('en-US',{minimumFractionDigits:2});
      ['balance','balance2','balance3'].forEach(id=>{const el=$(id);if(el)el.textContent=t});
    }
  }catch(e){ $('apiState').textContent='Server unreachable'; }
}
const qs=new URLSearchParams(location.search);
if(qs.get('derivError')) toast(qs.get('derivError'));
refreshDeriv();
