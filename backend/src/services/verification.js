// Verification queue (RF-7) and presence (RF-8).
import crypto from 'node:crypto';
import { config } from '../config.js';
import { redis } from '../redis.js';
import { keys, channels } from '../keys.js';
import { runApply, summarizeCase, validateActa, messageFor } from './actas.js';

const publish = (msg) => redis.publish(channels.verify, JSON.stringify(msg));

export async function listQueue(limit = 200) {
  const ids = await redis.zrange(keys.verifyQueue, 0, limit - 1, 'WITHSCORES');
  const caseIds = [];
  const scores = {};
  for (let i = 0; i < ids.length; i += 2) { caseIds.push(ids[i]); scores[ids[i]] = Number(ids[i + 1]); }
  const [total, data, assignedRaw] = await Promise.all([
    redis.zcard(keys.verifyQueue),
    caseIds.length ? redis.hmget(keys.verifyData, ...caseIds) : [],
    redis.hgetall(keys.verifyAssigned),
  ]);
  const queue = caseIds.map((id, i) => (data[i] ? summarizeCase(id, JSON.parse(data[i]), scores[id]) : null)).filter(Boolean);
  const assigned = Object.entries(assignedRaw || {}).map(([caseId, s]) => {
    const a = JSON.parse(s);
    return { caseId, auditorId: a.auditorId, name: a.name, since: a.since };
  });
  return { total: Number(total), queue, assigned };
}

export async function takeCase(caseId, auditor) {
  const tokenBase = `${auditor.auditorId}:${crypto.randomUUID()}`;
  const r = JSON.parse(await redis.takeCase(
    keys.verifyQueue, keys.lock(caseId), keys.verifyAssigned, keys.verifyData, keys.fencing,
    caseId, tokenBase, config.lockTtlMs, auditor.auditorId, Date.now(), auditor.name,
  ));
  if (r.status !== 'OK') {
    return { ok: false, code: r.status, message: r.status === 'TAKEN' ? 'Otro auditor ya tomó este caso.' : 'El caso ya no está disponible.' };
  }
  await publish({ type: 'queue_event', event: 'taken', caseId, auditorId: auditor.auditorId, name: auditor.name, at: Date.now() });
  const data = r.data ? JSON.parse(r.data) : null;
  return { ok: true, caseId, token: r.token, fence: r.fence, lockTtlMs: config.lockTtlMs, case: data && summarizeCase(caseId, data) };
}

export async function renewCase(caseId, token) {
  return (await redis.renewLock(keys.lock(caseId), token, config.lockTtlMs)) === 1;
}

export async function releaseCase(caseId, token, auditor) {
  const ok = (await redis.releaseCase(keys.lock(caseId), keys.verifyAssigned, keys.verifyQueue, keys.verifyData, token, caseId)) === 1;
  if (ok) await publish({ type: 'queue_event', event: 'released', caseId, auditorId: auditor.auditorId, name: auditor.name, at: Date.now() });
  return ok;
}

export async function resolveCase({ caseId, token, decision, votos, sufragantes, note }, auditor) {
  const raw = await redis.hget(keys.verifyData, caseId);
  if (!raw) return { ok: false, code: 'NOT_AVAILABLE', message: 'El caso ya no existe (fue resuelto o reemplazado por una versión más reciente).' };
  const acta = JSON.parse(raw);

  if (decision === 'reject') {
    const ok = (await redis.rejectCase(keys.lock(caseId), keys.verifyAssigned, keys.verifyData, keys.acta(acta.acta), token, caseId, acta.version)) === 1;
    if (!ok) return { ok: false, code: 'LOCK_LOST', message: messageFor({ status: 'LOCK_LOST' }) };
    await afterResolve(caseId, acta, auditor, 'rejected', note);
    return { ok: true, status: 'VERIFIED_REJECTED', message: `Acta ${acta.acta} rechazada. No suma al preconteo.` };
  }

  if (decision !== 'approve') return { ok: false, code: 'BAD_DECISION', message: 'Decisión inválida.' };
  const corrected = { ...acta, votos: votos || acta.votos, sufragantes: sufragantes ?? acta.sufragantes, idem: `verify-${caseId}`.slice(0, 64) };
  const v = validateActa(corrected);
  if (v.errors.length) return { ok: false, code: 'INVALID', message: v.errors.join('; ') };
  if (v.doubtful) return { ok: false, code: 'STILL_INCONSISTENT', message: `Los valores aún no cuadran: votos (${v.sum}) ≠ sufragantes (${corrected.sufragantes}).` };

  const r = await runApply(corrected, v.votes, { doubtful: false, source: 'verification', lockToken: token, caseId });
  if (r.status === 'LOCK_LOST') return { ok: false, code: 'LOCK_LOST', message: messageFor(r) };
  if (r.status === 'REGISTERED' || r.status === 'CORRECTION_APPLIED') await redis.hincrby(keys.metricsCounters, 'actasApplied', 1);
  await afterResolve(caseId, acta, auditor, 'approved', note, r.status);
  return { ok: true, status: 'VERIFIED_APPROVED', applyStatus: r.status, message: `Acta ${acta.acta} aprobada. ${messageFor(r)}` };
}

