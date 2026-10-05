import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { Pool } from 'pg';
import { createClient } from 'redis';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { PostgresBookingStore } from '../../src/postgres-bookings.js';
import { RedisHoldStore } from '../../src/redis-holds.js';

// Every run owns one random SQL schema and Redis prefix. No FLUSHDB/FLUSHALL,
// shared-table truncation, or deletion of another application's keys is needed.
const runId = randomUUID().replaceAll('-', '');
const schema = `seatlock_test_${runId}`;
const prefix = `${schema}:`;
let admin: Pool | undefined;
let pool: Pool | undefined;
let redis: ReturnType<typeof createClient> | undefined;
let server: Server | undefined;
let schemaCreated = false;
let holds: RedisHoldStore;
let bookings: PostgresBookingStore;

async function clearTestRedisKeys() {
  if (!redis?.isReady) return;
  for await (const keys of redis.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) {
    if (keys.length > 0) await redis.del(keys);
  }
}

function holdSeats(seatIds = [1], userId = 7, eventId = 1) {
  return request(server!).post(`/events/${eventId}/holds`).set('x-user-id', String(userId)).send({ seatIds });
}

function confirm(holdId: string, key: string, seatIds = [1], userId = 7, extra: object = {}) {
  return request(server!).post('/bookings').set('x-user-id', String(userId)).set('Idempotency-Key', key)
    .send({ eventId: 1, seatIds, holdId, email: `guest-${userId}@example.com`, ...extra });
}

async function activeBookings(seatIds: number[]) {
  return (await pool!.query("SELECT id, seat_id, user_id FROM bookings WHERE seat_id = ANY($1::int[]) AND status = 'CONFIRMED' ORDER BY seat_id", [seatIds])).rows;
}

beforeAll(async () => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  const redisUrl = process.env.TEST_REDIS_URL;
  if (!databaseUrl || !redisUrl) {
    throw new Error('Integration tests require TEST_DATABASE_URL and TEST_REDIS_URL. Start the dedicated test services and set both URLs; npm test needs neither service.');
  }
  admin = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5000 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 20, connectionTimeoutMillis: 5000 });
  await pool.query(readFileSync(join(process.cwd(), 'schema.sql'), 'utf8'));
  redis = createClient({ url: redisUrl, socket: { connectTimeout: 5000, reconnectStrategy: false } });
  redis.on('error', () => {}); // Connection errors still reject the awaited command.
  await redis.connect();
  holds = new RedisHoldStore(redis, prefix);
  bookings = new PostgresBookingStore(pool);
  server = createServer(createApp({ holds, bookings, holdTtlSeconds: 300 }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
});

beforeEach(async () => {
  if (!pool) return;
  await pool.query(`TRUNCATE "${schema}".idempotency_keys, "${schema}".bookings, "${schema}".users RESTART IDENTITY CASCADE`);
  await clearTestRedisKeys();
});

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  await clearTestRedisKeys();
  if (redis?.isOpen) await redis.quit();
  await pool?.end();
  if (schemaCreated) await admin!.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin?.end();
});

test('100 concurrent hold requests for the same user and seat have exactly one winner', async () => {
  const responses = await Promise.all(Array.from({ length: 100 }, () => holdSeats()));
  expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
  expect(responses.filter((response) => response.status === 409)).toHaveLength(99);
  const winner = responses.find((response) => response.status === 200)!;
  expect((await holds.getMany(1, [1])).get(1)).toEqual({ holdId: winner.body.holdId, userId: 7 });
  const ttl = await redis!.ttl(`${prefix}hold:1:1`);
  expect(ttl).toBeGreaterThan(290);
  expect(ttl).toBeLessThanOrEqual(300);
});

test('100 concurrent confirmations with different keys create exactly one PostgreSQL booking', async () => {
  const hold = await holdSeats().expect(200);
  const responses = await Promise.all(Array.from({ length: 100 }, (_, index) => confirm(hold.body.holdId, `rush-${index}`)));
  expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
  expect(responses.filter((response) => response.status === 409)).toHaveLength(99);
  expect(await activeBookings([1])).toHaveLength(1);
  const duplicates = await pool!.query("SELECT seat_id FROM bookings WHERE status = 'CONFIRMED' GROUP BY seat_id HAVING COUNT(*) > 1");
  expect(duplicates.rows).toEqual([]);
});

