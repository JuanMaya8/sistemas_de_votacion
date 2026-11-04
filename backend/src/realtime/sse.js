// Server-Sent Events endpoint for the public audience.
// GET /api/public/stream?topic=mun:11[&lastEventId=...]   (or header Last-Event-ID)
import { config } from '../config.js';
import { isValidTopic } from '../catalog.js';
import { isRedisUp } from '../redis.js';
import { admit } from './admission.js';
import { PublicClient, register, unregister, startClient, sendControl } from './publicHub.js';

export async function handleSse(req, res, url) {
  const topic = url.searchParams.get('topic') || 'dept';
  if (!isValidTopic(topic)) return sendJson(res, 400, { error: 'TOPIC_INVALID', message: 'Tópico inválido. Use dept, mun:<id> o puesto:<id>.' });

  const admission = admit();
  if (!admission.ok) {
    res.writeHead(503, { 'Retry-After': String(admission.retryAfterSec), 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'BUSY', message: 'Servidor ocupado, reintente en unos segundos.', retryAfterSec: admission.retryAfterSec }));
  }
  if (!isRedisUp()) {
    res.writeHead(503, { 'Retry-After': '3', 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'DEGRADED', message: 'Resultados temporalmente no disponibles. Reintentando…' }));
  }

  const lastEventId = req.headers['last-event-id'] || url.searchParams.get('lastEventId') || '';

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.socket?.setNoDelay(true);
  // "retry" with jitter: even the browser's native reconnection does not fire in lock-step.
  res.write(`retry: ${2000 + Math.floor(Math.random() * 4000)}\n: instancia ${config.instanceId}\n\n`);

  const client = new PublicClient({
    topic,
    transport: 'sse',
    write: (s) => res.write(s),
    buffered: () => res.writableLength,
    onDrainOnce: (fn) => res.once('drain', fn),
    close: () => res.destroy(),
  });
  req.on('close', () => unregister(client));

  try {
    await register(client);
    sendControl(client, 'hello', { instanceId: config.instanceId, topic });
    await startClient(client, lastEventId);
  } catch (err) {
    sendControl(client, 'status', { redis: 'down', message: 'No fue posible sincronizar. Reintentando…' });
    res.end();
  }
}

export function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}
