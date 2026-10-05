import request from 'supertest';
import { createApp } from '../src/app.js';
import type { BookingStore, HoldStore, RateLimiter, Seat } from '../src/types.js';

function setup() {
  const seats: Seat[] = [1, 2, 3].map((id) => ({ id, label: `A${id}`, priceCents: 2500, status: 'available' }));
  const holds: jest.Mocked<HoldStore> = {
    createMany: jest.fn().mockResolvedValue({ holdId: 'hold-1', expiresInSeconds: 300 }),
    getMany: jest.fn().mockResolvedValue(new Map()),
    releaseMany: jest.fn().mockResolvedValue(true),
  };
  const bookings: jest.Mocked<BookingStore> = {
    listSeats: jest.fn().mockResolvedValue(seats),
    getIdempotent: jest.fn().mockResolvedValue(null),
    createBookings: jest.fn().mockResolvedValue({ statusCode: 201, body: { id: 1, bookingIds: [1], eventId: 1, seatIds: [1], userId: 7 } }),
    cancelBooking: jest.fn().mockResolvedValue(true),
  };
  return { app: createApp({ holds, bookings, holdTtlSeconds: 300 }), holds, bookings, seats };
}

const bookingBody = { eventId: 1, seatIds: [1], holdId: 'hold-1', email: 'guest@example.com' };
const validHolds = (seatIds = [1], userId = 7) => new Map(seatIds.map((id) => [id, { holdId: 'hold-1', userId }]));

test('health check reports that the API is running', async () => {
  const { app } = setup();
  await request(app).get('/health').expect(200, { ok: true });
});

test('seat map overlays Redis holds while preserving booked status', async () => {
  const { app, holds, seats } = setup();
  seats[2].status = 'booked';
  holds.getMany.mockResolvedValue(validHolds([2, 3]));
  const result = await request(app).get('/events/1/seats').expect(200);
  expect(result.body.seats.map((seat: Seat) => seat.status)).toEqual(['available', 'held', 'booked']);
});

test.each([
  ['missing identity', undefined, { seatIds: [1] }],
  ['invalid identity', '0', { seatIds: [1] }],
  ['empty selection', '7', { seatIds: [] }],
  ['duplicate seats', '7', { seatIds: [1, 1] }],
  ['nonpositive seat', '7', { seatIds: [0] }],
  ['fractional seat', '7', { seatIds: [1.5] }],
  ['unsafe integer seat', '7', { seatIds: [Number.MAX_SAFE_INTEGER + 1] }],
  ['too many seats', '7', { seatIds: Array.from({ length: 21 }, (_, index) => index + 1) }],
])('rejects %s before acquiring a hold', async (_name, identity, body) => {
  const { app, holds } = setup();
  const pending = request(app).post('/events/1/holds');
  if (identity) pending.set('x-user-id', identity);
  await pending.send(body).expect(400);
  expect(holds.createMany).not.toHaveBeenCalled();
});

test('rejects seats outside the requested event before touching Redis', async () => {
  const { app, holds } = setup();
  await request(app).post('/events/1/holds').set('x-user-id', '7').send({ seatIds: [1, 99] })
    .expect(400, { error: 'invalid_seats' });
  expect(holds.createMany).not.toHaveBeenCalled();
});

test('rejects already booked seats before touching Redis', async () => {
  const { app, holds, seats } = setup();
  seats[0].status = 'booked';
  await request(app).post('/events/1/holds').set('x-user-id', '7').send({ seatIds: [1] })
    .expect(409, { error: 'seat_unavailable' });
  expect(holds.createMany).not.toHaveBeenCalled();
});

test('acquires all requested seats with the configured TTL', async () => {
  const { app, holds } = setup();
  const result = await request(app).post('/events/1/holds').set('x-user-id', '7').send({ seatIds: [1, 2] }).expect(200);
  expect(holds.createMany).toHaveBeenCalledWith(1, [1, 2], 7, 300);
  expect(result.body).toMatchObject({ holdId: 'hold-1', seatIds: [1, 2], expiresInSeconds: 300 });
});

test('returns a conflict when another client holds a seat', async () => {
  const { app, holds } = setup();
  holds.createMany.mockResolvedValue(null);
  await request(app).post('/events/1/holds').set('x-user-id', '7').send({ seatIds: [1] })
    .expect(409, { error: 'seat_unavailable' });
});

test('releases a new hold if another confirmation committed during acquisition', async () => {
  const { app, holds, bookings, seats } = setup();
  bookings.listSeats.mockResolvedValueOnce(seats).mockResolvedValueOnce(seats.map((seat) => ({ ...seat, status: 'booked' })));
  await request(app).post('/events/1/holds').set('x-user-id', '7').send({ seatIds: [1, 2] })
    .expect(409, { error: 'seat_unavailable' });
  expect(holds.releaseMany).toHaveBeenCalledWith(1, [1, 2], 'hold-1', 7);
});

test('releases an unreported hold if the final availability check fails', async () => {
  const { app, holds, bookings, seats } = setup();
  bookings.listSeats.mockResolvedValueOnce(seats).mockRejectedValueOnce(new Error('Database temporarily unavailable'));
  const logging = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await request(app).post('/events/1/holds').set('x-user-id', '7').send({ seatIds: [1] })
      .expect(500, { error: 'internal_error' });
    expect(holds.releaseMany).toHaveBeenCalledWith(1, [1], 'hold-1', 7);
  } finally {
    logging.mockRestore();
  }
});