async function afterResolve(caseId, acta, auditor, decision, note, applyStatus) {
  await publish({ type: 'queue_event', event: 'resolved', caseId, decision, auditorId: auditor.auditorId, name: auditor.name, at: Date.now() });
  const message = decision === 'approved'
    ? `Su acta ${acta.acta} (versión ${acta.version}) fue verificada y APROBADA por un auditor.`
    : `Su acta ${acta.acta} (versión ${acta.version}) fue verificada y RECHAZADA.${note ? ' Motivo: ' + note : ''} Envíe una versión corregida.`;
  await redis.publish(channels.jurados, JSON.stringify({
    jurado: acta.jurado, acta: acta.acta, version: acta.version, idem: acta.idem,
    status: decision === 'approved' ? 'VERIFIED_APPROVED' : 'VERIFIED_REJECTED', applyStatus, message,
  }));
}

// ----- sweepers (run by the leader) -----
export async function sweepLocks() {
  const assigned = await redis.hgetall(keys.verifyAssigned);
  for (const [caseId, s] of Object.entries(assigned || {})) {
    const r = await redis.reclaimCase(keys.lock(caseId), keys.verifyAssigned, keys.verifyQueue, keys.verifyData, caseId);
    if (r === 1) {
      const a = JSON.parse(s);
      await publish({ type: 'queue_event', event: 'reclaimed', caseId, auditorId: a.auditorId, name: a.name, at: Date.now(),
        message: `El caso ${caseId} volvió a la cola: el bloqueo de ${a.name || a.auditorId} expiró.` });
    }
  }
}

export async function presenceHeartbeat(info) {
  const now = Date.now();
  await redis.pipeline()
    .zadd(keys.presence, now, info.auditorId)
    .hset(keys.presenceInfo, info.auditorId, JSON.stringify({ ...info, lastSeen: now }))
    .exec();
}

export async function presenceLeave(auditorId) {
  await redis.pipeline().zrem(keys.presence, auditorId).hdel(keys.presenceInfo, auditorId).exec();
}

export async function listPresence() {
  const now = Date.now();
  const ids = await redis.zrangebyscore(keys.presence, now - config.presenceTtlMs, '+inf');
  if (!ids.length) return [];
  const infos = await redis.hmget(keys.presenceInfo, ...ids);
  return infos.filter(Boolean).map((s) => {
    const i = JSON.parse(s);
    return { ...i, workingMs: i.caseSince ? now - i.caseSince : 0, connectedMs: now - (i.connectedAt || now) };
  });
}

export async function sweepPresence() {
  const cutoff = Date.now() - config.presenceTtlMs;
  const ghosts = await redis.zrangebyscore(keys.presence, '-inf', cutoff);
  if (!ghosts.length) return;
  await redis.pipeline().zremrangebyscore(keys.presence, '-inf', cutoff).hdel(keys.presenceInfo, ...ghosts).exec();
  await publish({ type: 'presence_event', event: 'expired', auditors: ghosts });
}
