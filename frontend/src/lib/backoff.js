// Reconnection strategy shared by every live connection (RF-10).
// Exponential backoff with FULL jitter: wait = random(0, min(cap, base * 2^attempt)).
// When an instance dies, its clients spread their reconnections over several seconds instead of
// hitting the surviving instances all at the same millisecond.
export function fullJitter(attempt, base = 3000, cap = 30000) {
  return Math.random() * Math.min(cap, base * 2 ** attempt);
}

/** Honours a server Retry-After (seconds) without synchronising everybody on it. */
export function retryDelay(attempt, retryAfterSec) {
  const jitter = fullJitter(attempt);
  return retryAfterSec ? Math.max(jitter, retryAfterSec * 1000 * (0.5 + Math.random())) : jitter;
}