test('concurrent retries with the same key all replay one committed response', async () => {
  const hold = await holdSeats([1, 2]).expect(200);
  const responses = await Promise.all(Array.from({ length: 25 }, () => confirm(hold.body.holdId, 'same-key', [1, 2])));
  expect(responses.map((response) => response.status)).toEqual(Array(25).fill(201));
  for (const response of responses) expect(response.body).toEqual(responses[0].body);
  expect(responses[0].body.bookingIds).toHaveLength(2);
  expect(await activeBookings([1, 2])).toHaveLength(2);
  expect((await pool!.query('SELECT key FROM idempotency_keys')).rows).toHaveLength(1);
  const replay = await confirm(hold.body.holdId, 'same-key', [2, 1]).expect(201);
  expect(replay.body).toEqual(responses[0].body);
});

test('an idempotency key cannot be reused for changed data or another owner', async () => {
  const hold = await holdSeats().expect(200);
  await confirm(hold.body.holdId, 'private-key').expect(201);
  await confirm(hold.body.holdId, 'private-key', [1], 7, { email: 'changed@example.com' })
    .expect(409, { error: 'idempotency_key_reused' });
  await confirm(hold.body.holdId, 'private-key', [1], 8)
    .expect(409, { error: 'idempotency_key_reused' });
  expect(await activeBookings([1])).toHaveLength(1);
});

test('the database idempotency conflict path also enforces ownership under a race', async () => {
  const responses = await Promise.all([
    bookings.createBookings(1, [1], 7, 'guest-7@example.com', 'collision', 'same-hash'),
    bookings.createBookings(1, [1], 8, 'guest-8@example.com', 'collision', 'same-hash'),
  ]);
  expect(responses.filter((response) => response.statusCode === 201)).toHaveLength(1);
  expect(responses.find((response) => response.statusCode === 409)?.body).toEqual({ error: 'idempotency_key_reused' });
  expect(await activeBookings([1])).toHaveLength(1);
});

test('multi-seat acquisition is all-or-nothing when any requested seat is held', async () => {
  const existing = await holdSeats([2], 8).expect(200);
  await holdSeats([1, 2, 3], 7).expect(409);
  const values = await holds.getMany(1, [1, 2, 3]);
  expect([...values.keys()]).toEqual([2]);
  expect(values.get(2)?.holdId).toBe(existing.body.holdId);
  await holdSeats([1, 3], 7).expect(200);
});

test('a mixed hold release cannot partially free seats or release another owner\'s hold', async () => {
  const first = await holdSeats([1, 2], 7).expect(200);
  await holdSeats([3], 8).expect(200);
  await request(server!).delete(`/holds/${first.body.holdId}`).set('x-user-id', '7').send({ eventId: 1, seatIds: [1, 3] }).expect(404);
  await request(server!).delete(`/holds/${first.body.holdId}`).set('x-user-id', '8').send({ eventId: 1, seatIds: [1, 2] }).expect(404);
  expect((await holds.getMany(1, [1, 2, 3])).size).toBe(3);
  await request(server!).delete(`/holds/${first.body.holdId}`).set('x-user-id', '7').send({ eventId: 1, seatIds: [1, 2] }).expect(204);
  expect([...((await holds.getMany(1, [1, 2, 3])).keys())]).toEqual([3]);
});

test('Redis TTL makes every seat in an expired hold available again', async () => {
  const first = await holds.createMany(1, [1, 2], 7, 1);
  expect(first).not.toBeNull();
  expect(await holds.createMany(1, [1, 2], 8, 300)).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect((await holds.getMany(1, [1, 2])).size).toBe(0);
  await holdSeats([1, 2], 8).expect(200);
  await confirm(first!.holdId, 'expired', [1, 2], 7).expect(409, { error: 'hold_expired_or_not_owned' });
});

