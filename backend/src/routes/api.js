// HTTP routes (plain node:http, no framework needed).
import { config } from '../config.js';
import { redis, safe, isRedisUp } from '../redis.js';
import { keys } from '../keys.js';
import { catalogSummary, puestosOfMunicipio, isValidTopic } from '../catalog.js';
import { submitActa, getActaStatus } from '../services/actas.js';
import { listQueue, listPresence } from '../services/verification.js';
import { leaderStatus } from '../services/aggregator.js';
import { metrics, clusterMetrics, recordInp } from '../metrics/metrics.js';
import { handleSse, sendJson } from '../realtime/sse.js';
import { getSnapshot, publicStats, debugFlood } from '../realtime/publicHub.js';

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const unavailable = (res) => sendJson(res, 503, { error: 'UNAVAILABLE', message: 'Servidor central no disponible. Intente de nuevo en unos segundos.' }, { 'Retry-After': '3' });

export async function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', config.corsOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Last-Event-ID');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'X-Instance-Id, Retry-After');
  res.setHeader('X-Instance-Id', config.instanceId);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const route = `${req.method} ${path}`;

  try {
    switch (route) {
      case 'GET /':
      case 'GET /api':
        return sendJson(res, 200, { service: 'Preconteo electoral - API', instanceId: config.instanceId, docs: '/api/instance, /api/catalog, /api/public/stream?topic=dept' });

      case 'GET /health/live':
        // Liveness for the load balancer: the instance answers even when Redis is down, so jurados
        // get an explicit UNAVAILABLE instead of a proxy error.
        return sendJson(res, 200, { status: 'alive', instanceId: config.instanceId });

      case 'GET /health': {
        const ok = isRedisUp();
        return sendJson(res, ok ? 200 : 503, { status: ok ? 'ok' : 'degraded', instanceId: config.instanceId, redis: ok ? 'up' : 'down' });
      }

      case 'GET /api/instance':
        return sendJson(res, 200, { instanceId: config.instanceId, ...leaderStatus(), ...publicStats(), pid: process.pid });

      case 'GET /api/catalog':
        return sendJson(res, 200, catalogSummary(), { 'Cache-Control': 'public, max-age=3600' });

      case 'POST /api/actas': {
        let body;
        try { body = await readBody(req); } catch { return sendJson(res, 400, { status: 'REJECTED', message: 'JSON inválido' }); }
        const r = await submitActa(body);
        const http = r.status === 'REJECTED' ? 422 : r.status === 'RATE_LIMITED' ? 429 : r.status === 'UNAVAILABLE' ? 503 : 200;
        const headers = r.retryAfterMs ? { 'Retry-After': String(Math.ceil(r.retryAfterMs / 1000)) } : {};
        return sendJson(res, http, { instanceId: config.instanceId, ...r }, headers);
      }

      case 'GET /api/public/stream':
        return handleSse(req, res, url);

      case 'GET /api/public/snapshot': {
        // Polling endpoint (used for the transport comparison and as a last-resort fallback).
        const topic = url.searchParams.get('topic') || 'dept';
        if (!isValidTopic(topic)) return sendJson(res, 400, { error: 'TOPIC_INVALID', message: 'Tópico inválido.' });
        const snap = await safe(() => getSnapshot(topic));
        metrics.addSent(1);
        return sendJson(res, 200, { id: snap.id, ...snap.data }, { 'Cache-Control': 'public, max-age=1' });
      }

      case 'GET /api/public/ranking': {
        const topic = url.searchParams.get('topic') || 'dept';
        if (!isValidTopic(topic)) return sendJson(res, 400, { error: 'TOPIC_INVALID', message: 'Tópico inválido.' });
        const raw = await safe(() => redis.zrevrange(keys.rank(topic), 0, -1, 'WITHSCORES'));
        const ranking = [];
        for (let i = 0; i < raw.length; i += 2) ranking.push({ field: raw[i], votes: Number(raw[i + 1]) });
        return sendJson(res, 200, { topic, ranking });
      }

      case 'GET /api/metrics':
        return sendJson(res, 200, metrics.snapshot());

      case 'GET /api/metrics/cluster':
        return sendJson(res, 200, await safe(() => clusterMetrics()));

      case 'POST /api/metrics/inp': {
        const body = await readBody(req, 4096).catch(() => ({}));
        await safe(() => recordInp(body.value)).catch(() => {});
        res.writeHead(204); return res.end();
      }

      case 'GET /api/verification/queue':
        return sendJson(res, 200, await safe(() => listQueue()));

      case 'GET /api/verification/presence':
        return sendJson(res, 200, { auditors: await safe(() => listPresence()) });

      case 'POST /api/debug/flood': {
        if (!config.debugEndpoints) break;
        const body = await readBody(req).catch(() => ({}));
        debugFlood(body.topic || 'dept', Math.min(Number(body.count) || 200, 5000), Math.min(Number(body.size) || 8192, 65536));
        return sendJson(res, 202, { ok: true, message: 'Inundación de prueba iniciada en esta instancia.' });
      }
      default: break;
    }

    if (req.method === 'GET' && path.startsWith('/api/catalog/municipios/') && path.endsWith('/puestos')) {
      const id = Number(path.split('/')[4]);
      return sendJson(res, 200, { municipio: id, puestos: puestosOfMunicipio(id) }, { 'Cache-Control': 'public, max-age=3600' });
    }
    if (req.method === 'GET' && path.startsWith('/api/actas/')) {
      const status = await safe(() => getActaStatus(decodeURIComponent(path.slice('/api/actas/'.length))));
      return status ? sendJson(res, 200, status) : sendJson(res, 404, { error: 'NOT_FOUND', message: 'Acta no encontrada.' });
    }
    return sendJson(res, 404, { error: 'NOT_FOUND', message: 'Recurso no encontrado.' });
  } catch (err) {
    if (err.code === 'REDIS_DOWN') return unavailable(res);
    console.error('[http]', err);
    if (!res.headersSent) return sendJson(res, 500, { error: 'INTERNAL', message: 'Error interno del servidor.' });
    res.end();
  }
}
