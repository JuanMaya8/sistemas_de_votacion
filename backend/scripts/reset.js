// Deletes every key of the system (all keys share the "{e}" prefix). Use before a clean test run.
// Usage: REDIS_URL=redis://... node scripts/reset.js
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
let cursor = '0';
let deleted = 0;
do {
  const [next, batch] = await redis.scan(cursor, 'MATCH', '{e}:*', 'COUNT', 1000);
  cursor = next;
  if (batch.length) deleted += await redis.del(...batch);
} while (cursor !== '0');
console.log(`Listo: ${deleted} claves eliminadas.`);
await redis.quit();
