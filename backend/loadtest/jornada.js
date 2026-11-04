// Simulates the election-night transmission profile against the deployment (RT-8):
//  - 6,400 actas, 55% within the first third of the window (the "first 40 minutes")
//  - 4–11% resends of the same submission (same idem key)
//  - ~180 corrections, some delivered OUT OF ORDER (v3 before v2)
//  - 6–9% doubtful actas (votes ≠ voters) that go to human verification
// At the end it checks convergence: the department total must equal the sum of the highest valid
// version of every acta, regardless of arrival order.
//
// Usage: node loadtest/jornada.js --url https://your-domain --minutes 10 --concurrency 60
import http from 'node:http';
import https from 'node:https';
import { args, sleep, json } from './lib/common.js';

const o = args({ url: 'http://localhost:8080', actas: 6400, minutes: 10, dup: 0.08, corrections: 180, doubtful: 0.075, concurrency: 60, seed: 42 });
const base = o.url.replace(/\/$/, '');
const agent = new (base.startsWith('https') ? https : http).Agent({ keepAlive: true, maxSockets: o.concurrency });

// Deterministic PRNG so runs are reproducible.
let s = o.seed >>> 0;
const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const rint = (a, b) => a + Math.floor(rnd() * (b - a + 1));

const TOTAL_MESAS = 6400, TOTAL_PUESTOS = 1842, TOTAL_MUN = 30;
const puestoOf = (m) => Math.floor(((m - 1) * TOTAL_PUESTOS) / TOTAL_MESAS) + 1;
const munOf = (p) => Math.floor(((p - 1) * TOTAL_MUN) / TOTAL_PUESTOS) + 1;
const runId = Date.now().toString(36);

function makeVotes() {
  const v = { C1: rint(20, 220), C2: rint(20, 200), C3: rint(10, 320), C4: rint(5, 120), BLANCO: rint(0, 25), NULO: rint(0, 10), NO_MARCADO: rint(0, 6) };
  return v;
}
const sum = (v) => Object.values(v).reduce((a, b) => a + b, 0);

// ---------- build the plan ----------
const plan = [];
const expected = new Map(); // acta -> highest valid version votes
const nActas = Math.min(o.actas, TOTAL_MESAS);
for (let mesa = 1; mesa <= nActas; mesa++) {
  const puesto = puestoOf(mesa);
  const acta = `E14-${String(puesto).padStart(3, '0')}-${String(mesa).padStart(4, '0')}-03`;
  const votos = makeVotes();
  const isDoubtful = rnd() < o.doubtful;
  const sufragantes = isDoubtful ? sum(votos) + rint(3, 40) : sum(votos);
  const base = { acta, mesa, puesto, municipio: munOf(puesto), version: 1, jurado: `JUR-${10000 + mesa}`, ts_cierre: Math.floor(Date.now() / 1000), votos, sufragantes, hash_foto: `h${mesa}`, idem: `${runId}-${mesa}-1` };
  // 55% in the first third of the window, the rest spread over the remaining two thirds.
  const t = rnd() < 0.55 ? rnd() / 3 : 1 / 3 + (rnd() * 2) / 3;
  plan.push({ at: t, acta: base });
  if (!isDoubtful) expected.set(acta, { version: 1, votos });
  if (rnd() < o.dup) plan.push({ at: Math.min(1, t + rnd() * 0.02), acta: base, dup: true });
}

