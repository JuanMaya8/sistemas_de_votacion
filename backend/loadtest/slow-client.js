// RF-9 demo: a deliberately slow public client.
// It connects to a topic, STOPS reading its socket (like a saturated mobile network) while the
// server floods the topic, and then reads again. Expected server policy:
//   pending bytes > SLOW_SOFT_BYTES  -> stop sending detail; send ONE snapshot when the buffer drains
//   pending bytes > SLOW_HARD_BYTES or lagging > SLOW_MAX_LAG_MS -> disconnect; the client resumes
//                                                                   with its lastEventId
// Requires the instances to run with DEBUG_ENDPOINTS=1 (enables POST /api/debug/flood).
//
// Usage: node loadtest/slow-client.js --url http://localhost:8080 --pause 15
import { args, openSse, json, sleep } from './lib/common.js';

const o = args({ url: 'http://localhost:8080', topic: 'dept', pause: 15, count: 3000, size: 16384 });
const base = o.url.replace(/\/$/, '');
let lastId = '';
let res = null;
const counts = { update: 0, snapshot: 0, catchup: 0, other: 0, bytes: 0 };

function connect() {
  openSse(base, o.topic, {
    lastEventId: lastId,
    onOpen: (r) => { res = r; console.log(`[cliente lento] conectado (lastEventId=${lastId || 'ninguno'})`); },
    onEvent: (ev, bytes) => {
      if (ev.id) lastId = ev.id;
      counts.bytes += bytes || 0;
      if (counts[ev.event] !== undefined) counts[ev.event]++; else counts.other++;
      if (ev.event === 'snapshot' || ev.event === 'catchup') console.log(`[cliente lento] recibió ${ev.event.toUpperCase()} id=${ev.id}`);
    },
    onClose: () => { console.log('[cliente lento] el servidor cerró la conexión (cliente lento). Reconectando con continuidad…'); setTimeout(connect, 1000); },
    onError: (e) => { console.log('[cliente lento] error', e); setTimeout(connect, 2000); },
  });
}

connect();
await sleep(1500);
console.log(`[cliente lento] dejando de leer el socket por ${o.pause}s y disparando inundación (${o.count} mensajes de ${o.size} bytes)…`);
res?.pause();
const r = await json(`${base}/api/debug/flood`, 'POST', { topic: o.topic, count: o.count, size: o.size });
console.log('[flood]', r.status, r.body?.message || r.body);
for (let i = 0; i < o.pause; i += 3) {
  await sleep(3000);
  const m = await json(`${base}/api/metrics/cluster`);
  const lag = m.body?.instances?.map((x) => `${x.instanceId}: lentos=${x.laggingClients} snapshots=${x.totals.slowSnapshots} desconexiones=${x.totals.slowDisconnects}`).join(' | ');
  console.log(`[métricas] ${lag}`);
}
console.log('[cliente lento] vuelve a leer…');
res?.resume();
await sleep(6000);
console.log('[resultado]', counts);
console.log('Interpretación: con la política activa el cliente recibe pocas actualizaciones de detalle y luego un SNAPSHOT (o es desconectado y vuelve con CATCHUP/SNAPSHOT), en lugar de miles de mensajes acumulados en la memoria del servidor.');
process.exit(0);
