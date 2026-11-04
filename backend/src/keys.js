// Redis key space. Every key shares the "{e}" hash tag so that, if the deployment ever moves to
// Redis Cluster, all keys touched by one Lua script live in the same slot (scripts require it).
const P = '{e}';

export const keys = {
  idem: (idem) => `${P}:idem:${idem}`,
  acta: (actaId) => `${P}:acta:${actaId}`,
  total: (topic) => `${P}:tot:${topic}`, // topic: dept | mun:11 | puesto:176 | mesa:4201
  rank: (topic) => `${P}:rank:${topic}`,
  changes: `${P}:stream:changes`, // every applied acta (input of the aggregator)
  topicStream: (topic) => `${P}:stream:topic:${topic}`, // public history per topic (RF-6)
  verifyQueue: `${P}:verify:queue`, // ZSET priority queue
  verifyData: `${P}:verify:data`, // HASH caseId -> acta JSON
  verifyAssigned: `${P}:verify:assigned`, // HASH caseId -> {auditorId, token, since, score}
  lock: (caseId) => `${P}:lock:case:${caseId}`,
  fencing: `${P}:lock:fencing`,
  presence: `${P}:presence:auditors`, // ZSET auditorId -> lastSeen ms
  presenceInfo: `${P}:presence:info`, // HASH auditorId -> JSON
  rateLimit: (cred, win) => `${P}:rl:${cred}:${win}`,
  leader: `${P}:leader:aggregator`,
  aggregatorCursor: `${P}:aggregator:cursor`,
  metricsInstances: `${P}:metrics:instances`, // HASH instanceId -> JSON
  metricsCounters: `${P}:metrics:counters`, // HASH of global counters
  inpSamples: `${P}:metrics:inp`, // LIST of recent INP samples (RT-9)
};

export const channels = {
  topic: (topic) => `bp:topic:${topic}`, // backplane for public updates, one channel per topic
  verify: 'bp:verify', // verification queue events + presence
  jurados: 'bp:jurados', // verification results routed back to jurados
};
