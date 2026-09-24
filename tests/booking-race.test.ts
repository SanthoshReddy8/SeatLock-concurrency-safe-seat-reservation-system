import request from 'supertest';
import { createApp } from '../src/app.js';
import type { BookingStore, HoldStore, Seat, StoredResponse } from '../src/types.js';

type Held = { holdId: string; userId: number; expiresAt: number };

class FakeHolds implements HoldStore {
  private readonly values = new Map<number, Held>();
  private sequence = 0;

  async createMany(_eventId: number, seatIds: number[], userId: number, ttlSeconds: number) {
    this.expire();
    if (seatIds.some((seatId) => this.values.has(seatId))) return null;
    const holdId = `hold-${++this.sequence}`;
    for (const seatId of seatIds) this.values.set(seatId, { holdId, userId, expiresAt: Date.now() + ttlSeconds * 1000 });
    return { holdId, expiresInSeconds: ttlSeconds };
  }

  async getMany(_eventId: number, seatIds: number[]) {
    this.expire();
    return new Map(seatIds.flatMap((seatId) => {
      const held = this.values.get(seatId);
      return held ? [[seatId, { holdId: held.holdId, userId: held.userId }] as const] : [];
    }));
  }

  async releaseMany(_eventId: number, seatIds: number[], holdId: string, userId: number) {
    const valid = seatIds.every((seatId) => this.values.get(seatId)?.holdId === holdId && this.values.get(seatId)?.userId === userId);
    if (!valid) return false;
    seatIds.forEach((seatId) => this.values.delete(seatId));
    return true;
  }

  flush() { this.values.clear(); }
  private expire() { for (const [seatId, held] of this.values) if (held.expiresAt <= Date.now()) this.values.delete(seatId); }
}

class FakeBookings implements BookingStore {
  private readonly booked = new Set<number>();
  private readonly idempotency = new Map<string, { hash: string; response: StoredResponse }>();
  private nextId = 1;

  async listSeats(_eventId: number): Promise<Seat[]> {
    return Array.from({ length: 50 }, (_, index) => ({ id: index + 1, label: `A${index + 1}`, priceCents: 2500, status: this.booked.has(index + 1) ? 'booked' : 'available' }));
  }

  async getIdempotent(key: string, _userId: number, hash: string) {
    const value = this.idempotency.get(key);
    if (!value) return null;
    return value.hash === hash ? value.response : { statusCode: 409 as const, body: { error: 'idempotency_key_reused' } };
  }

  async createBookings(eventId: number, seatIds: number[], userId: number, _email: string, key: string, hash: string) {
    const response = seatIds.some((seatId) => this.booked.has(seatId))
      ? { statusCode: 409, body: { error: 'seat_booked' } }
      : { statusCode: 201, body: { id: this.nextId++, eventId, seatIds, userId, createdAt: new Date().toISOString() } };
    if (response.statusCode === 201) seatIds.forEach((seatId) => this.booked.add(seatId));
    this.idempotency.set(key, { hash, response });
    return response;
  }

  async cancelBooking(bookingId: number) { return bookingId > 0; }
  seedBooked(seatId: number) { this.booked.add(seatId); }
}

function setup(ttl = 300) {
  const holds = new FakeHolds();
  const bookings = new FakeBookings();
  return { app: createApp({ holds, bookings, holdTtlSeconds: ttl }), holds, bookings };
}

const holdRequest = (app: ReturnType<typeof createApp>) => request(app).post('/events/1/holds').set('x-user-id', '7').send({ seatIds: [1] });
const bookingBody = (holdId: string) => ({ eventId: 1, seatIds: [1], holdId, email: 'guest@example.com' });

test('the same user can hold the same seat only once', async () => {
  const { app } = setup();
  const responses = await Promise.all(Array.from({ length: 100 }, () => holdRequest(app)));
  expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
  expect(responses.filter((response) => response.status === 409)).toHaveLength(99);
});

test('100 parallel confirmations produce exactly one booking', async () => {
  const { app } = setup();
  const hold = await holdRequest(app);
  const responses = await Promise.all(Array.from({ length: 100 }, (_, index) => request(app).post('/bookings').set('x-user-id', '7').set('Idempotency-Key', `rush-${index}`).send(bookingBody(hold.body.holdId))));
  expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
  expect(responses.filter((response) => response.status === 409)).toHaveLength(99);
});

test('the same idempotency key replays the same response', async () => {
  const { app } = setup();
  const hold = await holdRequest(app);
  const first = await request(app).post('/bookings').set('x-user-id', '7').set('Idempotency-Key', 'same-key').send(bookingBody(hold.body.holdId));
  const second = await request(app).post('/bookings').set('x-user-id', '7').set('Idempotency-Key', 'same-key').send(bookingBody(hold.body.holdId));
  expect(second.status).toBe(201);
  expect(second.body).toEqual(first.body);
});

test('an expired hold becomes available again', async () => {
  const { app } = setup(1);
  const first = await holdRequest(app);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const second = await holdRequest(app);
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
});

test('a Redis flush cannot bypass the database uniqueness constraint', async () => {
  const { app, holds, bookings } = setup();
  const hold = await holdRequest(app);
  bookings.seedBooked(1);
  holds.flush();
  const response = await request(app).post('/bookings').set('x-user-id', '7').set('Idempotency-Key', 'db-wins').send(bookingBody(hold.body.holdId));
  expect(response.status).toBe(409);
  expect(response.body.error).toBe('hold_expired_or_not_owned');
});

test('confirming without a valid hold returns a conflict', async () => {
  const { app } = setup();
  const response = await request(app).post('/bookings').set('x-user-id', '7').set('Idempotency-Key', 'no-hold').send(bookingBody('missing'));
  expect(response.status).toBe(409);
});
