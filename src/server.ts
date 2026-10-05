import express from 'express';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { createApp } from './app.js';
import { config } from './config.js';
import { PostgresBookingStore } from './postgres-bookings.js';
import { RedisHoldStore } from './redis-holds.js';

const pool = new Pool({ connectionString: config.DATABASE_URL, connectionTimeoutMillis: 5000 });
const redis = createClient({ url: config.REDIS_URL, socket: { connectTimeout: 5000 } });
redis.on('error', (error) => console.error('Redis error', error.message));
pool.on('error', (error) => console.error('PostgreSQL error', error.message));

await redis.connect();
await pool.query('SELECT 1');
const holds = new RedisHoldStore(redis);
const api = createApp({
  holds,
  rateLimiter: holds,
  bookings: new PostgresBookingStore(pool),
  holdTtlSeconds: config.HOLD_TTL_SECONDS,
  rateLimit: { limit: config.RATE_LIMIT_MAX, windowSeconds: config.RATE_LIMIT_WINDOW_SECONDS },
  checkReadiness: async () => { await Promise.all([pool.query('SELECT 1'), redis.ping()]); }
});

const app = express();
app.disable('x-powered-by');
app.use(express.static(resolve('web/dist')));
app.use('/api', api, (_req, res) => { res.status(404).json({ error: 'not_found' }); });
app.use(api); // Keep the documented direct API paths available.
app.use((_req, res) => { res.status(404).json({ error: 'not_found' }); });
const server = app.listen(config.PORT, () => console.log(`Booking engine listening on http://localhost:${config.PORT}`));

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 10_000).unref();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.allSettled([pool.end(), redis.quit()]);
  clearTimeout(deadline);
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
