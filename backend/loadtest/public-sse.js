// Opens many simultaneous public SSE connections (RT-8: at least 20,000) spread over topics, and
// keeps them alive with continuity (lastEventId) and full-jitter reconnection.
//
// Usage: node loadtest/public-sse.js --url https://your-domain --clients 20000 --workers 4 --ramp 1000
// Tip: raise the file descriptor limit first:  ulimit -n 65535
// For more than ~25k connections use several machines (one source IP has ~28k ephemeral ports per
// destination).
import cluster from 'node:cluster';
import { args, openSse, fullJitter, sleep } from './lib/common.js';

const o = args({ url: 'http://localhost:8080', clients: 20000, workers: 4, ramp: 1000, seconds: 0 });
const base = o.url.replace(/\/$/, '');

function pickTopic() {
  const r = Math.random();
  if (r < 0.15) return 'dept';
  if (r < 0.8) return `mun:${1 + Math.floor(Math.random() * 30)}`;
  return `puesto:${1 + Math.floor(Math.random() * 1842)}`;
}

if (cluster.isPrimary) {
  const totals = {};
  console.log(`Abriendo ${o.clients} conexiones SSE contra ${base} con ${o.workers} procesos…`);
  for (let i = 0; i < o.workers; i++) {
    const w = cluster.fork({ WORKER_CLIENTS: Math.ceil(o.clients / o.workers), WORKER_RAMP: Math.ceil(o.ramp / o.workers) });
    w.on('message', (m) => { totals[w.id] = m; });
  }
  const t0 = Date.now();
  setInterval(() => {
    const agg = Object.values(totals).reduce((a, m) => {
      for (const k of Object.keys(m)) a[k] = (a[k] || 0) + m[k];
      return a;
    }, {});
    const el = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`[${el}s] conectados=${agg.open || 0} eventos/s=${agg.eventsPerSec || 0} snapshots=${agg.snapshots || 0} catchups=${agg.catchups || 0} 503=${agg.busy || 0} errores=${agg.errors || 0} reconexiones=${agg.reconnects || 0} instancias=${agg.instances || 0}`);
    if (o.seconds && Date.now() - t0 > o.seconds * 1000) process.exit(0);
  }, 2000);
} else {
  const n = Number(process.env.WORKER_CLIENTS);
  const ramp = Number(process.env.WORKER_RAMP);
  const s = { open: 0, events: 0, snapshots: 0, catchups: 0, busy: 0, errors: 0, reconnects: 0 };
  const instances = new Set();
  let lastEvents = 0;

  function connect(state) {
    openSse(base, state.topic, {
      lastEventId: state.lastId,
      onOpen: () => { s.open++; state.attempt = 0; state.isOpen = true; },
      onEvent: (ev) => {
        if (ev.id) state.lastId = ev.id;
        s.events++;
        if (ev.event === 'snapshot') s.snapshots++;
        if (ev.event === 'catchup') s.catchups++;
        if (ev.event === 'hello') instances.add(JSON.parse(ev.data).instanceId);
      },
      onClose: () => { if (state.isOpen) { s.open--; state.isOpen = false; } retry(state); },
      onError: (e) => { if (e.status === 503) s.busy++; else s.errors++; retry(state, e.retryAfter); },
    });
  }
  function retry(state, retryAfterSec) {
    s.reconnects++;
    const wait = Math.max(fullJitter(state.attempt++), (retryAfterSec || 0) * 1000 * Math.random());
    setTimeout(() => connect(state), wait);
  }

  (async () => {
    for (let i = 0; i < n; i++) {
      connect({ topic: pickTopic(), lastId: '', attempt: 0, isOpen: false });
      if ((i + 1) % ramp === 0) await sleep(1000);
    }
  })();

  setInterval(() => {
    process.send({ ...s, events: undefined, eventsPerSec: Math.round((s.events - lastEvents) / 2), instances: instances.size });
    lastEvents = s.events;
  }, 2000);
}
