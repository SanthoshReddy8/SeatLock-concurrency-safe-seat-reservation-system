import crypto from 'node:crypto';
import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { z } from 'zod';
import type { BookingStore, HoldStore, RateLimiter } from './types.js';

const eventIdSchema = z.coerce.number().int().positive().max(2147483647);
const userIdSchema = eventIdSchema;
const seatIdsSchema = z.array(z.number().int().positive().max(2147483647)).min(1).max(20)
  .refine((ids) => new Set(ids).size === ids.length, 'seatIds must be unique')
  .transform((ids) => [...ids].sort((left, right) => left - right));
const holdSchema = z.object({ seatIds: seatIdsSchema });
const releaseSchema = z.object({ eventId: eventIdSchema, seatIds: seatIdsSchema });
const holdIdSchema = z.string().min(1).max(200);
const bookingSchema = z.object({ eventId: eventIdSchema, seatIds: seatIdsSchema, holdId: holdIdSchema, email: z.string().trim().email().max(254) });

function userIdFrom(request: Request): number {
  return userIdSchema.parse(request.header('x-user-id'));
}

export function createApp(deps: {
  holds: HoldStore;
  bookings: BookingStore;
  holdTtlSeconds: number;
  rateLimiter?: RateLimiter;
  rateLimit?: { limit: number; windowSeconds: number };
  checkReadiness?: () => Promise<void>;
}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors());
  app.use(express.json());

  // Probes must remain available when a client reaches its request quota.
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.get('/ready', async (_req, res) => {
    try {
      await deps.checkReadiness?.();
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false, error: 'dependencies_unavailable' });
    }
  });

  app.use(async (req, res, next) => {
    if (!deps.rateLimiter) return next();
    try {
      const { limit = 120, windowSeconds = 60 } = deps.rateLimit ?? {};
      if (!await deps.rateLimiter.allow(req.ip ?? 'unknown', limit, windowSeconds)) {
        return res.set('Retry-After', String(windowSeconds)).status(429).json({ error: 'rate_limited' });
      }
      next();
    } catch (error) { next(error); }
  });

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
      const seats = new Map((await deps.bookings.listSeats(eventId)).map((seat) => [seat.id, seat]));
      if (seatIds.some((seatId) => !seats.has(seatId))) return res.status(400).json({ error: 'invalid_seats' });
      if (seatIds.some((seatId) => seats.get(seatId)?.status === 'booked')) return res.status(409).json({ error: 'seat_unavailable' });
      const hold = await deps.holds.createMany(eventId, seatIds, userId, deps.holdTtlSeconds);
      if (!hold) return res.status(409).json({ error: 'seat_unavailable' });
      try {
        // A confirmation can commit and release its Redis keys between the first
        // database read and our hold acquisition. Catch that stale availability.
        const currentSeats = new Map((await deps.bookings.listSeats(eventId)).map((seat) => [seat.id, seat]));
        const missing = seatIds.some((seatId) => !currentSeats.has(seatId));
        const booked = seatIds.some((seatId) => currentSeats.get(seatId)?.status === 'booked');
        if (missing || booked) {
          await deps.holds.releaseMany(eventId, seatIds, hold.holdId, userId);
          return res.status(missing ? 400 : 409).json({ error: missing ? 'invalid_seats' : 'seat_unavailable' });
        }
      } catch (error) {
        // Do not leave an unreported hold behind after a failed availability read.
        try { await deps.holds.releaseMany(eventId, seatIds, hold.holdId, userId); } catch { /* TTL remains the fallback. */ }
        throw error;
      }
      res.status(200).json({ eventId, seatIds, ...hold });
    } catch (error) { next(error); }
  });

  app.delete('/holds/:holdId', async (req, res, next) => {
    try {
      const { eventId, seatIds } = releaseSchema.parse(req.body);
      const released = await deps.holds.releaseMany(eventId, seatIds, holdIdSchema.parse(req.params.holdId), userIdFrom(req));
      res.status(released ? 204 : 404).send();
    } catch (error) { next(error); }
  });

  app.post('/bookings', async (req, res, next) => {
    try {
      const rawKey = req.header('idempotency-key');
      if (!rawKey) return res.status(400).json({ error: 'missing_idempotency_key' });
      const idempotencyKey = z.string().trim().min(1).max(200).parse(rawKey);
      const userId = userIdFrom(req);
      const input = bookingSchema.parse(req.body);
      const requestHash = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const replay = await deps.bookings.getIdempotent(idempotencyKey, userId, requestHash);
      if (replay) return res.status(replay.statusCode).json(replay.body);
      const holds = await deps.holds.getMany(input.eventId, input.seatIds);
      const valid = input.seatIds.every((seatId) => holds.get(seatId)?.holdId === input.holdId && holds.get(seatId)?.userId === userId);
      if (!valid) {
        // Another retry may have committed and released the hold since the first
        // lookup. Its committed response takes precedence over a missing hold.
        const completed = await deps.bookings.getIdempotent(idempotencyKey, userId, requestHash);
        if (completed) return res.status(completed.statusCode).json(completed.body);
        return res.status(409).json({ error: 'hold_expired_or_not_owned' });
      }
      const result = await deps.bookings.createBookings(input.eventId, input.seatIds, userId, input.email, idempotencyKey, requestHash);
      if (result.statusCode === 201) {
        try {
          await deps.holds.releaseMany(input.eventId, input.seatIds, input.holdId, userId);
        } catch (error) {
          // The durable transaction has succeeded. A best-effort cache cleanup
          // must not turn that success into a misleading 500; TTL cleans up later.
          console.warn('Booking committed; Redis hold cleanup will rely on TTL.', error);
        }
      }
      res.status(result.statusCode).json(result.body);
    } catch (error) { next(error); }
  });

  app.delete('/bookings/:bookingId', async (req, res, next) => {
    try {
      const cancelled = await deps.bookings.cancelBooking(eventIdSchema.parse(req.params.bookingId), userIdFrom(req));
      res.status(cancelled ? 204 : 404).send();
    } catch (error) { next(error); }
  });

  app.use((error: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    if (error instanceof z.ZodError) return res.status(400).json({ error: 'invalid_request', details: error.issues });
    const bodyError = error as { type?: string };
    if (bodyError.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
    if (bodyError.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
    console.error(error);
    res.status(500).json({ error: 'internal_error' });
  });
  return app;
}
