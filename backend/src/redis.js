// Redis connections. Two clients: one for commands, one dedicated to Pub/Sub (a subscribed
// connection cannot run normal commands).
import Redis from 'ioredis';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import * as scripts from './lua/scripts.js';

const commandOptions = {
  // Fail fast instead of queueing commands while Redis is down: a jurado must NEVER receive a
  // "registered" answer for something that did not reach Redis (RF-10).
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  retryStrategy: (times) => Math.min(times * 200, 3000),
  connectTimeout: 5000,
};

export const redis = new Redis(config.redisUrl, commandOptions);
export const sub = new Redis(config.redisUrl, { ...commandOptions, enableOfflineQueue: true, maxRetriesPerRequest: null });

redis.defineCommand('applyActa', { numberOfKeys: 14, lua: scripts.applyActa });
redis.defineCommand('takeCase', { numberOfKeys: 5, lua: scripts.takeCase });
redis.defineCommand('renewLock', { numberOfKeys: 1, lua: scripts.renewLock });
redis.defineCommand('releaseCase', { numberOfKeys: 4, lua: scripts.releaseCase });
redis.defineCommand('rejectCase', { numberOfKeys: 4, lua: scripts.rejectCase });
redis.defineCommand('reclaimCase', { numberOfKeys: 4, lua: scripts.reclaimCase });
redis.defineCommand('leaderTick', { numberOfKeys: 1, lua: scripts.leaderTick });
redis.defineCommand('publishUpdate', { numberOfKeys: 1, lua: scripts.publishUpdate });
redis.defineCommand('rateLimit', { numberOfKeys: 1, lua: scripts.rateLimit });

// Health tracking shared by the whole process.
export const redisHealth = new EventEmitter();
let up = false;
const setUp = (value) => {
  if (value === up) return;
  up = value;
  console.log(`[redis] ${up ? 'disponible' : 'NO disponible'}`);
  redisHealth.emit(up ? 'up' : 'down');
};
redis.on('ready', () => setUp(true));
redis.on('close', () => setUp(false));
redis.on('end', () => setUp(false));
redis.on('error', (err) => { if (up) console.error('[redis] error:', err.message); });
sub.on('error', () => {});
sub.on('ready', () => { if (up) redisHealth.emit('sub-ready'); });

export const isRedisUp = () => up && redis.status === 'ready';

export class RedisUnavailableError extends Error {
  constructor() { super('Redis no disponible'); this.code = 'REDIS_DOWN'; }
}

// Converts any Redis failure into a typed error the callers can map to a clear user message.
export async function safe(fn) {
  if (!isRedisUp()) throw new RedisUnavailableError();
  try { return await fn(); } catch (err) {
    if (!isRedisUp() || /writeable|Connection|ECONN|closed|timeout/i.test(err.message)) throw new RedisUnavailableError();
    throw err;
  }
}
