// WebSocket endpoints:
//   /ws/jurado          bidirectional: submit actas, receive ack / verification results
//   /ws/verificacion    collaborative console for auditors and the coordinator
//   /ws/public          public results over WebSocket (only to MEASURE it against SSE, see docs)
import { WebSocketServer } from 'ws';
import { config } from '../config.js';
import { sub, redisHealth, isRedisUp } from '../redis.js';
import { channels } from '../keys.js';
import { isValidTopic } from '../catalog.js';
import { connections } from '../metrics/metrics.js';
import { submitActa, getActaStatus } from '../services/actas.js';
import * as verification from '../services/verification.js';
import { admit } from './admission.js';
import { PublicClient, register, unregister, startClient, sendControl } from './publicHub.js';

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

const juradoSockets = new Map(); // juradoId -> Set<ws>
const verificationSockets = new Set();

const send = (ws, obj) => {
  if (ws.readyState !== ws.OPEN) return;
  if (ws.bufferedAmount > config.slowHardBytes) { ws.close(4008, 'SLOW_CONSUMER'); return; }
  ws.send(JSON.stringify(obj));
};

export function attachWebSockets(server) {
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const route = { '/ws/jurado': onJurado, '/ws/verificacion': onVerification, '/ws/public': onPublic }[url.pathname];
    if (!route) { socket.destroy(); return; }
    if (url.pathname === '/ws/public') {
      const a = admit();
      if (!a.ok) { socket.end(`HTTP/1.1 503 Service Unavailable\r\nRetry-After: ${a.retryAfterSec}\r\n\r\n`); return; }
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      route(ws, url);
    });
  });

  // Detect dead TCP connections (laptop without battery, phone that lost signal).
  setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000).unref();

  sub.subscribe(channels.verify, channels.jurados).catch(() => {});
  sub.on('message', (channel, raw) => {
    if (channel === channels.verify) {
      for (const ws of verificationSockets) if (ws.readyState === ws.OPEN) ws.send(raw);
    } else if (channel === channels.jurados) {
      const msg = JSON.parse(raw);
      const set = juradoSockets.get(msg.jurado);
      if (set) for (const ws of set) send(ws, { type: 'verification_result', ...msg });
    }
  });

  const notifyAll = (status) => {
    const msg = status === 'down'
      ? { type: 'status', redis: 'down', message: 'Servidor central no disponible. Sus actas quedan guardadas en el dispositivo y se reenviarán automáticamente.' }
      : { type: 'status', redis: 'up', message: 'Conexión con el servidor central restablecida.' };
    for (const ws of wss.clients) send(ws, msg);
  };
  redisHealth.on('down', () => notifyAll('down'));
  redisHealth.on('up', () => notifyAll('up'));

  // Coordinators receive the presence list every 3 s (RF-8).
  setInterval(async () => {
    const coordinators = [...verificationSockets].filter((ws) => ws.role === 'coordinator');
    if (!coordinators.length || !isRedisUp()) return;
    try {
      const auditors = await verification.listPresence();
      for (const ws of coordinators) send(ws, { type: 'presence', auditors, at: Date.now() });
    } catch { /* degraded */ }
  }, 3000).unref();
}

// ---------------- jurados ----------------
function onJurado(ws) {
  connections.jurado++;
  send(ws, { type: 'welcome', instanceId: config.instanceId, redis: isRedisUp() ? 'up' : 'down' });

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return send(ws, { type: 'error', message: 'Mensaje inválido' }); }

    if (msg.type === 'hello' && typeof msg.juradoId === 'string') {
      ws.juradoId = msg.juradoId;
      if (!juradoSockets.has(ws.juradoId)) juradoSockets.set(ws.juradoId, new Set());
      juradoSockets.get(ws.juradoId).add(ws);
      return;
    }
    if (msg.type === 'submit') {
      const result = await submitActa(msg.acta);
      return send(ws, { type: 'ack', requestId: msg.requestId, instanceId: config.instanceId, ...result });
    }
    if (msg.type === 'status' && Array.isArray(msg.actas)) {
      try {
        const statuses = await Promise.all(msg.actas.slice(0, 50).map((id) => getActaStatus(String(id))));
        return send(ws, { type: 'status_result', requestId: msg.requestId, statuses });
      } catch { return send(ws, { type: 'status_result', requestId: msg.requestId, error: 'UNAVAILABLE' }); }
    }
  });

  ws.on('close', () => {
    connections.jurado--;
    const set = ws.juradoId && juradoSockets.get(ws.juradoId);
    if (set) { set.delete(ws); if (!set.size) juradoSockets.delete(ws.juradoId); }
  });
}

