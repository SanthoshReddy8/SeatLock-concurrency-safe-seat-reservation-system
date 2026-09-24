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
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [userId, email]);
      const inserted = await client.query(
        `INSERT INTO idempotency_keys (key, user_id, request_hash)
         VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING RETURNING key`, [idempotencyKey, userId, requestHash]
      );
      if (inserted.rowCount === 0) {
        const existing = await client.query('SELECT request_hash, response_body, status_code FROM idempotency_keys WHERE key = $1 FOR UPDATE', [idempotencyKey]);
        const row = existing.rows[0];
        if (row.request_hash !== requestHash) {
          await client.query('ROLLBACK');
          return { statusCode: 409, body: { error: 'idempotency_key_reused' } };
        }
        await client.query('COMMIT');
        return { statusCode: row.status_code ?? 202, body: row.response_body ?? { error: 'request_in_progress' } };
      }

      await client.query('SAVEPOINT booking_insert');
      try {
        const rows = [];
        for (const seatId of seatIds) {
          const result = await client.query(
            `INSERT INTO bookings (event_id, seat_id, user_id, status)
             VALUES ($1, $2, $3, 'CONFIRMED') RETURNING id, created_at`, [eventId, seatId, userId]
          );
          rows.push(result.rows[0]);
        }
        await client.query('RELEASE SAVEPOINT booking_insert');
        const body = { id: rows[0].id, eventId, seatIds, userId, createdAt: rows[0].created_at.toISOString() };
        await client.query('UPDATE idempotency_keys SET response_body = $2, status_code = 201 WHERE key = $1', [idempotencyKey, JSON.stringify(body)]);
        await client.query('COMMIT');
        return { statusCode: 201, body };
      } catch (error: unknown) {
        await client.query('ROLLBACK TO SAVEPOINT booking_insert');
        if ((error as { code?: string }).code !== '23505') throw error;
        const body = { error: 'seat_booked' };
        await client.query('UPDATE idempotency_keys SET response_body = $2, status_code = 409 WHERE key = $1', [idempotencyKey, JSON.stringify(body)]);
        await client.query('COMMIT');
        return { statusCode: 409, body };
      }
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async cancelBooking(bookingId: number, userId: number): Promise<boolean> {
    const result = await this.pool.query(`UPDATE bookings SET status = 'CANCELLED' WHERE id = $1 AND user_id = $2 AND status = 'CONFIRMED'`, [bookingId, userId]);
    return result.rowCount === 1;
  }
}
