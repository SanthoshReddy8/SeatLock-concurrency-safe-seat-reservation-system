import { createClient } from 'redis';
import { config } from './config.js';

const redis = createClient({ url: config.REDIS_URL });
redis.on('error', (error) => console.error('Redis error', error.message));
await redis.connect();

console.log('Redis monitor online. Redis TTL expires holds without a worker.');
const interval = setInterval(() => {
  void redis.ping().catch((error: Error) => console.error('Redis health check failed', error.message));
}, 30_000);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(interval);
  await redis.quit();
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
