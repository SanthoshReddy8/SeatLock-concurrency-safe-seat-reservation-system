import crypto from 'node:crypto';
import type { Pool } from 'pg';
import type { BookingStore, Seat } from './types.js';

export class PostgresBookingStore implements BookingStore {
  constructor(private readonly pool: Pool) {}

  async listSeats(eventId: number): Promise<Seat[]> {
    const result = await this.pool.query(
      `SELECT s.id, s.label, s.price_cents,
        CASE WHEN b.seat_id IS NULL THEN 'available' ELSE 'booked' END AS status
       FROM seats s LEFT JOIN bookings b ON b.seat_id = s.id AND b.status = 'CONFIRMED'
       WHERE s.event_id = $1 ORDER BY s.id`, [eventId]
    );
    return result.rows.map((row) => ({ id: row.id, label: row.label, priceCents: row.price_cents, status: row.status }));
  }

  async getIdempotent(idempotencyKey: string, userId: number, requestHash: string) {
    const result = await this.pool.query('SELECT user_id, request_hash, response_body, status_code FROM idempotency_keys WHERE key = $1', [idempotencyKey]);
    const row = result.rows[0];
    if (!row) return null;
    if (row.user_id !== userId || row.request_hash !== requestHash) return { statusCode: 409 as const, body: { error: 'idempotency_key_reused' } };
    return row.response_body ? { statusCode: row.status_code, body: row.response_body } : { statusCode: 202, body: { error: 'request_in_progress' } };
  }

  async createBookings(eventId: number, seatIds: number[], userId: number, email: string, idempotencyKey: string, requestHash: string) {
    // Every transaction acquires seat uniqueness locks in the same order.
    const orderedSeatIds = [...new Set(seatIds)].sort((left, right) => left - right);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO idempotency_keys (key, user_id, request_hash)
         VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING RETURNING key`, [idempotencyKey, userId, requestHash]
      );
      if (inserted.rowCount === 0) {
        const existing = await client.query('SELECT user_id, request_hash, response_body, status_code FROM idempotency_keys WHERE key = $1 FOR UPDATE', [idempotencyKey]);
        const row = existing.rows[0];
        if (row.user_id !== userId || row.request_hash !== requestHash) {
          await client.query('ROLLBACK');
          return { statusCode: 409, body: { error: 'idempotency_key_reused' } };
        }
        await client.query('COMMIT');
        return { statusCode: row.status_code ?? 202, body: row.response_body ?? { error: 'request_in_progress' } };
      }

      await client.query('SAVEPOINT booking_insert');
      try {
        const seats = await client.query('SELECT id FROM seats WHERE event_id = $1 AND id = ANY($2::int[]) ORDER BY id', [eventId, orderedSeatIds]);
        if (orderedSeatIds.length === 0 || orderedSeatIds.length !== seatIds.length || seats.rowCount !== orderedSeatIds.length) {
          const body = { error: 'invalid_seats' };
          await client.query('UPDATE idempotency_keys SET response_body = $2, status_code = 400 WHERE key = $1', [idempotencyKey, JSON.stringify(body)]);
          await client.query('COMMIT');
          return { statusCode: 400, body };
        }
        await client.query('INSERT INTO users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [userId, email]);
        const groupId = crypto.randomUUID();
        const rows = [];
        for (const seatId of orderedSeatIds) {
          const result = await client.query(
            `INSERT INTO bookings (event_id, seat_id, user_id, status, group_id)
             VALUES ($1, $2, $3, 'CONFIRMED', $4) RETURNING id, created_at`, [eventId, seatId, userId, groupId]
          );
          rows.push(result.rows[0]);
        }
        const body = { id: rows[0].id, bookingIds: rows.map((row) => row.id), groupId, eventId, seatIds: orderedSeatIds, userId, createdAt: rows[0].created_at.toISOString() };
        await client.query('UPDATE idempotency_keys SET response_body = $2, status_code = 201 WHERE key = $1', [idempotencyKey, JSON.stringify(body)]);
        await client.query('COMMIT');
        return { statusCode: 201, body };
      } catch (error: unknown) {
        await client.query('ROLLBACK TO SAVEPOINT booking_insert');
        const databaseError = error as { code?: string; constraint?: string };
        if (databaseError.code !== '23505' && databaseError.code !== '23503') throw error;
        const statusCode = databaseError.code === '23503' ? 400 : 409;
        const body = { error: databaseError.code === '23503' ? 'invalid_seats' : databaseError.constraint === 'users_email_key' ? 'email_in_use' : 'seat_booked' };
        await client.query('UPDATE idempotency_keys SET response_body = $2, status_code = $3 WHERE key = $1', [idempotencyKey, JSON.stringify(body), statusCode]);
        await client.query('COMMIT');
        return { statusCode, body };
      }
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async cancelBooking(bookingId: number, userId: number): Promise<boolean> {
    // A response represents a whole reservation. Cancelling any row in it must
    // release every seat in one statement; legacy rows without a group stand alone.
    const result = await this.pool.query(
      `WITH target AS (
         SELECT group_id FROM bookings WHERE id = $1 AND user_id = $2 AND status = 'CONFIRMED'
       ), locked AS MATERIALIZED (
         SELECT b.id FROM bookings b
         WHERE b.user_id = $2 AND b.status = 'CONFIRMED' AND EXISTS (SELECT 1 FROM target)
           AND (b.id = $1 OR b.group_id = (SELECT group_id FROM target))
         ORDER BY b.seat_id, b.id FOR UPDATE OF b
       )
       UPDATE bookings b SET status = 'CANCELLED'
       FROM locked WHERE b.id = locked.id`, [bookingId, userId]
    );
    return (result.rowCount ?? 0) > 0;
  }
}