test('PostgreSQL rejects duplicate booking after lost Redis state permits a stale hold', async () => {
  const firstHold = await holdSeats().expect(200);
  // Simulate a database commit followed by a process crash before Redis release.
  const first = await bookings.createBookings(1, [1], 7, 'guest-7@example.com', 'first', 'first-hash');
  expect(first.statusCode).toBe(201);
  await redis!.del(`${prefix}hold:1:1`);
  // A replacement Redis instance cannot know that PostgreSQL already committed.
  const staleHold = await holds.createMany(1, [1], 8, 300);
  expect(staleHold).not.toBeNull();
  await confirm(staleHold!.holdId, 'after-loss', [1], 8).expect(409, { error: 'seat_booked' });
  const rows = await activeBookings([1]);
  expect(rows).toHaveLength(1);
  expect(rows[0].user_id).toBe(7);
  expect(firstHold.body.holdId).not.toBe(staleHold!.holdId);
});

test('a conflict rolls back every seat in a multi-seat database transaction', async () => {
  const first = await bookings.createBookings(1, [2], 8, 'guest-8@example.com', 'occupied', 'occupied-hash');
  expect(first.statusCode).toBe(201);
  const result = await bookings.createBookings(1, [1, 2], 7, 'guest-7@example.com', 'atomic', 'atomic-hash');
  expect(result).toEqual({ statusCode: 409, body: { error: 'seat_booked' } });
  expect((await activeBookings([1, 2])).map((row) => row.seat_id)).toEqual([2]);
  expect(await bookings.getIdempotent('atomic', 7, 'atomic-hash')).toEqual(result);
  const available = await bookings.createBookings(1, [1], 7, 'guest-7@example.com', 'available', 'available-hash');
  expect(available.statusCode).toBe(201);
});

test('only the owner can cancel, and concurrent cancellation releases the entire reservation once', async () => {
  const held = await holdSeats([1, 2]).expect(200);
  const booked = await confirm(held.body.holdId, 'group', [1, 2]).expect(201);
  await request(server!).delete(`/bookings/${booked.body.id}`).set('x-user-id', '8').expect(404);
  expect(await activeBookings([1, 2])).toHaveLength(2);
  const cancellations = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    request(server!).delete(`/bookings/${booked.body.bookingIds[index % 2]}`).set('x-user-id', '7')));
  expect(cancellations.filter((response) => response.status === 204)).toHaveLength(1);
  expect(cancellations.filter((response) => response.status === 404)).toHaveLength(19);
  expect(await activeBookings([1, 2])).toEqual([]);
  await request(server!).delete(`/bookings/${booked.body.id}`).set('x-user-id', '7').expect(404);
  const replacement = await holdSeats([1, 2], 8).expect(200);
  await confirm(replacement.body.holdId, 'replacement', [1, 2], 8).expect(201);
  expect(await activeBookings([1, 2])).toHaveLength(2);
});

test('hold and database validation reject missing seats and event mismatches', async () => {
  await holdSeats([9999]).expect(400, { error: 'invalid_seats' });
  await holdSeats([1], 7, 9999).expect(400, { error: 'invalid_seats' });
  expect((await holds.getMany(1, [9999])).size).toBe(0);
  const result = await bookings.createBookings(9999, [1], 7, 'guest-7@example.com', 'wrong-event', 'wrong-event-hash');
  expect(result).toEqual({ statusCode: 400, body: { error: 'invalid_seats' } });
  expect(await activeBookings([1])).toEqual([]);
});

test('a confirmed seat remains unavailable after the Redis hold has been released', async () => {
  const held = await holdSeats().expect(200);
  await confirm(held.body.holdId, 'booked').expect(201);
  expect((await holds.getMany(1, [1])).size).toBe(0);
  await holdSeats([1], 8).expect(409, { error: 'seat_unavailable' });
  const result = await request(server!).get('/events/1/seats').expect(200);
  expect(result.body.seats.find((seat: { id: number }) => seat.id === 1).status).toBe('booked');
});

test('the Redis rate limiter admits exactly the window limit under concurrency and resets after TTL', async () => {
  const results = await Promise.all(Array.from({ length: 100 }, () => holds.allow('burst', 10, 1)));
  expect(results.filter(Boolean)).toHaveLength(10);
  expect(await redis!.ttl(`${prefix}rate:burst`)).toBeGreaterThanOrEqual(0);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect(await holds.allow('burst', 10, 1)).toBe(true);
});
