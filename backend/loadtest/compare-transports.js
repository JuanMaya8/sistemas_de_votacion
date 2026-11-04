// Section 7 measurement: the same public audience served with SSE, WebSocket and polling.
// Run it WHILE loadtest/jornada.js is generating actas. For each transport it reports messages,
// bytes received, HTTP requests made and delivery delay (server "at" -> client reception).
// Note: delay uses the server clock; run the test from a machine with NTP-synced time.
//
// Usage: node loadtest/compare-transports.js --url http://localhost:8080 --clients 300 --seconds 60 --poll 2
import { WebSocket } from 'ws';
import { args, openSse, json, sleep } from './lib/common.js';

const o = args({ url: 'http://localhost:8080', clients: 300, seconds: 60, poll: 2, topic: 'dept' });
const base = o.url.replace(/\/$/, '');
const wsBase = base.replace(/^http/, 'ws');
const mk = () => ({ messages: 0, bytes: 0, requests: 0, delays: [], changes: 0 });
const r = { SSE: mk(), WebSocket: mk(), Polling: mk() };
const stop = [];

for (let i = 0; i < o.clients; i++) {
  // SSE
  r.SSE.requests++;
  const h = openSse(base, o.topic, {
    onEvent: (ev, bytes) => {
      r.SSE.bytes += bytes || 0;
      if (ev.event !== 'update') return;
      r.SSE.messages++;
      const d = JSON.parse(ev.data); if (d.at) r.SSE.delays.push(Date.now() - d.at);
    },
  });
  stop.push(() => h.close());
  // WebSocket
  r.WebSocket.requests++;
  const ws = new WebSocket(`${wsBase}/ws/public?topic=${encodeURIComponent(o.topic)}`);
  ws.on('message', (buf) => {
    r.WebSocket.bytes += buf.length;
    const m = JSON.parse(buf);
    if (m.type !== 'update') return;
    r.WebSocket.messages++;
    if (m.data.at) r.WebSocket.delays.push(Date.now() - m.data.at);
  });
  ws.on('error', () => {});
  stop.push(() => ws.terminate());
  // Polling
  let lastId = null;
  const t = setInterval(async () => {
    try {
      r.Polling.requests++;
      const res = await json(`${base}/api/public/snapshot?topic=${encodeURIComponent(o.topic)}`);
      r.Polling.bytes += JSON.stringify(res.body).length + 250; // + approx. HTTP headers
      r.Polling.messages++;
      if (res.body.id !== lastId) { r.Polling.changes++; if (lastId && res.body.at) r.Polling.delays.push(Date.now() - Number(res.body.id.split('-')[0])); lastId = res.body.id; }
    } catch { /* ignore */ }
  }, o.poll * 1000 + Math.random() * 200);
  stop.push(() => clearInterval(t));
  if (i % 100 === 99) await sleep(300);
}

console.log(`Midiendo ${o.seconds}s con ${o.clients} clientes por transporte (tópico ${o.topic})…`);
await sleep(o.seconds * 1000);
stop.forEach((f) => f());

const pct = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length * p)] : null);
console.table(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, {
  mensajes: v.messages,
  'KB recibidos': Math.round(v.bytes / 1024),
  'peticiones HTTP': v.requests,
  'retraso p50 (ms)': pct(v.delays, 0.5),
  'retraso p95 (ms)': pct(v.delays, 0.95),
  'KB por cliente': +(v.bytes / 1024 / o.clients).toFixed(1),
}])));
console.log('Lectura: SSE y WebSocket entregan con retraso ≈ ventana de agregación; polling añade hasta un intervalo completo de retraso y multiplica peticiones (y bytes de cabeceras) aunque no haya cambios.');
process.exit(0);
