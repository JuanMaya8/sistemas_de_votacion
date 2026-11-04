// RF-10: reconnection avalanche. Opens N public connections, then simulates the death of the
// instance by cutting ALL of them at the same instant, and records reconnection attempts per second
// with two client strategies:
//   naive  -> every client retries immediately and then every 1 s (synchronized herd)
//   jitter -> exponential backoff with full jitter + honours Retry-After (what the frontend does)
// Produces storm-<mode>.csv and storm-comparison.svg (attempts per second, with vs without jitter).
//
// Usage: node loadtest/reconnect-storm.js --url http://localhost:8080 --clients 3000 --seconds 40
import { writeFileSync } from 'node:fs';
import { args, openSse, fullJitter, sleep, svgChart } from './lib/common.js';

const o = args({ url: 'http://localhost:8080', clients: 3000, seconds: 40, mode: 'both' });
const base = o.url.replace(/\/$/, '');

async function run(mode) {
  const perSecond = Array.from({ length: o.seconds + 1 }, () => ({ attempts: 0, ok: 0, busy: 0 }));
  let t0 = 0;
  let measuring = false;
  const states = [];
  let open = 0;

  const connect = (st) => {
    if (measuring) perSecond[Math.min(o.seconds, Math.floor((Date.now() - t0) / 1000))].attempts++;
    st.handle = openSse(base, 'dept', {
      lastEventId: st.lastId,
      onOpen: () => { open++; st.open = true; st.attempt = 0; if (measuring) perSecond[Math.min(o.seconds, Math.floor((Date.now() - t0) / 1000))].ok++; },
      onEvent: (ev) => { if (ev.id) st.lastId = ev.id; },
      onClose: () => { if (st.open) { open--; st.open = false; } if (!st.stopped) schedule(st); },
      onError: (e) => { if (measuring && e.status === 503) perSecond[Math.min(o.seconds, Math.floor((Date.now() - t0) / 1000))].busy++; if (!st.stopped) schedule(st, e.retryAfter); },
    });
  };
  const schedule = (st, retryAfter) => {
    if (st.timer) return;
    const wait = mode === 'naive'
      ? (st.attempt++ === 0 ? 0 : 1000)
      : Math.max(fullJitter(st.attempt++), retryAfter ? retryAfter * 1000 * Math.random() : 0);
    st.timer = setTimeout(() => { st.timer = null; connect(st); }, wait);
  };

  console.log(`\n[${mode}] abriendo ${o.clients} conexiones…`);
  for (let i = 0; i < o.clients; i++) {
    const st = { attempt: 0, lastId: '', open: false };
    states.push(st);
    connect(st);
    if (i % 200 === 199) await sleep(400);
  }
  for (let i = 0; i < 60 && open < o.clients * 0.95; i++) await sleep(1000);
  console.log(`[${mode}] ${open} conectadas. Simulando caída de la instancia: se cortan todas a la vez.`);
  measuring = true;
  t0 = Date.now();
  for (const st of states) { st.attempt = 0; st.handle.close(); }
  await sleep(o.seconds * 1000);
  measuring = false;
  for (const st of states) { st.stopped = true; clearTimeout(st.timer); st.handle.close(); }
  const peak = Math.max(...perSecond.map((p) => p.attempts));
  console.log(`[${mode}] pico de intentos de reconexión: ${peak}/s · reconectadas al final: ${open}`);
  writeFileSync(`storm-${mode}.csv`, 'segundo,intentos,exitosas,rechazadas_503\n' + perSecond.map((p, i) => `${i},${p.attempts},${p.ok},${p.busy}`).join('\n'));
  await sleep(3000);
  return perSecond;
}

const modes = o.mode === 'both' ? ['naive', 'jitter'] : [o.mode];
const results = {};
for (const m of modes) results[m] = await run(m);
const colors = { naive: '#d6453d', jitter: '#2a7de1' };
const names = { naive: 'Sin jitter (reintento inmediato)', jitter: 'Backoff exponencial + jitter' };
writeFileSync('storm-comparison.svg', svgChart('Reconexiones por segundo tras la caída de una instancia',
  modes.map((m) => ({ name: names[m], color: colors[m], points: results[m].map((p) => p.attempts) })), 'intentos / s'));
console.log('\nArchivos generados: ' + modes.map((m) => `storm-${m}.csv`).join(', ') + ', storm-comparison.svg');
process.exit(0);