// ---------------- auditors / coordinator ----------------
function onVerification(ws) {
  connections.verification++;
  verificationSockets.add(ws);
  ws.auditor = null;
  ws.role = 'auditor';

  const reply = (requestId, body) => send(ws, { type: 'reply', requestId, ...body });
  const presence = () => ws.auditor && ws.role === 'auditor' && verification.presenceHeartbeat({
    auditorId: ws.auditor.auditorId, name: ws.auditor.name, instanceId: config.instanceId,
    caseId: ws.currentCase || null, caseSince: ws.caseSince || null, connectedAt: ws.connectedAt,
    lastActivity: ws.lastActivity || Date.now(),
  }).catch(() => {});

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    try {
      switch (msg.type) {
        case 'hello': {
          ws.role = msg.role === 'coordinator' ? 'coordinator' : 'auditor';
          ws.auditor = { auditorId: String(msg.auditorId || '').slice(0, 40), name: String(msg.name || msg.auditorId || '').slice(0, 60) };
          ws.connectedAt = Date.now();
          // Resuming after a network blip: the browser still holds the case and its token.
          if (msg.resume?.caseId && msg.resume?.token && await verification.renewCase(msg.resume.caseId, msg.resume.token)) {
            ws.currentCase = msg.resume.caseId; ws.caseSince = msg.resume.since || Date.now();
          }
          await presence();
          const q = await verification.listQueue();
          send(ws, { type: 'welcome', instanceId: config.instanceId, role: ws.role, ...q, resumed: !!ws.currentCase,
            presence: ws.role === 'coordinator' ? await verification.listPresence() : undefined });
          break;
        }
        case 'heartbeat': {
          ws.lastActivity = msg.lastActivity || Date.now();
          if (msg.caseId && msg.token) {
            const idle = Date.now() - ws.lastActivity > config.auditorIdleLimitMs;
            if (idle) {
              // Not renewing: the lock will expire and the sweeper returns the case to the queue.
              send(ws, { type: 'idle_warning', caseId: msg.caseId, message: 'Inactividad prolongada: el caso se liberará y volverá a la cola.' });
            } else if (!(await verification.renewCase(msg.caseId, msg.token))) {
              ws.currentCase = null;
              send(ws, { type: 'lock_lost', caseId: msg.caseId, message: 'Su bloqueo expiró y el caso volvió a la cola o fue tomado por otro auditor.' });
            }
          }
          await presence();
          break;
        }
        case 'take': {
          const r = await verification.takeCase(String(msg.caseId), ws.auditor);
          if (r.ok) { ws.currentCase = r.caseId; ws.caseSince = Date.now(); await presence(); }
          reply(msg.requestId, r);
          break;
        }
        case 'release': {
          const ok = await verification.releaseCase(String(msg.caseId), String(msg.token), ws.auditor);
          if (ok) { ws.currentCase = null; ws.caseSince = null; await presence(); }
          reply(msg.requestId, { ok, message: ok ? 'Caso devuelto a la cola.' : 'El caso ya no le pertenece.' });
          break;
        }
        case 'resolve': {
          const r = await verification.resolveCase(msg, ws.auditor);
          if (r.ok || r.code === 'LOCK_LOST') { ws.currentCase = null; ws.caseSince = null; await presence(); }
          reply(msg.requestId, r);
          break;
        }
        case 'queue': {
          reply(msg.requestId, { ok: true, ...(await verification.listQueue()) });
          break;
        }
        default: break;
      }
    } catch (err) {
      reply(msg.requestId, { ok: false, code: 'UNAVAILABLE', message: 'Servidor central no disponible. Intente de nuevo en unos segundos.' });
    }
  });

  ws.on('close', () => {
    connections.verification--;
    verificationSockets.delete(ws);
    // The lock is NOT released here: if the auditor comes back within the TTL (network blip) the
    // case is still his. If not, the lock expires and the sweeper returns the case to the queue.
    if (ws.auditor && ws.role === 'auditor' && !ws.currentCase) verification.presenceLeave(ws.auditor.auditorId).catch(() => {});
  });
}

// ---------------- public over WebSocket (comparison only) ----------------
async function onPublic(ws, url) {
  const topic = url.searchParams.get('topic') || 'dept';
  if (!isValidTopic(topic)) return ws.close(4000, 'TOPIC_INVALID');
  const client = new PublicClient({
    topic,
    transport: 'ws',
    write: (s) => ws.readyState === ws.OPEN && ws.send(s),
    buffered: () => ws.bufferedAmount,
    onDrainOnce: (fn) => { const t = setInterval(() => { if (ws.bufferedAmount < config.slowSoftBytes / 2) { clearInterval(t); fn(); } }, 250); ws.once('close', () => clearInterval(t)); },
    close: (reason) => ws.close(4008, reason),
  });
  ws.on('close', () => unregister(client));
  try {
    await register(client);
    sendControl(client, 'hello', { instanceId: config.instanceId, topic });
    await startClient(client, url.searchParams.get('lastEventId') || '');
  } catch { ws.close(1013, 'DEGRADED'); }
}
