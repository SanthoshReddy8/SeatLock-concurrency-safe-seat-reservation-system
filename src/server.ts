import 'dotenv/config';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { createApp } from './app.js';
import { PostgresBookingStore } from './postgres-bookings.js';
import { RedisHoldStore } from './redis-holds.js';

const port = Number(process.env.PORT ?? 3000);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
redis.on('error', (error) => console.error('Redis error', error));

await redis.connect();
const app = createApp({
  holds: new RedisHoldStore(redis),
  rateLimiter: new RedisHoldStore(redis),
  bookings: new PostgresBookingStore(pool),
  holdTtlSeconds: Number(process.env.HOLD_TTL_SECONDS ?? 300)
});
app.listen(port, () => console.log(`Booking API listening on http://localhost:${port}`));
