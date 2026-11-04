// Acta reception (RF-1, RF-2, RF-3): validation, rate limit and the atomic Lua application.
import { config } from '../config.js';
import { redis, safe, RedisUnavailableError } from '../redis.js';
import { keys, channels } from '../keys.js';
import { puestoOfMesa, municipioOfPuesto, TOTAL_MESAS, VOTE_FIELDS } from '../catalog.js';
import { metrics } from '../metrics/metrics.js';

// Statuses after which the jurado app can drop the acta from its local outbox.
export const FINAL_STATUSES = new Set([
  'REGISTERED', 'CORRECTION_APPLIED', 'ALREADY_APPLIED', 'STALE_VERSION', 'IN_REVIEW', 'ALREADY_IN_REVIEW', 'REJECTED',
]);

export function messageFor(r) {
  const prefix = r.duplicate ? 'Reenvío detectado (no se sumó de nuevo). ' : '';
  switch (r.status) {
    case 'REGISTERED': return `${prefix}Acta ${r.acta} registrada correctamente (versión ${r.version}).`;
    case 'CORRECTION_APPLIED': return `${prefix}Corrección aplicada al acta ${r.acta}: se revirtió la versión ${r.previousVersion} y se aplicó la versión ${r.version}.`;
    case 'ALREADY_APPLIED': return `${prefix}La versión ${r.version} del acta ${r.acta} ya estaba registrada. No se sumó de nuevo.`;
    case 'STALE_VERSION': return `${prefix}El acta ${r.acta} ya tiene una versión más reciente (${r.currentVersion}). La versión ${r.version} no se aplicó.`;
    case 'IN_REVIEW': return `${prefix}El acta ${r.acta} no cuadra (votos ≠ sufragantes). Quedó registrada y pasó a verificación humana.`;
    case 'ALREADY_IN_REVIEW': return `${prefix}El acta ${r.acta} ya está en verificación humana.`;
    case 'RATE_LIMITED': return `Demasiados envíos en poco tiempo. Se reintentará en ${Math.ceil(r.retryAfterMs / 1000)} s.`;
    case 'UNAVAILABLE': return 'El sistema no pudo registrar el acta en este momento. NO quedó registrada; su dispositivo la reenviará automáticamente.';
    case 'REJECTED': return `Acta rechazada: ${r.errors.join('; ')}`;
    case 'LOCK_LOST': return 'Su bloqueo sobre este caso expiró y el caso fue reasignado. Su decisión no se aplicó.';
    default: return r.status;
  }
}

const isInt = (v) => Number.isInteger(v) && v >= 0;

export function validateActa(a) {
  const errors = [];
  if (!a || typeof a !== 'object') return { errors: ['mensaje vacío o inválido'] };
  if (typeof a.acta !== 'string' || !/^E14-\d{1,4}-\d{1,5}-\d{2}$/.test(a.acta)) errors.push('identificador de acta inválido (formato E14-puesto-mesa-corporación)');
  if (!Number.isInteger(a.mesa) || a.mesa < 1 || a.mesa > TOTAL_MESAS) errors.push('mesa inexistente');
  else {
    if (a.puesto !== puestoOfMesa(a.mesa)) errors.push(`la mesa ${a.mesa} no pertenece al puesto ${a.puesto}`);
    else if (a.municipio !== municipioOfPuesto(a.puesto)) errors.push(`el puesto ${a.puesto} no pertenece al municipio ${a.municipio}`);
  }
  if (!Number.isInteger(a.version) || a.version < 1) errors.push('versión inválida');
  if (typeof a.jurado !== 'string' || !a.jurado) errors.push('jurado requerido');
  if (typeof a.idem !== 'string' || a.idem.length < 8 || a.idem.length > 64) errors.push('clave de idempotencia inválida');
  if (!isInt(a.sufragantes)) errors.push('sufragantes inválido');
  const votes = {};
  if (!a.votos || typeof a.votos !== 'object') errors.push('votos requeridos');
  else {
    for (const [k, v] of Object.entries(a.votos)) {
      if (!VOTE_FIELDS.includes(k)) errors.push(`campo de votos desconocido: ${k}`);
      else if (!isInt(v)) errors.push(`valor inválido para ${k}`);
    }
    for (const f of VOTE_FIELDS) votes[f] = isInt(a.votos[f]) ? a.votos[f] : 0;
  }
  if (errors.length) return { errors };
  const sum = Object.values(votes).reduce((s, v) => s + v, 0);
  const discrepancy = Math.abs(sum - a.sufragantes);
  return { errors: [], votes, doubtful: discrepancy !== 0, discrepancy, sum };
}

