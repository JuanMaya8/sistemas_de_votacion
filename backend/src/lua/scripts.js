// Small Lua scripts. Each runs atomically inside Redis.
import { readFileSync } from 'node:fs';

export const applyActa = readFileSync(new URL('./applyActa.lua', import.meta.url), 'utf8');

// KEYS: 1 queue 2 lock 3 assigned 4 data 5 fencing | ARGV: 1 caseId 2 tokenBase 3 ttlMs 4 auditorId 5 nowMs 6 name
export const takeCase = `
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  if redis.call('EXISTS', KEYS[2]) == 1 then return cjson.encode({ status = 'TAKEN' }) end
  return cjson.encode({ status = 'NOT_AVAILABLE' })
end
if redis.call('EXISTS', KEYS[2]) == 1 then return cjson.encode({ status = 'TAKEN' }) end
local fence = redis.call('INCR', KEYS[5])
local token = ARGV[2] .. ':' .. fence
local score = redis.call('ZSCORE', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], token, 'PX', ARGV[3])
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HSET', KEYS[3], ARGV[1], cjson.encode({ auditorId = ARGV[4], name = ARGV[6], token = token, since = tonumber(ARGV[5]), score = score }))
local data = redis.call('HGET', KEYS[4], ARGV[1])
return cjson.encode({ status = 'OK', token = token, fence = fence, data = data })
`;

// Renew only if the caller still owns the lock. KEYS: 1 lock | ARGV: 1 token 2 ttlMs
export const renewLock = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0
`;

// Voluntary release back to the queue, verifying the owner. KEYS: 1 lock 2 assigned 3 queue 4 data | ARGV: 1 token 2 caseId
export const releaseCase = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
local info = redis.call('HGET', KEYS[2], ARGV[2])
redis.call('DEL', KEYS[1])
redis.call('HDEL', KEYS[2], ARGV[2])
if info and redis.call('HEXISTS', KEYS[4], ARGV[2]) == 1 then
  redis.call('ZADD', KEYS[3], cjson.decode(info).score, ARGV[2])
end
return 1
`;

// Reject a doubtful acta (owner only). KEYS: 1 lock 2 assigned 3 data 4 acta | ARGV: 1 token 2 caseId 3 version
export const rejectCase = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
redis.call('HDEL', KEYS[2], ARGV[2])
redis.call('HDEL', KEYS[3], ARGV[2])
if tonumber(redis.call('HGET', KEYS[4], 'pendingVersion') or '0') == tonumber(ARGV[3]) then
  redis.call('HDEL', KEYS[4], 'pendingVersion')
end
redis.call('HSET', KEYS[4], 'rejectedVersion', ARGV[3])
return 1
`;

// Sweeper: return a case whose lock expired. KEYS: 1 lock 2 assigned 3 queue 4 data | ARGV: 1 caseId
export const reclaimCase = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
local info = redis.call('HGET', KEYS[2], ARGV[1])
if not info then return 0 end
redis.call('HDEL', KEYS[2], ARGV[1])
if redis.call('HEXISTS', KEYS[4], ARGV[1]) == 1 then
  redis.call('ZADD', KEYS[3], cjson.decode(info).score, ARGV[1])
  return 1
end
return 2
`;

// Leader election with owner check. KEYS: 1 leader | ARGV: 1 instanceId 2 ttlMs
export const leaderTick = `
local cur = redis.call('GET', KEYS[1])
if cur == ARGV[1] then redis.call('PEXPIRE', KEYS[1], ARGV[2]) return 1 end
if not cur then redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2]) return 1 end
return 0
`;

// Append one public update to the topic history AND broadcast it on the backplane, atomically,
// so the id a client sees live is exactly the id it will use to resume (RF-6).
// KEYS: 1 topic stream | ARGV: 1 channel 2 maxLen 3 payloadJson
export const publishUpdate = `
local id = redis.call('XADD', KEYS[1], 'MAXLEN', '~', ARGV[2], '*', 'd', ARGV[3])
redis.call('PUBLISH', ARGV[1], '{"id":"' .. id .. '","d":' .. ARGV[3] .. '}')
return id
`;

// Fixed-window rate limit. KEYS: 1 counter | ARGV: 1 windowSec
export const rateLimit = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n
`;