const validActas = plan.filter((p) => !p.dup && expected.has(p.acta.acta));
for (let i = 0; i < o.corrections && validActas.length; i++) {
  const orig = validActas[Math.floor(rnd() * validActas.length)].acta;
  if (expected.get(orig.acta).version > 1) continue;
  const v2 = { ...orig, version: 2, votos: makeVotes(), idem: `${runId}-${orig.mesa}-2` }; v2.sufragantes = sum(v2.votos);
  const t = 0.5 + rnd() * 0.45;
  if (rnd() < 0.3) {
    // v3 arrives BEFORE v2 (retries on a bad network)
    const v3 = { ...orig, version: 3, votos: makeVotes(), idem: `${runId}-${orig.mesa}-3` }; v3.sufragantes = sum(v3.votos);
    plan.push({ at: t, acta: v3, correction: true }, { at: t + 0.02, acta: v2, correction: true, late: true });
    expected.set(orig.acta, { version: 3, votos: v3.votos });
  } else {
    plan.push({ at: t, acta: v2, correction: true });
    expected.set(orig.acta, { version: 2, votos: v2.votos });
  }
}
plan.sort((a, b) => a.at - b.at);

// ---------- run ----------
const stats = {};
let sent = 0, errors = 0, retries = 0;
const durationMs = o.minutes * 60000;
const start = Date.now();
console.log(`Jornada simulada: ${plan.length} envíos (${nActas} actas) en ${o.minutes} min contra ${base}`);

async function send(item) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const r = await json(`${base}/api/actas`, 'POST', item.acta, agent);
      const st = r.body?.status || `HTTP_${r.status}`;
      const key = r.body?.duplicate ? `${st} (reenvío)` : st;
      if (r.body?.final) { stats[key] = (stats[key] || 0) + 1; return; }
      retries++;
      await sleep(Math.random() * Math.min(10000, 500 * 2 ** attempt));
    } catch { errors++; await sleep(Math.random() * Math.min(10000, 500 * 2 ** attempt)); }
  }
  stats.GAVE_UP = (stats.GAVE_UP || 0) + 1;
}

let idx = 0;
const inflight = new Set();
const progress = setInterval(() => {
  const el = ((Date.now() - start) / 1000).toFixed(0);
  console.log(`[${el}s] enviados ${sent}/${plan.length} · en vuelo ${inflight.size} · reintentos ${retries} · errores red ${errors}`);
}, 5000);

while (idx < plan.length) {
  const now = Date.now() - start;
  while (idx < plan.length && plan[idx].at * durationMs <= now && inflight.size < o.concurrency) {
    const p = send(plan[idx++]).finally(() => inflight.delete(p));
    inflight.add(p); sent++;
  }
  await sleep(inflight.size >= o.concurrency ? 5 : 20);
}
await Promise.all(inflight);
clearInterval(progress);

console.log('\nRespuestas por estado:');
console.table(stats);

// ---------- convergence check ----------
await sleep(5000);
const exp = { C1: 0, C2: 0, C3: 0, C4: 0, BLANCO: 0, NULO: 0, NO_MARCADO: 0 };
for (const { votos } of expected.values()) for (const k of Object.keys(exp)) exp[k] += votos[k];
const snap = await json(`${base}/api/public/snapshot?topic=dept`);
console.log('\nConvergencia del acumulado departamental (solo actas válidas; las dudosas esperan verificación):');
const rows = Object.keys(exp).map((k) => ({ campo: k, esperado: exp[k], servidor: snap.body?.values?.[k], ok: exp[k] === snap.body?.values?.[k] }));
console.table(rows);
console.log(rows.every((r) => r.ok)
  ? '✅ CONVERGENCIA OK: el resultado no depende del orden de llegada (nota: si ya había datos previos en Redis, ejecute "npm run reset" antes).'
  : '⚠️  Diferencias: ¿había datos de una ejecución anterior o actas dudosas aprobadas? Ejecute "npm run reset" y repita.');

const m = await json(`${base}/api/metrics/cluster`);
if (m.body?.cluster) {
  const c = m.body.cluster;
  console.log(`\nMensajes públicos emitidos (real): ${c.sentTotal.toLocaleString('es-CO')}`);
  console.log(`Mensajes con diseño ingenuo (1 por acta por cliente): ${c.naiveTotal.toLocaleString('es-CO')}`);
  if (c.naiveTotal) console.log(`Reducción: ${(100 - (c.sentTotal * 100) / c.naiveTotal).toFixed(2)}%`);
}
process.exit(0);
