// Real-browser QA of the admin panel over CDP (headless Chrome on :9354, or CDP_PORT).
// ADMIN_URL=http://127.0.0.1:8790 SETUP_LINK=... node test/browser/admin-qa.mjs
import { createHmac } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = process.env.ADMIN_URL || 'http://127.0.0.1:8790';
const OUT = process.env.QA_OUT || '/tmp/admin-qa';
mkdirSync(OUT, { recursive: true });
const CDP = `http://127.0.0.1:${process.env.CDP_PORT || 9354}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function b32(s) { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, v = 0; const out = []; for (const c of s.replace(/\s/g, '')) { v = (v << 5) | A.indexOf(c); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); }
export function totp(secret, t = Date.now()) {
  const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
  const mac = createHmac('sha1', b32(secret)).update(c).digest(); const o = mac[19] & 15;
  return String(((mac[o] & 127) << 24 | mac[o + 1] << 16 | mac[o + 2] << 8 | mac[o + 3]) % 1e6).padStart(6, '0');
}

export async function openPage(width = 1440, height = 900, mobile = false) {
  const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  let id = 0; const pending = new Map(); const errors = []; const dialogs = [];
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.value || a.description).join(' ')); };
  const send = (method, params = {}) => new Promise(r => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
  if (mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true });
  const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed'); return r.result?.result?.value; };
  const go = async url => { await send('Page.navigate', { url }); await sleep(900); };
  const shot = async name => { const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64')); return `${OUT}/${name}.png`; };
  const waitFor = async (expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await sleep(150); } throw new Error(`timeout waiting for ${expr}`); };
  const type = async (sel, text) => ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});el.focus();el.value=${JSON.stringify(text)};el.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  const click = async sel => ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return false;el.click();return true})()`);
  const clickText = async (text, sel = 'button,a') => ev(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(sel)})].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!el)return false;el.click();return true})()`);
  const setCookie = c => send('Network.setCookie', c);
  return { send, ev, go, shot, waitFor, type, click, clickText, errors, dialogs, close: () => send('Page.close'), setCookie };
}
