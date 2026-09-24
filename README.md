# Seat Booking Engine

A production-minded seat booking demo focused on one hard problem: preventing double-bookings when many users request the same seat at the same time.

The project uses Redis for fast, temporary seat holds and PostgreSQL as the final source of truth. Even if Redis loses a hold or two requests arrive at the same time, PostgreSQL's unique index prevents more than one confirmed booking for a seat.

## What It Demonstrates

- Atomic multi-seat holds with Redis Lua scripts
- Five-minute hold expiration through Redis TTL
- PostgreSQL transactions and a partial unique index
- Idempotent booking confirmation with `Idempotency-Key`
- Redis fixed-window rate limiting
- Race-condition tests with 100 concurrent requests
- A small React seat-map UI
- Docker Compose local infrastructure
- A k6 load-test scenario for heavy contention

## Architecture

```text
React seat map
      |
      v
Express + TypeScript API
      |--------------------> Redis
      |                       - atomic holds
      |                       - TTL expiration
      |                       - rate limiting
      |
      +--------------------> PostgreSQL
                              - events and seats
                              - confirmed bookings
                              - unique booking constraint
                              - idempotency records
```

### Booking flow

1. A client requests one or more seats.
2. Redis checks every seat and creates all holds atomically, or creates none.
3. The client confirms the hold with an idempotency key.
4. The API verifies that the hold belongs to the requesting user.
5. PostgreSQL inserts the confirmed bookings inside a transaction.
6. The database unique index rejects any duplicate booking.
7. The idempotency response is stored and the Redis hold is released.

Redis handles speed and temporary state. PostgreSQL decides whether a booking is valid.

## Technology

| Layer | Technology |
| --- | --- |
| API | Node.js, TypeScript, Express |
| Database | PostgreSQL 16 |
| Cache and holds | Redis 7 |
| Frontend | React, Vite, TypeScript |
| Tests | Jest, supertest |
| Load testing | k6 |
| Infrastructure | Docker Compose |

## Run Locally

### Prerequisites

- Node.js 22 or newer
- Docker Desktop
- npm
- k6 is optional and only needed for the load test

### 1. Install dependencies

From the project root:

```powershell
npm install
npm --prefix web install
```

### 2. Start PostgreSQL and Redis

```powershell
docker compose up -d postgres redis
```

The local infrastructure ports are intentionally separated from common existing services:

- PostgreSQL: `localhost:15432`
- Redis: `localhost:16379`

### 3. Configure the environment

The repository includes a local `.env` configured for these ports. To create it manually:

```powershell
Copy-Item .env.example .env
```

### 4. Create the database schema

```powershell
npm run db:migrate
```

This creates the tables, constraints, indexes, event `1`, and 50 demo seats. The migration is safe to run again.

### 5. Start the API and frontend

```powershell
npm run dev
```

Open the UI at:

```text
http://localhost:5173
```

The API runs at:

```text
http://localhost:3001
```

Port `3001` is used because port `3000` may be occupied by another local application.

## Try the UI

1. Open `http://localhost:5173`.
2. Select an available seat.
3. Enter an email address.
4. Click **Reserve**.
5. The selected seat should become booked.

## Try the API

All booking requests use the demo header `x-user-id` as simple authentication.

### Health check

```powershell
Invoke-RestMethod http://127.0.0.1:3001/health
```

### Get the seat map

```powershell
Invoke-RestMethod http://127.0.0.1:3001/events/1/seats
```

Each seat contains an `id`, `label`, `priceCents`, and one of these statuses:

- `available`
- `held`
- `booked`

### Create a hold

```powershell
$hold = Invoke-RestMethod `
  -Uri http://127.0.0.1:3001/events/1/holds `
  -Method Post `
  -Headers @{ "x-user-id" = "7" } `
  -ContentType "application/json" `
  -Body '{"seatIds":[2]}'

$hold
```

The response includes a `holdId`. Holds expire after five minutes.

### Confirm a booking

