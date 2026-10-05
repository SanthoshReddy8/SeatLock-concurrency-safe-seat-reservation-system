CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS seats (
  id SERIAL PRIMARY KEY,
  event_id INT NOT NULL REFERENCES events(id),
  label TEXT NOT NULL,     
  price_cents INT NOT NULL,
  UNIQUE (event_id, label)
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  id SERIAL PRIMARY KEY,
  event_id INT NOT NULL REFERENCES events(id),
  seat_id INT NOT NULL REFERENCES seats(id),
  user_id INT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('CONFIRMED','CANCELLED')),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Additive migration: old reservations keep their existing IDs and can still
-- be cancelled individually; new multi-seat reservations share a group UUID.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS group_id UUID;
CREATE INDEX IF NOT EXISTS bookings_group_id_idx ON bookings (group_id);

-- Protect event membership even if an insert bypasses the HTTP API. NOT VALID
-- preserves legacy rows while enforcing the constraint for every new write.
CREATE UNIQUE INDEX IF NOT EXISTS seats_id_event_id_unique ON seats (id, event_id);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bookings_seat_event_fk' AND conrelid = 'bookings'::regclass
  ) THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_seat_event_fk
      FOREIGN KEY (seat_id, event_id) REFERENCES seats (id, event_id) NOT VALID;
  END IF;
END $$;

-- The safety net: one active booking per seat, enforced by the DB
CREATE UNIQUE INDEX IF NOT EXISTS one_active_booking_per_seat
  ON bookings (seat_id) WHERE status = 'CONFIRMED';

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  user_id INT NOT NULL,
  request_hash TEXT NOT NULL,
  response_body JSONB,
  status_code INT,
  created_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO events (id, name, starts_at)
VALUES (1, 'The Midnight Assembly', now() + interval '30 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO seats (event_id, label, price_cents)
SELECT 1, 'A' || seat_number, 2500
FROM generate_series(1, 50) AS seat_number
ON CONFLICT (event_id, label) DO NOTHING;

SELECT setval('events_id_seq', GREATEST((SELECT MAX(id) FROM events), 1));
SELECT setval('seats_id_seq', GREATEST((SELECT MAX(id) FROM seats), 1));
