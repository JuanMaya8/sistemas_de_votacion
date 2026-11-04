// Leader-only background work:
//  * Aggregation window (RF-4): every WINDOW_MS the leader reads the new applied actas, computes
//    which topics changed and which fields changed, and publishes ONE message per changed topic
//    (instead of one message per acta per client).
//  * Lock sweeper (RF-7) and presence sweeper (RF-8).
// Leadership is a Redis key with owner + TTL, so if the leader dies another instance takes over and
// continues from the cursor stored in Redis. Instances never talk to each other (RT-3).
import { config } from '../config.js';
import { redis, isRedisUp } from '../redis.js';
import { keys, channels } from '../keys.js';
import { parseTotals } from '../realtime/publicHub.js';
import { sweepLocks, sweepPresence } from './verification.js';

let isLeader = false;
let running = false;
let tick = 0;

const toObj = (arr) => { const o = {}; for (let i = 0; i < arr.length; i += 2) o[arr[i]] = arr[i + 1]; return o; };

const fieldLabel = (f) => ({ BLANCO: 'Blanco', NULO: 'Nulos', NO_MARCADO: 'No marcados' }[f] || f);

export function describeCorrection(acta, from, to, diff) {
  const parts = Object.entries(diff).filter(([, d]) => d !== 0).map(([k, d]) => `${fieldLabel(k)} ${d > 0 ? '+' : '−'}${Math.abs(d)}`);
  return `Acta ${acta} corregida (versión ${from} → ${to}): ${parts.join(', ') || 'sin cambio en votos'}.`;
}

export async function runWindow() {
  const cursor = (await redis.get(keys.aggregatorCursor)) || '0-0';
  const res = await redis.xread('COUNT', 20000, 'STREAMS', keys.changes, cursor);
  if (!res || !res.length || !res[0][1].length) return 0;
  const entries = res[0][1];

  const changed = new Map(); // topic -> { fields:Set, corrections:[], actas, minReceivedAt }
  const touch = (topic) => {
    let t = changed.get(topic);
    if (!t) { t = { fields: new Set(), corrections: [], actas: 0, minReceivedAt: Infinity }; changed.set(topic, t); }
    return t;
  };

  for (const [, arr] of entries) {
    const f = toObj(arr);
    const diff = JSON.parse(f.diff);
    const prev = Number(f.prevVersion);
    const receivedAt = Number(f.receivedAt);
    const correction = prev > 0
      ? { acta: f.acta, fromVersion: prev, toVersion: Number(f.version), delta: diff, source: f.source, message: describeCorrection(f.acta, prev, f.version, diff) }
      : null;
    for (const topic of ['dept', `mun:${f.mun}`, `puesto:${f.puesto}`]) {
      const t = touch(topic);
      for (const [k, d] of Object.entries(diff)) if (d !== 0) t.fields.add(k);
      if (correction) t.corrections.push(correction);
      t.actas++;
      if (receivedAt < t.minReceivedAt) t.minReceivedAt = receivedAt;
    }
  }

  // Read every changed total in one MULTI so all levels are a consistent picture.
  const topicList = Array.from(changed.keys());
  const m = redis.multi();
  for (const topic of topicList) m.hgetall(keys.total(topic));
  const totals = await m.exec();

  const instances = await redis.hgetall(keys.metricsInstances);
  const now = Date.now();
  const publicConnections = Object.values(instances || {})
    .map((s) => JSON.parse(s))
    .filter((x) => now - x.at < 10000)
    .reduce((acc, x) => acc + x.connections.public, 0);

  const p = redis.pipeline();
  topicList.forEach((topic, i) => {
    const t = changed.get(topic);
    const full = parseTotals(topic, totals[i][1]);
    const values = {};
    for (const f of t.fields) values[f] = full.values[f]; // minimal delta: only the fields that moved
    const data = {
      topic, label: full.label, values,
      voters: full.voters, reported: full.reported, totalMesas: full.totalMesas, pct: full.pct,
      corrections: t.corrections, actas: t.actas, minReceivedAt: t.minReceivedAt, at: now,
    };
    p.publishUpdate(keys.topicStream(topic), channels.topic(topic), config.historyMaxLen, JSON.stringify(data));
  });
  p.set(keys.aggregatorCursor, entries[entries.length - 1][0]);
  p.hincrby(keys.metricsCounters, 'topicMessages', topicList.length);
  p.hincrby(keys.metricsCounters, 'windows', 1);
  // Naive design: every acta sent to every connected public client.
  p.hincrby(keys.metricsCounters, 'naive', entries.length * publicConnections);
  await p.exec();
  return entries.length;
}

async function loop() {
  if (running || !isRedisUp()) return;
  running = true;
  try {
    isLeader = (await redis.leaderTick(keys.leader, config.instanceId, config.leaderTtlMs)) === 1;
    if (!isLeader) return;
    await runWindow();
    if (tick++ % 2 === 0) { await sweepLocks(); await sweepPresence(); }
  } catch (err) {
    if (isRedisUp()) console.error('[aggregator]', err.message);
  } finally {
    running = false;
  }
}

export function startAggregator() {
  setInterval(loop, config.windowMs).unref();
}

export const leaderStatus = () => ({ isLeader });
