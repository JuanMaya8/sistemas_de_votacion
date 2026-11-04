// Public audience hub: topic subscriptions (RF-5), batched fan-out (RF-4), continuity on
// reconnection (RF-6) and backpressure for slow clients (RF-9). Transport-agnostic: SSE and the
// comparison WebSocket endpoint both plug PublicClient objects into it.
import { config } from '../config.js';
import { redis, sub, isRedisUp, redisHealth } from '../redis.js';
import { keys, channels } from '../keys.js';
import { VOTE_FIELDS, totalMesasOf, topicLabel } from '../catalog.js';
import { metrics, connections } from '../metrics/metrics.js';
import { compareIds, isStreamId } from './streamIds.js';

const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

/**
 * topic -> Set<PublicClient>. Add/remove are O(1); fan-out walks only the subscribers of the
 * topic that changed, never every connection of the instance.
 */
const topics = new Map();
const topicQueues = new Map(); // topic -> promise chain, keeps per-topic order during batched fan-out
const lagging = new Set();

export class PublicClient {
  constructor({ topic, transport, write, buffered, onDrainOnce, close }) {
    this.topic = topic;
    this.transport = transport; // 'sse' | 'ws'
    this.write = write; // (frameString) => void
    this.buffered = buffered; // () => bytes pending in the socket buffer
    this.onDrainOnce = onDrainOnce; // (fn) => void
    this.close = close; // (reason) => void
    this.lastId = '0-0';
    this.ready = false; // false while catching up; live messages are queued meanwhile
    this.pending = [];
    this.lagging = false;
    this.laggingSince = 0;
    this.closed = false;
  }
}

// ---------- frames ----------
const frameCache = new WeakMap();
function frameFor(msg, transport) {
  let f = frameCache.get(msg);
  if (!f) { f = {}; frameCache.set(msg, f); }
  if (!f[transport]) {
    const json = typeof msg.raw === 'string' ? msg.raw : JSON.stringify(msg.d);
    f[transport] = transport === 'sse'
      ? `id: ${msg.id}\nevent: ${msg.event || 'update'}\ndata: ${json}\n\n`
      : `{"type":"${msg.event || 'update'}","id":"${msg.id}","data":${json}}`;
  }
  return f[transport];
}

export function sendControl(client, event, data) {
  if (client.closed) return;
  const json = JSON.stringify(data);
  client.write(client.transport === 'sse' ? `event: ${event}\ndata: ${json}\n\n` : `{"type":"${event}","data":${json}}`);
}

// ---------- registry + backplane subscription ----------
export async function register(client) {
  let set = topics.get(client.topic);
  if (!set) {
    set = new Set();
    topics.set(client.topic, set);
    // First local subscriber of this topic: start listening to its backplane channel.
    await sub.subscribe(channels.topic(client.topic));
  }
  set.add(client);
  connections.public++;
  connections.publicByTransport[client.transport]++;
}

export function unregister(client) {
  if (client.closed) return;
  client.closed = true;
  lagging.delete(client);
  const set = topics.get(client.topic);
  if (set) {
    set.delete(client);
    if (set.size === 0) {
      topics.delete(client.topic);
      sub.unsubscribe(channels.topic(client.topic)).catch(() => {});
    }
  }
  connections.public--;
  connections.publicByTransport[client.transport]--;
}

sub.on('message', (channel, raw) => {
  if (!channel.startsWith('bp:topic:')) return;
  const topic = channel.slice(9);
  const set = topics.get(topic);
  if (!set || set.size === 0) return;
  // The payload is forwarded byte-for-byte: it is parsed only to read the id and the timestamp.
  const parsed = JSON.parse(raw);
  const msg = { id: parsed.id, d: parsed.d, raw: JSON.stringify(parsed.d), event: 'update' };
  const prev = topicQueues.get(topic) || Promise.resolve();
  const next = prev.then(() => fanout(topic, msg)).catch((e) => console.error('[fanout]', e));
  topicQueues.set(topic, next);
  next.finally(() => { if (topicQueues.get(topic) === next) topicQueues.delete(topic); });
});

