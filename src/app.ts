import crypto from 'node:crypto';
import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { z } from 'zod';
import type { BookingStore, HoldStore, RateLimiter } from './types.js';

const eventIdSchema = z.coerce.number().int().positive();
const userIdSchema = z.coerce.number().int().positive();
const seatIdsSchema = z.array(z.coerce.number().int().positive()).min(1).max(20).refine((ids) => new Set(ids).size === ids.length, 'seatIds must be unique');
const holdSchema = z.object({ seatIds: seatIdsSchema });
const bookingSchema = z.object({ eventId: eventIdSchema, seatIds: seatIdsSchema, holdId: z.string().min(1), email: z.string().email() });

function userIdFrom(request: Request): number {
  return userIdSchema.parse(request.header('x-user-id'));
}

export function createApp(deps: { holds: HoldStore; bookings: BookingStore; holdTtlSeconds: number; rateLimiter?: RateLimiter }) {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(async (req, res, next) => {
    if (!deps.rateLimiter) return next();
    try {
      if (!await deps.rateLimiter.allow(req.ip ?? 'unknown', 120, 60)) return res.status(429).json({ error: 'rate_limited' });
      next();
    } catch (error) { next(error); }
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.get('/events/:eventId/seats', async (req, res, next) => {
    try {
      const eventId = eventIdSchema.parse(req.params.eventId);
      const seats = await deps.bookings.listSeats(eventId);
      const holds = await deps.holds.getMany(eventId, seats.map((seat) => seat.id));
      res.json({ eventId, seats: seats.map((seat) => ({ ...seat, status: seat.status === 'booked' ? 'booked' : holds.has(seat.id) ? 'held' : 'available' })) });
    } catch (error) { next(error); }
  });

  app.post('/events/:eventId/holds', async (req, res, next) => {
    try {
      const eventId = eventIdSchema.parse(req.params.eventId);
      const userId = userIdFrom(req);
      const { seatIds } = holdSchema.parse(req.body);
      const hold = await deps.holds.createMany(eventId, seatIds, userId, deps.holdTtlSeconds);
      if (!hold) return res.status(409).json({ error: 'seat_unavailable' });
      res.status(200).json({ eventId, seatIds, ...hold });
    } catch (error) { next(error); }
  });

  app.delete('/holds/:holdId', async (req, res, next) => {
    try {
      const released = await deps.holds.releaseMany(eventIdSchema.parse(req.body.eventId), seatIdsSchema.parse(req.body.seatIds), req.params.holdId, userIdFrom(req));
      res.status(released ? 204 : 404).send();
    } catch (error) { next(error); }
  });

  app.post('/bookings', async (req, res, next) => {
    try {
      const idempotencyKey = req.header('idempotency-key');
      if (!idempotencyKey) return res.status(400).json({ error: 'missing_idempotency_key' });
      const userId = userIdFrom(req);
      const input = bookingSchema.parse(req.body);
      const requestHash = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const replay = await deps.bookings.getIdempotent(idempotencyKey, userId, requestHash);
      if (replay) return res.status(replay.statusCode).json(replay.body);
      const holds = await deps.holds.getMany(input.eventId, input.seatIds);
      const valid = input.seatIds.every((seatId) => holds.get(seatId)?.holdId === input.holdId && holds.get(seatId)?.userId === userId);
      if (!valid) return res.status(409).json({ error: 'hold_expired_or_not_owned' });
      const result = await deps.bookings.createBookings(input.eventId, input.seatIds, userId, input.email, idempotencyKey, requestHash);
      if (result.statusCode === 201) await deps.holds.releaseMany(input.eventId, input.seatIds, input.holdId, userId);
      res.status(result.statusCode).json(result.body);
    } catch (error) { next(error); }
  });

  app.delete('/bookings/:bookingId', async (req, res, next) => {
    try {
      const cancelled = await deps.bookings.cancelBooking(Number(req.params.bookingId), userIdFrom(req));
      res.status(cancelled ? 204 : 404).send();
    } catch (error) { next(error); }
  });

  app.use((error: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    if (error instanceof z.ZodError) return res.status(400).json({ error: 'invalid_request', details: error.issues });
    console.error(error);
    res.status(500).json({ error: 'internal_error' });
  });
  return app;
}
