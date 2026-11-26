// EBDA3 image proxy. The Hugging Face token lives only in the HF_TOKEN environment variable on the host.
// It calls the public Z-Image Turbo Space for the EBDA3 AI site and returns the image. No dependencies.
const http = require('http');
const HOST = 'https://mrfakename-z-image-turbo.hf.space/gradio_api/call/generate_image';
const TOKEN = process.env.HF_TOKEN || '';
const ALLOW = (process.env.ALLOW_ORIGIN || 'https://teamforge-bridge-ahmed.github.io').split(',').map(s => s.trim());
const PER_MIN = +process.env.PER_MIN || 40, PER_HOUR = +process.env.PER_HOUR || 300, PER_DAY_ALL = +process.env.PER_DAY_ALL || 2500, MAX_PAR = 3;
const hits = new Map(); let day = { d: new Date().toDateString(), n: 0 }, running = 0, quotaUntil = 0;

function limited(ip) {
  const now = Date.now(), a = (hits.get(ip) || []).filter(t => now - t < 3600000);
  if (a.length >= PER_HOUR || a.filter(t => now - t < 60000).length >= PER_MIN) { hits.set(ip, a); return true; }
  a.push(now); hits.set(ip, a);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 3600000) hits.delete(k);
  return false;
}
function send(res, code, obj, origin) {
  const h = { 'Content-Type': 'application/json', 'Vary': 'Origin' };
  if (origin) { h['Access-Control-Allow-Origin'] = origin; }
  res.writeHead(code, h); res.end(JSON.stringify(obj));
}
async function draw(prompt, w, h, seed) {
  const hd = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN };
  const r = await fetch(HOST, { method: 'POST', headers: hd, body: JSON.stringify({ data: [prompt, h, w, 9, seed, false] }), signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw Object.assign(new Error('space ' + r.status), { code: 502 });
  const { event_id } = await r.json();
  const t = await (await fetch(HOST + '/' + event_id, { headers: { Authorization: hd.Authorization }, signal: AbortSignal.timeout(110000) })).text();
  const m = t.match(/event: complete\s*\ndata: (.*)/);
  if (!m) { if (/quota|exceeded/i.test(t)) throw Object.assign(new Error('quota'), { code: 429 }); throw Object.assign(new Error('no image'), { code: 502 }); }
  const url = JSON.parse(m[1])[0] && JSON.parse(m[1])[0].url;
  if (!url || !url.startsWith('https://mrfakename-z-image-turbo.hf.space/')) throw Object.assign(new Error('bad url'), { code: 502 });
  const ir = await fetch(url, { headers: { Authorization: hd.Authorization }, signal: AbortSignal.timeout(30000) });
  if (!ir.ok) throw Object.assign(new Error('file ' + ir.status), { code: 502 });
  return { buf: Buffer.from(await ir.arrayBuffer()), type: ir.headers.get('content-type') || 'image/png' };
}
const HF_MODELS = (process.env.HF_MODELS || 'black-forest-labs/FLUX.1-schnell').split(',');
async function drawHF(prompt, w, h, seed) {
  let last = 'none';
  for (const m of HF_MODELS) {
    try {
      const r = await fetch('https://router.huggingface.co/hf-inference/models/' + m, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', Accept: 'image/png' }, body: JSON.stringify({ inputs: prompt, parameters: { width: Math.min(w, 1024), height: Math.min(h, 1024), seed } }), signal: AbortSignal.timeout(60000) });
      const type = r.headers.get('content-type') || '';
      if (r.ok && type.startsWith('image/')) return { buf: Buffer.from(await r.arrayBuffer()), type, src: 'hf:' + m };
      last = m + ' ' + r.status + ' ' + (await r.text()).slice(0, 80);
    } catch (e) { last = m + ' ' + e.message; }
  }
  throw Object.assign(new Error(last), { code: 502 });
}
http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  const ok = ALLOW.includes(origin);
  if (req.method === 'OPTIONS') { res.writeHead(ok ? 204 : 403, ok ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600', Vary: 'Origin' } : {}); return res.end(); }
  if (req.method === 'GET') return send(res, 200, { ok: true, token: !!TOKEN }, '');
  if (req.method !== 'POST' || req.url !== '/img') return send(res, 404, { error: 'not found' });
  if (!ok) return send(res, 403, { error: 'origin' });
  if (!TOKEN) return send(res, 503, { error: 'not configured' }, origin);
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (limited(ip)) return send(res, 429, { error: 'rate' }, origin);
  if (day.d !== new Date().toDateString()) day = { d: new Date().toDateString(), n: 0 };
  if (day.n >= PER_DAY_ALL) return send(res, 429, { error: 'daily' }, origin);
  if (running >= MAX_PAR) return send(res, 429, { error: 'busy' }, origin);
  let body = ''; for await (const c of req) { body += c; if (body.length > 5000) return send(res, 413, { error: 'big' }, origin); }
  let j; try { j = JSON.parse(body); } catch { return send(res, 400, { error: 'json' }, origin); }
  const prompt = String(j.prompt || '').slice(0, 900), w = Math.round(+j.w), h = Math.round(+j.h), seed = Math.abs(Math.round(+j.seed || 0)) % 100000;
  if (!prompt || !(w >= 256 && w <= 1024 && h >= 256 && h <= 1024)) return send(res, 400, { error: 'params' }, origin);
  day.n++; running++;
  try {
    let out, src = 'z-image';
    try { if (Date.now() < quotaUntil) throw Object.assign(new Error('quota'), { code: 429 }); out = await draw(prompt, w, h, seed); }
    catch (e) { if (e.code !== 429) throw e; quotaUntil = Date.now() + 10 * 60000; out = await drawHF(prompt, w, h, seed); src = out.src; }
    res.writeHead(200, { 'Content-Type': out.type, 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': 'X-Src', 'X-Src': src, Vary: 'Origin', 'Cache-Control': 'no-store' }); res.end(out.buf);
  } catch (e) {
    if (e.code === 429) quotaUntil = Date.now() + 10 * 60000;
    send(res, e.code || 502, { error: e.code === 429 ? 'quota' : 'upstream', detail: String(e.message || '').slice(0, 200) }, origin);
  } finally { running--; }
}).listen(process.env.PORT || 3000, () => console.log('ebda3 proxy up'));
