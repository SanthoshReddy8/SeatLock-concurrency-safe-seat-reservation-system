export type SeatStatus = 'available' | 'held' | 'booked';

export type Seat = {
  id: number;
  label: string;
  priceCents: number;
  status: SeatStatus;
};

export type Hold = {
  eventId: string;
  seatIds: number[];
  holdId: string;
  userId: number;
  expiresAt: number;
};

export type Booking = {
  id: number;
  bookingIds: number[];
  groupId: string;
  eventId: number;
  seatIds: number[];
  userId: number;
  createdAt: string;
};

export type StoredResponse = { statusCode: number; body: unknown };

export interface HoldStore {
  createMany(eventId: number, seatIds: number[], userId: number, ttlSeconds: number): Promise<{ holdId: string; expiresInSeconds: number } | null>;
  getMany(eventId: number, seatIds: number[]): Promise<Map<number, { holdId: string; userId: number }>>;
  releaseMany(eventId: number, seatIds: number[], holdId: string, userId: number): Promise<boolean>;
}

export interface BookingStore {
  listSeats(eventId: number): Promise<Seat[]>;
  getIdempotent(idempotencyKey: string, userId: number, requestHash: string): Promise<StoredResponse | { statusCode: 409; body: { error: string } } | null>;
  createBookings(eventId: number, seatIds: number[], userId: number, email: string, idempotencyKey: string, requestHash: string): Promise<StoredResponse>;
  cancelBooking(bookingId: number, userId: number): Promise<boolean>;
}

export interface RateLimiter {
  allow(key: string, limit: number, windowSeconds: number): Promise<boolean>;
}