// ---------- batched fan-out (RF-4) ----------
async function fanout(topic, msg) {
  const set = topics.get(topic);
  if (!set) return;
  const list = Array.from(set);
  let sent = 0;
  for (let i = 0; i < list.length; i += config.fanoutBatchSize) {
    const end = Math.min(i + config.fanoutBatchSize, list.length);
    for (let j = i; j < end; j++) sent += deliver(list[j], msg) ? 1 : 0;
    // Give the Event Loop back between batches so jurados and auditors are never frozen.
    if (end < list.length) await yieldToEventLoop();
  }
  metrics.addSent(sent);
  if (msg.d?.minReceivedAt) metrics.publishLatency(Date.now() - msg.d.minReceivedAt);
}

function deliver(client, msg) {
  if (client.closed) return false;
  if (!client.ready) { client.pending.push(msg); return false; }
  if (compareIds(msg.id, client.lastId) <= 0) return false; // already seen (e.g. inside a snapshot)
  if (client.lagging) return false; // will get a snapshot when its buffer drains
  const pendingBytes = client.buffered();
  if (pendingBytes > config.slowHardBytes) { dropSlow(client); return false; }
  if (pendingBytes > config.slowSoftBytes) { markLagging(client); return false; }
  client.write(frameFor(msg, client.transport));
  client.lastId = msg.id;
  return true;
}

// ---------- backpressure (RF-9) ----------
function markLagging(client) {
  client.lagging = true;
  client.laggingSince = Date.now();
  lagging.add(client);
  metrics.setLagging(lagging.size);
  client.onDrainOnce(async () => {
    if (client.closed) return;
    // Buffer drained: stop sending detail history, send one fresh snapshot instead.
    try {
      const snap = await getSnapshot(client.topic);
      client.lagging = false;
      lagging.delete(client);
      metrics.setLagging(lagging.size);
      metrics.slowSnapshot();
      if (compareIds(snap.id, client.lastId) >= 0) {
        client.write(frameFor({ id: snap.id, d: snap.data, event: 'snapshot' }, client.transport));
        client.lastId = snap.id;
      }
    } catch { dropSlow(client); }
  });
}

function dropSlow(client) {
  metrics.slowDisconnect();
  lagging.delete(client);
  metrics.setLagging(lagging.size);
  // The client keeps its lastEventId and comes back with continuity (RF-6).
  client.close('SLOW_CONSUMER');
}

setInterval(() => {
  const now = Date.now();
  for (const c of lagging) if (now - c.laggingSince > config.slowMaxLagMs) dropSlow(c);
}, 5000).unref();

// ---------- snapshots & catch-up (RF-6) ----------
const snapshotCache = new Map(); // topic -> { at, promise }

export function parseTotals(topic, h) {
  const values = {};
  for (const f of VOTE_FIELDS) values[f] = Number(h?.[f] || 0);
  const reported = Number(h?._reported || 0);
  const totalMesas = totalMesasOf(topic);
  return {
    topic, label: topicLabel(topic), values,
    voters: Number(h?._voters || 0), reported, totalMesas,
    pct: totalMesas ? +((reported * 100) / totalMesas).toFixed(2) : 0,
  };
}

export function getSnapshot(topic) {
  const cached = snapshotCache.get(topic);
  if (cached && Date.now() - cached.at < 1000) return cached.promise;
  const promise = (async () => {
    // MULTI/EXEC: both reads happen at the same instant inside Redis.
    const [[, h], [, last]] = await redis.multi()
      .hgetall(keys.total(topic))
      .xrevrange(keys.topicStream(topic), '+', '-', 'COUNT', 1)
      .exec();
    const id = last && last.length ? last[0][0] : '0-0';
    return { id, data: { ...parseTotals(topic, h), snapshot: true, at: Date.now() } };
  })();
  snapshotCache.set(topic, { at: Date.now(), promise });
  promise.catch(() => snapshotCache.delete(topic));
  return promise;
}

/**
 * Decides what a (re)connecting client needs:
 *  - no lastEventId, or one older than the retained history, or too many entries -> full snapshot
 *  - otherwise -> the missed entries merged into a single "catchup" message (absolute values).
 */
