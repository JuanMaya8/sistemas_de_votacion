// Per-instance instrumentation (RT-4, RT-7). Every instance pushes its numbers to a Redis hash, so
// any instance can serve the cluster-wide dashboard without talking to the others (RT-3).
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { config } from '../config.js';
import { redis, isRedisUp } from '../redis.js';
import { keys } from '../keys.js';

// The histogram records the full timer interval, so the configured resolution is subtracted to get
// the real delay (time the loop was blocked).
const RESOLUTION_MS = 10;
const loop = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
const delayMs = (ns) => +Math.max(0, ns / 1e6 - RESOLUTION_MS).toFixed(2);
loop.enable();

const baselineRss = process.memoryUsage().rss;

export const connections = { public: 0, publicByTransport: { sse: 0, ws: 0 }, jurado: 0, verification: 0 };

const counters = {
  sent: 0, // messages actually written to sockets
  newConnections: 0,
  actasReceived: 0,
  rejectedConnections: 0,
  slowSnapshots: 0,
  slowDisconnects: 0,
};
let laggingClients = 0;
const actaTimestamps = [];
let latencySum = 0, latencyCount = 0, latencyMax = 0;

let last = { at: Date.now(), sent: 0, newConnections: 0 };
let current = {};
let pendingSentForRedis = 0;

export const metrics = {
  addSent(n) { counters.sent += n; pendingSentForRedis += n; },
  newConnection() { counters.newConnections++; },
  rejectedConnection() { counters.rejectedConnections++; },
  actaReceived() { counters.actasReceived++; actaTimestamps.push(Date.now()); },
  slowSnapshot() { counters.slowSnapshots++; },
  slowDisconnect() { counters.slowDisconnects++; },
  setLagging(n) { laggingClients = n; },
  publishLatency(ms) { if (ms < 0) return; latencySum += ms; latencyCount++; if (ms > latencyMax) latencyMax = ms; },
  snapshot: () => current,
};

function compute() {
  const now = Date.now();
  const secs = (now - last.at) / 1000 || 1;
  while (actaTimestamps.length && actaTimestamps[0] < now - 60000) actaTimestamps.shift();
  const mem = process.memoryUsage();
  const totalConns = connections.public + connections.jurado + connections.verification;
  current = {
    instanceId: config.instanceId,
    at: now,
    uptimeSec: Math.round(process.uptime()),
    redis: isRedisUp() ? 'up' : 'down',
    connections: { ...connections, publicByTransport: { ...connections.publicByTransport }, total: totalConns },
    newConnectionsPerSec: +((counters.newConnections - last.newConnections) / secs).toFixed(1),
    messagesPerSec: +((counters.sent - last.sent) / secs).toFixed(1),
    eventLoopDelayMs: {
      p50: delayMs(loop.percentile(50)),
      p99: delayMs(loop.percentile(99)),
      max: delayMs(loop.max),
    },
    memory: {
      rssMB: +(mem.rss / 1048576).toFixed(1),
      heapUsedMB: +(mem.heapUsed / 1048576).toFixed(1),
      perConnectionKB: totalConns ? +(Math.max(0, mem.rss - baselineRss) / 1024 / totalConns).toFixed(2) : 0,
    },
    actasPerMin: actaTimestamps.length,
    publishLatencyMs: { avg: latencyCount ? Math.round(latencySum / latencyCount) : 0, max: latencyMax },
    totals: { ...counters },
    laggingClients,
  };
  last = { at: now, sent: counters.sent, newConnections: counters.newConnections };
  loop.reset();
  latencySum = 0; latencyCount = 0; latencyMax = 0;
}

export function startMetrics() {
  compute();
  setInterval(async () => {
    compute();
    if (!isRedisUp()) return;
    try {
      const p = redis.pipeline();
      p.hset(keys.metricsInstances, config.instanceId, JSON.stringify(current));
      if (pendingSentForRedis) p.hincrby(keys.metricsCounters, 'sent', pendingSentForRedis);
      await p.exec();
      pendingSentForRedis = 0;
    } catch { /* metrics are best effort */ }
  }, config.metricsPushMs).unref();
}

export async function clusterMetrics() {
  const [all, counters, inp] = await Promise.all([
    redis.hgetall(keys.metricsInstances),
    redis.hgetall(keys.metricsCounters),
    redis.lrange(keys.inpSamples, 0, 499),
  ]);
  const now = Date.now();
  const instances = Object.values(all || {})
    .map((s) => JSON.parse(s))
    .filter((m) => now - m.at < 10000) // an instance that stops reporting disappears on its own
    .sort((a, b) => a.instanceId.localeCompare(b.instanceId, undefined, { numeric: true }));
  const inpValues = (inp || []).map(Number).sort((a, b) => a - b);
  const p75 = inpValues.length ? inpValues[Math.floor(inpValues.length * 0.75)] : null;
  const sum = (f) => instances.reduce((acc, m) => acc + f(m), 0);
  return {
    at: now,
    instances,
    cluster: {
      instances: instances.length,
      publicConnections: sum((m) => m.connections.public),
      totalConnections: sum((m) => m.connections.total),
      messagesPerSec: +sum((m) => m.messagesPerSec).toFixed(1),
      actasPerMin: sum((m) => m.actasPerMin),
      maxEventLoopP99Ms: Math.max(0, ...instances.map((m) => m.eventLoopDelayMs.p99)),
      sentTotal: Number(counters?.sent || 0),
      naiveTotal: Number(counters?.naive || 0),
      actasApplied: Number(counters?.actasApplied || 0),
      topicMessages: Number(counters?.topicMessages || 0),
      windows: Number(counters?.windows || 0),
      inpP75Ms: p75,
      inpSamples: inpValues.length,
    },
  };
}

export async function recordInp(value) {
  const v = Math.round(Number(value));
  if (!Number.isFinite(v) || v < 0 || v > 60000) return;
  await redis.pipeline().lpush(keys.inpSamples, v).ltrim(keys.inpSamples, 0, 999).exec();
}
