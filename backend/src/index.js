// Entry point: one stateless application instance. Run 8 of them behind a load balancer.
import http from 'node:http';
import { config } from './config.js';
import { redis } from './redis.js';
import { handleRequest } from './routes/api.js';
import { attachWebSockets } from './realtime/wsServer.js';
import { startMetrics } from './metrics/metrics.js';
import { startAggregator } from './services/aggregator.js';

const server = http.createServer(handleRequest);
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 0; // SSE connections are long-lived

attachWebSockets(server);
startMetrics();
startAggregator();

server.listen(config.port, () => {
  console.log(`[app] instancia ${config.instanceId} escuchando en :${config.port}`);
});

function shutdown(signal) {
  console.log(`[app] ${signal}: cerrando instancia ${config.instanceId}`);
  server.close();
  // Clients reconnect (with jitter) to the remaining instances.
  setTimeout(() => { redis.quit().catch(() => {}); process.exit(0); }, 1500).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