```powershell
$body = @{
  eventId = 1
  seatIds = @(2)
  holdId = $hold.holdId
  email = "test@example.com"
} | ConvertTo-Json

Invoke-RestMethod `
  -Uri http://127.0.0.1:3001/bookings `
  -Method Post `
  -Headers @{
    "x-user-id" = "7"
    "Idempotency-Key" = "booking-test-1"
  } `
  -ContentType "application/json" `
  -Body $body
```

Send the same request again with the same `Idempotency-Key`. It returns the original booking response instead of creating a second booking.

### Release a hold

```powershell
Invoke-WebRequest `
  -Uri http://127.0.0.1:3001/holds/$($hold.holdId) `
  -Method Delete `
  -Headers @{ "x-user-id" = "7" } `
  -ContentType "application/json" `
  -Body '{"eventId":1,"seatIds":[2]}'
```

### Cancel a booking

```powershell
Invoke-WebRequest `
  -Uri http://127.0.0.1:3001/bookings/1 `
  -Method Delete `
  -Headers @{ "x-user-id" = "7" }
```

## Test Race Conditions

Run the automated tests:

```powershell
npm test
```

The suite covers:

1. The same user sends 100 hold requests for the same seat. Exactly one succeeds.
2. 100 confirmations compete for the same held seat. Exactly one booking succeeds.
3. Reusing an idempotency key returns the same response.
4. An expired hold makes the seat available again.
5. Losing Redis state cannot bypass database booking protection.
6. Booking without a valid hold returns a conflict.

Expected result:

```text
Test Suites: 1 passed
Tests: 6 passed
```

The tests are in [tests/booking-race.test.ts](tests/booking-race.test.ts).

## Load Test With k6

Start the API, then run:

```powershell
k6 run load/k6.js
```

The scenario sends 500 hold attempts per second for 30 seconds against 50 seats. It records request latency and success/conflict behavior under heavy contention.

After the test, verify that there are no duplicate confirmed bookings:

```sql
SELECT seat_id, COUNT(*)
FROM bookings
WHERE status = 'CONFIRMED'
GROUP BY seat_id
HAVING COUNT(*) > 1;
```

This query must return zero rows.

## Build and Production Start

Build the API and frontend:

```powershell
npm run build
```

Start the compiled API:

```powershell
npm start
```

Run the lightweight worker entry point if needed:

```powershell
npm run worker
```

Redis TTL expiration is automatic, so the worker is reserved for future metrics and reconciliation work rather than hold cleanup.

## Project Structure

```text
booking Engine/
├── src/
│   ├── app.ts                 API routes and validation
│   ├── server.ts              API startup and dependency wiring
│   ├── redis-holds.ts         Redis Lua holds and rate limiting
│   ├── postgres-bookings.ts   PostgreSQL transactions and idempotency
│   ├── types.ts               Shared TypeScript contracts
│   └── worker.ts               Worker entry point
├── scripts/
│   └── migrate.ts             Database migration runner
├── tests/
│   └── booking-race.test.ts   Concurrency and lifecycle tests
├── web/
│   └── src/main.tsx           React seat-map UI
├── load/
│   └── k6.js                  Load-test scenario
├── schema.sql                 PostgreSQL schema and demo seed
├── docker-compose.yml         PostgreSQL and Redis services
└── README.md                  Project documentation
```

## Concurrency Design Comparison

| Design | Protection | Result under contention |
| --- | --- | --- |
| Naive check-then-insert | None | Can double-book |
| Database-only | Unique index | One booking wins; others get `409 Conflict` |
| Optimistic locking | Version and retry | Correct, but adds retry work |
| Final design | Atomic Redis holds plus PostgreSQL constraint plus idempotency | Fast holds, one confirmed booking, safe retries |

## Stop Local Services

Stop the API and frontend terminals, then stop Docker services:

```powershell
docker compose down
```

The PostgreSQL data volume is preserved unless you explicitly remove it.