export async function catchUp(topic, lastEventId) {
  if (isStreamId(lastEventId) && lastEventId !== '0-0') {
    const stream = keys.topicStream(topic);
    const [[, first], [, missed]] = await redis.multi()
      .xrange(stream, '-', '+', 'COUNT', 1)
      .xrange(stream, `(${lastEventId}`, '+', 'COUNT', config.replayMaxEntries + 1)
      .exec();
    const firstId = first && first.length ? first[0][0] : null;
    const historyCoversGap = firstId && compareIds(lastEventId, firstId) >= 0;
    if (historyCoversGap && missed.length <= config.replayMaxEntries) {
      if (!missed.length) return { kind: 'none', id: lastEventId };
      const merged = { topic, values: {}, corrections: [], actas: 0, replayed: missed.length, catchup: true };
      for (const [, fields] of missed) {
        const d = JSON.parse(fields[1]);
        Object.assign(merged.values, d.values);
        merged.corrections.push(...(d.corrections || []));
        merged.actas += d.actas || 0;
        Object.assign(merged, { voters: d.voters, reported: d.reported, totalMesas: d.totalMesas, pct: d.pct, label: d.label });
      }
      return { kind: 'catchup', id: missed[missed.length - 1][0], data: merged };
    }
  }
  const snap = await getSnapshot(topic);
  return { kind: 'snapshot', id: snap.id, data: snap.data };
}

/** Called once the client is registered (already receiving live messages into client.pending). */
export async function startClient(client, lastEventId) {
  const r = await catchUp(client.topic, lastEventId);
  if (r.kind !== 'none') {
    client.write(frameFor({ id: r.id, d: r.data, event: r.kind }, client.transport));
  }
  client.lastId = r.id;
  client.ready = true;
  const queued = client.pending;
  client.pending = [];
  let sent = 0;
  for (const msg of queued) sent += deliver(client, msg) ? 1 : 0;
  metrics.addSent(sent + (r.kind !== 'none' ? 1 : 0));
  return r.kind;
}

// ---------- degraded mode (RF-10) ----------
async function broadcastControl(event, data) {
  const all = [];
  for (const set of topics.values()) for (const c of set) all.push(c);
  for (let i = 0; i < all.length; i += config.fanoutBatchSize) {
    for (let j = i; j < Math.min(i + config.fanoutBatchSize, all.length); j++) sendControl(all[j], event, data);
    await yieldToEventLoop();
  }
  return all;
}

redisHealth.on('down', () => {
  broadcastControl('status', { redis: 'down', message: 'Resultados en pausa: estamos restableciendo la conexión con el servidor central. Las cifras mostradas siguen siendo válidas.' });
});

// When the backplane comes back, messages published while we were disconnected are lost
// (Pub/Sub has no memory), so every local client is resynchronised from the stream history.
redisHealth.on('sub-ready', async () => {
  const all = await broadcastControl('status', { redis: 'up', message: 'Conexión restablecida. Actualizando resultados…' });
  for (const c of all) {
    if (c.closed || !c.ready) continue;
    try {
      const r = await catchUp(c.topic, c.lastId);
      if (r.kind !== 'none' && compareIds(r.id, c.lastId) > 0) {
        c.write(frameFor({ id: r.id, d: r.data, event: r.kind }, c.transport));
        c.lastId = r.id;
      }
    } catch { /* next update will fix it */ }
  }
});

// ---------- keep-alive comments (proxies close idle connections) ----------
setInterval(async () => {
  const all = [];
  for (const set of topics.values()) for (const c of set) if (c.transport === 'sse') all.push(c);
  for (let i = 0; i < all.length; i += config.fanoutBatchSize) {
    for (let j = i; j < Math.min(i + config.fanoutBatchSize, all.length); j++) if (!all[j].closed && !all[j].lagging) all[j].write(': hb\n\n');
    await yieldToEventLoop();
  }
}, 20000).unref();

export const publicStats = () => ({ topics: topics.size, lagging: lagging.size, redis: isRedisUp() });

// Debug helper for the RF-9 demo: floods a topic THROUGH THE BACKPLANE (so every instance, whichever
// the slow client is connected to, receives it). Not stored in the history stream.
export async function debugFlood(topic, count, sizeBytes) {
  const pad = 'x'.repeat(sizeBytes);
  for (let i = 0; i < count; i += 100) {
    const p = redis.pipeline();
    for (let j = i; j < Math.min(i + 100, count); j++) {
      p.publish(channels.topic(topic), JSON.stringify({ id: `${Date.now()}-${j + 1}`, d: { topic, flood: j, pad, at: Date.now() } }));
    }
    await p.exec();
    await yieldToEventLoop();
  }
}
