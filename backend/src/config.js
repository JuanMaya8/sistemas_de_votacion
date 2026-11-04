// Central configuration. Every value can be overridden with an environment variable.
import os from 'node:os';
import crypto from 'node:crypto';

const num = (name, def) => (process.env[name] !== undefined ? Number(process.env[name]) : def);

export const config = {
  port: num('PORT', 3000),
  instanceId: process.env.INSTANCE_ID || `${os.hostname()}-${crypto.randomBytes(2).toString('hex')}`,
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  corsOrigin: process.env.CORS_ORIGIN || '*',

  // Aggregation window for the public fan-out (RF-4): one message per topic per window.
  windowMs: num('WINDOW_MS', 2000),
  // Fan-out batching (RF-4 / RT-4).
  fanoutBatchSize: num('FANOUT_BATCH_SIZE', 500),

  // History kept per topic in Redis Streams (RF-6).
  historyMaxLen: num('HISTORY_MAXLEN', 600), // ~20 min at 1 entry / 2 s
  replayMaxEntries: num('REPLAY_MAX_ENTRIES', 300), // beyond this a snapshot is cheaper
  changesStreamMaxLen: num('CHANGES_MAXLEN', 50000),

  // Idempotency (RF-1).
  idemTtlSec: num('IDEM_TTL_SEC', 48 * 3600),

  // Distributed lock for verification cases (RF-7).
  lockTtlMs: num('LOCK_TTL_MS', 30000),
  auditorIdleLimitMs: num('AUDITOR_IDLE_LIMIT_MS', 5 * 60 * 1000),

  // Presence (RF-8).
  presenceTtlMs: num('PRESENCE_TTL_MS', 25000),

  // Rate limit per credential (Redis counter per window).
  rateLimitWindowSec: num('RATE_LIMIT_WINDOW_SEC', 10),
  rateLimitMax: num('RATE_LIMIT_MAX', 30),

  // Backpressure for slow clients (RF-9).
  slowSoftBytes: num('SLOW_SOFT_BYTES', 64 * 1024),
  slowHardBytes: num('SLOW_HARD_BYTES', 512 * 1024),
  slowMaxLagMs: num('SLOW_MAX_LAG_MS', 30000),

  // Admission control against reconnection avalanches (RF-10).
  maxNewConnPerSec: num('MAX_NEW_CONN_PER_SEC', 400),

  // Leader election (aggregator + sweepers).
  leaderTtlMs: num('LEADER_TTL_MS', 6000),

  metricsPushMs: num('METRICS_PUSH_MS', 2000),
  debugEndpoints: process.env.DEBUG_ENDPOINTS === '1',
};
