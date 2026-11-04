// Admission control (RF-10): when an instance dies, its clients reconnect to the survivors. Each
// instance accepts at most N new public connections per second; the rest receive 503 + a random
// Retry-After so the wave spreads over time instead of knocking down the remaining instances.
import { config } from '../config.js';
import { metrics } from '../metrics/metrics.js';

let tokens = config.maxNewConnPerSec;
let lastRefill = Date.now();

export function admit() {
  const now = Date.now();
  tokens = Math.min(config.maxNewConnPerSec, tokens + ((now - lastRefill) / 1000) * config.maxNewConnPerSec);
  lastRefill = now;
  if (tokens >= 1) { tokens -= 1; metrics.newConnection(); return { ok: true }; }
  metrics.rejectedConnection();
  return { ok: false, retryAfterSec: 1 + Math.floor(Math.random() * 5) };
}