async function checkRateLimit(cred) {
  const win = Math.floor(Date.now() / 1000 / config.rateLimitWindowSec);
  const n = await redis.rateLimit(keys.rateLimit(cred, win), config.rateLimitWindowSec);
  if (n > config.rateLimitMax) {
    const retryAfterMs = (win + 1) * config.rateLimitWindowSec * 1000 - Date.now();
    return { status: 'RATE_LIMITED', retryAfterMs };
  }
  return null;
}

function applyKeys(a, caseId) {
  return [
    keys.idem(a.idem), keys.acta(a.acta),
    keys.total(`mesa:${a.mesa}`), keys.total(`puesto:${a.puesto}`), keys.total(`mun:${a.municipio}`), keys.total('dept'),
    keys.rank(`puesto:${a.puesto}`), keys.rank(`mun:${a.municipio}`), keys.rank('dept'),
    keys.changes, keys.verifyQueue, keys.verifyData, keys.lock(caseId || 'none'), keys.verifyAssigned,
  ];
}

export async function runApply(a, votes, { doubtful, discrepancy = 0, source, lockToken = '', caseId = '' }) {
  const now = Date.now();
  const priority = -discrepancy * 1e10 + Math.floor(now / 1000); // bigger discrepancy first, then oldest
  const payload = JSON.stringify({ ...a, votos: votes, receivedAt: now, discrepancy });
  const raw = await redis.applyActa(
    ...applyKeys(a, caseId),
    a.idem, a.version, JSON.stringify(votes), a.sufragantes, payload, now, config.idemTtlSec,
    doubtful ? 1 : 0, priority, a.acta, a.mesa, a.puesto, a.municipio, config.changesStreamMaxLen,
    source, lockToken, caseId,
  );
  return JSON.parse(raw);
}

/** Receives one acta from a jurado (WebSocket or HTTP). Always returns an unambiguous answer. */
export async function submitActa(a) {
  metrics.actaReceived();
  const v = validateActa(a);
  if (v.errors.length) {
    const r = { status: 'REJECTED', acta: a?.acta, idem: a?.idem, errors: v.errors };
    return { ...r, final: true, message: messageFor(r) };
  }
  try {
    return await safe(async () => {
      const limited = await checkRateLimit(`jurado:${a.jurado}`);
      if (limited) return { ...limited, acta: a.acta, idem: a.idem, final: false, message: messageFor(limited) };

      const r = await runApply(a, v.votes, { doubtful: v.doubtful, discrepancy: v.discrepancy, source: 'jurado' });
      await afterApply(r, a, v);
      return { ...r, final: FINAL_STATUSES.has(r.status), message: messageFor(r) };
    });
  } catch (err) {
    if (!(err instanceof RedisUnavailableError)) console.error('[actas] error inesperado', err);
    const r = { status: 'UNAVAILABLE', acta: a.acta, idem: a.idem };
    return { ...r, final: false, message: messageFor(r) };
  }
}

async function afterApply(r, a, v) {
  if (r.duplicate) return;
  const p = redis.pipeline();
  if (r.status === 'REGISTERED' || r.status === 'CORRECTION_APPLIED') p.hincrby(keys.metricsCounters, 'actasApplied', 1);
  if (r.status === 'IN_REVIEW') {
    p.publish(channels.verify, JSON.stringify({
      type: 'queue_event', event: 'added', caseId: r.caseId,
      case: summarizeCase(r.caseId, { ...a, votos: v.votes, discrepancy: v.discrepancy, receivedAt: r.at }),
    }));
  }
  if (r.supersededCase) {
    p.publish(channels.verify, JSON.stringify({ type: 'queue_event', event: 'superseded', caseId: r.supersededCase, message: `El caso ${r.supersededCase} fue reemplazado por una versión más reciente del acta.` }));
  }
  await p.exec();
}

export function summarizeCase(caseId, data, score) {
  return {
    caseId,
    acta: data.acta, version: data.version, mesa: data.mesa, puesto: data.puesto, municipio: data.municipio,
    jurado: data.jurado, votos: data.votos, sufragantes: data.sufragantes, discrepancy: data.discrepancy,
    hash_foto: data.hash_foto, receivedAt: data.receivedAt, score,
  };
}

export async function getActaStatus(actaId) {
  const h = await redis.hgetall(keys.acta(actaId));
  if (!h || !Object.keys(h).length) return null;
  return {
    acta: actaId,
    appliedVersion: Number(h.version || 0),
    pendingVersion: Number(h.pendingVersion || 0),
    rejectedVersion: Number(h.rejectedVersion || 0),
    votos: h.votes ? JSON.parse(h.votes) : null,
    sufragantes: Number(h.voters || 0),
  };
}
