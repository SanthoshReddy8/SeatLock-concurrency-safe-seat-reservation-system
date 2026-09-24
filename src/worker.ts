import 'dotenv/config';
import { createClient } from 'redis';

const redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
redis.on('error', (error) => console.error('Redis error', error));
await redis.connect();

console.log('Expiry worker online. Redis TTL removes expired holds automatically.');
setInterval(async () => {
  try {
    await redis.ping();
  } catch (error) {
    console.error('Expiry worker health check failed', error);
  }
}, 30_000);
