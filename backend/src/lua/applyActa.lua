-- applyActa: registers an acta and updates the four aggregation levels as ONE indivisible operation.
-- Redis runs a script without interleaving any other command, so no reader can ever observe the
-- municipio total including an acta whose puesto detail is not there yet (RF-3).
--
-- KEYS: 1 idem | 2 acta | 3 tot:mesa | 4 tot:puesto | 5 tot:mun | 6 tot:dept
--       7 rank:puesto | 8 rank:mun | 9 rank:dept | 10 changes stream | 11 verify queue
--       12 verify data | 13 lock key (verification only) | 14 verify assigned
-- ARGV: 1 idem | 2 version | 3 votesJson | 4 voters | 5 payloadJson | 6 nowMs | 7 idemTtlSec
--       8 doubtful(0/1) | 9 priorityScore | 10 actaId | 11 mesa | 12 puesto | 13 mun
--       14 changesMaxLen | 15 source | 16 lockToken ('' = not a verification) | 17 caseId

-- 1) Idempotency: the same submission (same idem key) always gets the SAME answer back.
local existing = redis.call('GET', KEYS[1])
if existing then
  local r = cjson.decode(existing)
  r.duplicate = true
  return cjson.encode(r)
end

-- 2) Verification path: only the current owner of the lock may resolve the case (fencing).
local verifying = ARGV[16] ~= ''
if verifying then
  local owner = redis.call('GET', KEYS[13])
  if owner ~= ARGV[16] then
    return cjson.encode({ status = 'LOCK_LOST', acta = ARGV[10], caseId = ARGV[17] })
  end
end

local version = tonumber(ARGV[2])
local current = tonumber(redis.call('HGET', KEYS[2], 'version') or '0')
local pending = tonumber(redis.call('HGET', KEYS[2], 'pendingVersion') or '0')
local result

if version <= current then
  -- Late or repeated version: never move the state backwards (RF-2).
  if version == current then
    result = { status = 'ALREADY_APPLIED', version = version, currentVersion = current }
  else
    result = { status = 'STALE_VERSION', version = version, currentVersion = current }
  end

elseif ARGV[8] == '1' then
  -- Doubtful acta: goes to human verification, does NOT touch the totals.
  if version <= pending then
    result = { status = 'ALREADY_IN_REVIEW', version = version, pendingVersion = pending }
  else
    local superseded = nil
    if pending > 0 then
      superseded = ARGV[10] .. '#' .. pending
      redis.call('ZREM', KEYS[11], superseded)
      redis.call('HDEL', KEYS[12], superseded)
    end
    local caseId = ARGV[10] .. '#' .. version
    redis.call('ZADD', KEYS[11], ARGV[9], caseId)
    redis.call('HSET', KEYS[12], caseId, ARGV[5])
    redis.call('HSET', KEYS[2], 'pendingVersion', version, 'mesa', ARGV[11], 'puesto', ARGV[12], 'mun', ARGV[13])
    result = { status = 'IN_REVIEW', version = version, caseId = caseId, supersededCase = superseded }
  end

else
  -- Valid acta (or approved by an auditor): revert the previous version and apply the new one.
  local newVotes = cjson.decode(ARGV[3])
  local oldJson = redis.call('HGET', KEYS[2], 'votes')
  local oldVotes = {}
  if oldJson then oldVotes = cjson.decode(oldJson) end
  local diff = {}
  for k, v in pairs(newVotes) do diff[k] = v - (oldVotes[k] or 0) end
  for k, v in pairs(oldVotes) do if newVotes[k] == nil then diff[k] = -v end end

  local newVoters = tonumber(ARGV[4])
  local oldVoters = tonumber(redis.call('HGET', KEYS[2], 'voters') or '0')
  local isNew = current == 0

  for lvl = 3, 6 do
    for k, d in pairs(diff) do
      if d ~= 0 then redis.call('HINCRBY', KEYS[lvl], k, d) end
    end
    if newVoters ~= oldVoters then redis.call('HINCRBY', KEYS[lvl], '_voters', newVoters - oldVoters) end
    if isNew then redis.call('HINCRBY', KEYS[lvl], '_reported', 1) end
  end
  -- Sorted sets give the candidate ranking without scanning anything (ZREVRANGE).
  for lvl = 7, 9 do
    for k, d in pairs(diff) do
      if d ~= 0 then redis.call('ZINCRBY', KEYS[lvl], d, k) end
    end
  end

  if pending > 0 and pending <= version then
    local stale = ARGV[10] .. '#' .. pending
    redis.call('ZREM', KEYS[11], stale)
    redis.call('HDEL', KEYS[12], stale)
    redis.call('HDEL', KEYS[2], 'pendingVersion')
    if not verifying then result = { supersededCase = stale } end
  end

  redis.call('HSET', KEYS[2], 'version', version, 'votes', ARGV[3], 'voters', newVoters,
    'appliedAt', ARGV[6], 'mesa', ARGV[11], 'puesto', ARGV[12], 'mun', ARGV[13])

  local changeId = redis.call('XADD', KEYS[10], 'MAXLEN', '~', ARGV[14], '*',
    'acta', ARGV[10], 'mesa', ARGV[11], 'puesto', ARGV[12], 'mun', ARGV[13],
    'version', version, 'prevVersion', current, 'diff', cjson.encode(diff),
    'voters', newVoters - oldVoters, 'isNew', isNew and 1 or 0,
    'receivedAt', ARGV[6], 'source', ARGV[15])

  local status = 'REGISTERED'
  if current > 0 then status = 'CORRECTION_APPLIED' end
  local superseded = result and result.supersededCase or nil
  result = { status = status, version = version, previousVersion = current, changeId = changeId, supersededCase = superseded }
end

-- 3) Verification bookkeeping: the case is closed and its lock released in the same atomic step.
if verifying then
  redis.call('DEL', KEYS[13])
  redis.call('HDEL', KEYS[14], ARGV[17])
  redis.call('HDEL', KEYS[12], ARGV[17])
  local p = tonumber(redis.call('HGET', KEYS[2], 'pendingVersion') or '0')
  if p == version then redis.call('HDEL', KEYS[2], 'pendingVersion') end
  result.caseId = ARGV[17]
end

result.acta = ARGV[10]
result.idem = ARGV[1]
result.at = tonumber(ARGV[6])
local encoded = cjson.encode(result)
-- The answer is stored together with the effect: if the server dies before replying, the retry
-- receives exactly this answer (RF-1).
redis.call('SET', KEYS[1], encoded, 'EX', ARGV[7])
return encoded