test('requires an idempotency key before confirming', async () => {
  const { app, bookings } = setup();
  await request(app).post('/bookings').set('x-user-id', '7').send(bookingBody)
    .expect(400, { error: 'missing_idempotency_key' });
  expect(bookings.createBookings).not.toHaveBeenCalled();
});

test.each([
  ['expired', new Map()],
  ['owned by someone else', validHolds([1], 8)],
  ['a different hold', new Map([[1, { holdId: 'other-hold', userId: 7 }]])],
])('cannot confirm a hold that is %s', async (_name, values) => {
  const { app, holds, bookings } = setup();
  holds.getMany.mockResolvedValue(values);
  await request(app).post('/bookings').set('x-user-id', '7').set('Idempotency-Key', 'key').send(bookingBody)
    .expect(409, { error: 'hold_expired_or_not_owned' });
  expect(bookings.createBookings).not.toHaveBeenCalled();
});

test('replays a committed response even after the hold has been released', async () => {
  const { app, holds, bookings } = setup();
  const response = { id: 42, seatIds: [1], userId: 7 };
  bookings.getIdempotent.mockResolvedValue({ statusCode: 201, body: response });
  await request(app).post('/bookings').set('x-user-id', '7').set('Idempotency-Key', 'same').send(bookingBody)
    .expect(201, response);
  expect(holds.getMany).not.toHaveBeenCalled();
  expect(bookings.createBookings).not.toHaveBeenCalled();
});

test('checks for a just-committed retry if its hold disappeared during confirmation', async () => {
  const { app, bookings } = setup();
  const response = { id: 42, seatIds: [1], userId: 7 };
  bookings.getIdempotent.mockResolvedValueOnce(null).mockResolvedValueOnce({ statusCode: 201, body: response });
  await request(app).post('/bookings').set('x-user-id', '7').set('Idempotency-Key', 'same').send(bookingBody)
    .expect(201, response);
  expect(bookings.createBookings).not.toHaveBeenCalled();
});

test('canonicalizes seat ordering for idempotency fingerprints', async () => {
  const { app, holds, bookings } = setup();
  holds.getMany.mockResolvedValue(validHolds([1, 2]));
  for (const seatIds of [[2, 1], [1, 2]]) {
    await request(app).post('/bookings').set('x-user-id', '7').set('Idempotency-Key', 'same')
      .send({ ...bookingBody, seatIds }).expect(201);
  }
  expect(bookings.getIdempotent.mock.calls[0][2]).toEqual(bookings.getIdempotent.mock.calls[1][2]);
  expect(bookings.createBookings.mock.calls[0][1]).toEqual([1, 2]);
});

test('does not turn a committed booking into an error if Redis cleanup fails', async () => {
  const { app, holds } = setup();
  holds.getMany.mockResolvedValue(validHolds());
  holds.releaseMany.mockRejectedValue(new Error('Redis temporarily unavailable'));
  const logging = jest.spyOn(console, 'error').mockImplementation(() => {});
  const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await request(app).post('/bookings').set('x-user-id', '7').set('Idempotency-Key', 'committed')
      .send(bookingBody).expect(201);
  } finally {
    logging.mockRestore();
    warning.mockRestore();
  }
});

test('a database conflict does not release the caller\'s hold', async () => {
  const { app, holds, bookings } = setup();
  holds.getMany.mockResolvedValue(validHolds());
  bookings.createBookings.mockResolvedValue({ statusCode: 409, body: { error: 'seat_booked' } });
  await request(app).post('/bookings').set('x-user-id', '7').set('Idempotency-Key', 'conflict')
    .send(bookingBody).expect(409, { error: 'seat_booked' });
  expect(holds.releaseMany).not.toHaveBeenCalled();
});

test('release passes the authenticated owner and every requested seat to Redis', async () => {
  const { app, holds } = setup();
  await request(app).delete('/holds/hold-1').set('x-user-id', '7').send({ eventId: 1, seatIds: [1, 2] }).expect(204);
  expect(holds.releaseMany).toHaveBeenCalledWith(1, [1, 2], 'hold-1', 7);
});

test('cancellation passes the authenticated owner and reports unknown bookings', async () => {
  const { app, bookings } = setup();
  bookings.cancelBooking.mockResolvedValue(false);
  await request(app).delete('/bookings/42').set('x-user-id', '8').expect(404);
  expect(bookings.cancelBooking).toHaveBeenCalledWith(42, 8);
});

test('rejects an invalid booking ID without issuing a cancellation', async () => {
  const { app, bookings } = setup();
  await request(app).delete('/bookings/not-a-number').set('x-user-id', '7').expect(400);
  expect(bookings.cancelBooking).not.toHaveBeenCalled();
});

test('malformed JSON returns a client error', async () => {
  const { app } = setup();
  await request(app).post('/events/1/holds').set('x-user-id', '7').set('Content-Type', 'application/json')
    .send('{"seatIds":').expect(400, { error: 'invalid_json' });
});

test('rate limiting stops a request before booking work begins', async () => {
  const { holds, bookings } = setup();
  const rateLimiter: RateLimiter = { allow: jest.fn().mockResolvedValue(false) };
  const app = createApp({ holds, bookings, holdTtlSeconds: 300, rateLimiter });
  await request(app).post('/events/1/holds').set('x-user-id', '7').send({ seatIds: [1] })
    .expect(429, { error: 'rate_limited' });
  expect(holds.createMany).not.toHaveBeenCalled();
});
