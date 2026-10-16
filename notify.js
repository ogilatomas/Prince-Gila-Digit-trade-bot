// notify.js — sends a WhatsApp message. Used by POST /api/notify in server.js.
// Providers (set WHATSAPP_PROVIDER in the environment):
//   callmebot (default) : free personal alerts to YOUR OWN number. Needs WHATSAPP_PHONE and CALLMEBOT_APIKEY.
//   twilio              : Twilio WhatsApp. Needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM, WHATSAPP_PHONE.
// Messages never include tokens, balances or account ids.
const MIN_GAP_MS = 4000, HOURLY_CAP = 60;
let lastSent = 0, sentTimes = [];

const providerOf = env => String(env.WHATSAPP_PROVIDER || 'callmebot').toLowerCase();
function isConfigured(env = process.env) {
  if (!env.WHATSAPP_PHONE) return false;
  if (providerOf(env) === 'twilio') return !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_WHATSAPP_FROM);
  return !!env.CALLMEBOT_APIKEY;
}

async function sendWhatsApp(text, env = process.env, fetchImpl = globalThis.fetch, now = Date.now()) {
  if (!isConfigured(env)) throw Object.assign(new Error('WhatsApp is not configured on the server.'), { status: 503 });
  const msg = String(text || '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 700);
  if (!msg) throw Object.assign(new Error('Empty message.'), { status: 400 });
  sentTimes = sentTimes.filter(t => now - t < 3600000);
  if (now - lastSent < MIN_GAP_MS) throw Object.assign(new Error('Sending too fast; message skipped.'), { status: 429 });
  if (sentTimes.length >= HOURLY_CAP) throw Object.assign(new Error('Hourly WhatsApp limit reached.'), { status: 429 });
  const phone = String(env.WHATSAPP_PHONE).replace(/[^\d]/g, '');       // digits only, with country code, e.g. 2547XXXXXXXX
  let res;
  if (providerOf(env) === 'twilio') {
    const sid = env.TWILIO_ACCOUNT_SID;
    res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${env.TWILIO_AUTH_TOKEN}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: 'whatsapp:' + String(env.TWILIO_WHATSAPP_FROM).replace(/^whatsapp:/, ''), To: 'whatsapp:+' + phone, Body: msg }).toString()
    });
  } else {
    const url = 'https://api.callmebot.com/whatsapp.php?' + new URLSearchParams({ phone, text: msg, apikey: env.CALLMEBOT_APIKEY }).toString();
    res = await fetchImpl(url);
  }
  if (!res.ok) throw Object.assign(new Error(`WhatsApp provider rejected the message (HTTP ${res.status}).`), { status: 502 });
  lastSent = now; sentTimes.push(now);
  return { ok: true, provider: providerOf(env) };
}
const _reset = () => { lastSent = 0; sentTimes = []; };
module.exports = { sendWhatsApp, isConfigured, _reset };
