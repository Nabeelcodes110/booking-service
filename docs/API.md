# API contracts and architecture (T01)

Source of truth for behaviour is `CLAUDE.md`; this file pins the wire contract so tests, the burst tool and README examples agree.

## Decisions

- Reservations confirm immediately (no holds). Cancellation is explicit and owner-only. Seat status is `available` or `confirmed`; `held` is always 0.
- Multi-seat requests are all-or-nothing: any occupied seat declines the whole request (409, no quota used).
- Per-user limit per show: default 4, optional `per_user_limit` at show creation, immutable. Cancelled seats stop counting.
- Money is integer paise. One immutable `amount_paise` per reservation (`price_paise * seats`). No payment provider is involved, so no exactly-once payment claim is made.
- PostgreSQL is the only system of record. RabbitMQ only carries committed events (transactional outbox) and never decides a seat.
- Seats are canonicalised to sorted, unique order. Two requests with the same seat set in a different order are the same body.

## Integer bounds

`price_paise`: integer, `1 <= n <= 1_000_000_000` (public, safe). `amount_paise = price_paise * seats.length` must be `<= Number.MAX_SAFE_INTEGER`; otherwise 400. Rejected: floats, strings, negatives, zero, NaN/Infinity. Money columns are `bigint`; they are parsed from SQL strings and range-checked, never implicitly converted.

Other limits: seats per show <= 10000, seats per reserve request <= 10, seat label 1-32 chars `[A-Za-z0-9_-]`, show name 1-200 chars, `idempotency_key` 1-128 chars `[A-Za-z0-9._:-]`, `per_user_limit` 1-100, JSON body <= 64 KB (larger -> 413 `payload_too_large`).

## Auth

`Authorization: Bearer <JWT>`. Verified: signature, algorithm (HS256 only), `exp`, `iss`, `aud`. User identity is `sub` only; any `user_id` in a body is ignored. Admin = verified `role` claim equal to `admin`. Tokens are minted offline by `npm run token` (T04); there is no mint endpoint. Missing/invalid token -> 401 `unauthorized`; valid user token on an admin route -> 403 `forbidden`.

## Error envelope

```json
{ "error": { "code": "seat_taken", "message": "One or more seats are not available" }, "request_id": "..." }
```

`request_id` echoes a valid incoming `X-Request-Id` (<=64 chars `[A-Za-z0-9._-]`) or is generated, and is also returned as a header.

| Status | code | When |
|---|---|---|
| 400 | `validation_error` | Bad body/params, header/body idempotency key mismatch, bounds |
| 401 | `unauthorized` | Missing/invalid/expired token |
| 403 | `forbidden` | Not admin / not reservation owner |
| 404 | `not_found` | Show or reservation missing |
| 409 | `seat_taken` | Any requested seat occupied or not on the show |
| 409 | `per_user_limit` | `active_count + requested > limit` |
| 409 | `idempotency_conflict` | Same user+show+key, different canonical body |
| 413 | `payload_too_large` | Body > 64 KB |
| 500 | `internal_error` | Unexpected failure (never raw SQL text) |
| 503 | `unavailable` | DB unreachable / pool timeout / shutting down (fail closed) |

A seat label that does not exist on the show is treated like an unavailable seat: 409 `seat_taken`, stored as a decline (CLAUDE.md: validate existence and availability after locking, decline the whole request otherwise).

## Endpoints

### POST /shows (admin)

```json
{ "name": "Evening show", "seats": ["A1","A2","A3"], "price_paise": 25000, "per_user_limit": 4 }
```
`201`:
```json
{ "show_id": "uuid", "name": "Evening show", "price_paise": 25000, "per_user_limit": 4,
  "seats": [{"seat_id":"A1","status":"available"}],
  "counts": {"available":3,"held":0,"confirmed":0,"total_seats":3} }
```
Show and seats are created in one transaction. Duplicate or empty seats -> 400.

### POST /shows/:id/reserve (user)

Body `{ "seats": ["A2","A1"], "idempotency_key": "k-123" }`. Optional `Idempotency-Key` header; if both present and different -> 400.

- First success: `201`
  ```json
  { "reservation_id":"uuid","show_id":"uuid","user_id":"sub","seats":["A1","A2"],
    "amount_paise":50000,"status":"confirmed" }
  ```
- Replay of same key + same canonical body: `200`, identical stored body, header `Idempotent-Replayed: true`. The original outcome is replayed even if the reservation was later cancelled, and a cancelled reservation is never re-activated; use a new key to book again.
- Stored declines (`seat_taken`, `per_user_limit`) are replayed with their original 409 and the replay header; a new attempt needs a new key.
- Same key, different seats -> 409 `idempotency_conflict`.
- Idempotency scope: `(user_id, show_id, key)`. Fingerprint = SHA-256 of canonical JSON `{show_id, seats(sorted)}`.
- Validation (400), auth (401), missing show (404) are not stored.

### POST /reservations/:id/cancel (owner)

`200 { "reservation_id":"uuid","show_id":"uuid","status":"cancelled" }`. Repeating returns 200 without touching quota or seats. A non-owner gets 403. Missing reservation -> 404.

### GET /shows/:id

`200` with the same shape as the create response (without admin fields), `seats[].status` in `available|confirmed`, counts from a single snapshot (`REPEATABLE READ`, read-only) so `available + held + confirmed = total_seats`. Public; no auth needed. Missing -> 404.

### Operational

- `GET /health/live` -> 200 `{status:"ok"}`, no dependencies.
- `GET /health/ready` -> 200 after a bounded (<=1 s) `SELECT 1`; 503 otherwise.
- `GET /metrics` -> Prometheus text.

## Lock order and failure semantics

Reserve: idempotency claim -> user quota row (`FOR UPDATE`) -> seat rows in ascending label order (`FOR UPDATE`) -> insert reservation / update seats / bump quota / save response / outbox -> COMMIT.
Cancel: quota row -> seat rows ascending -> reservation state update. Reservation rows are never locked before quota.

- READ COMMITTED baseline; deadlock (`40P01`) and serialization (`40001`) failures retry the whole transaction a bounded number of times (3), nothing else is retried blindly.
- Uncertain commit: the client retries the same idempotency key, never a new key.
- DB outage: readiness 503, reserve/cancel return 503 `unavailable`; never booked locally and never reported as `seat_taken`.
- Hot-seat losers get 409 `seat_taken`; no 429 shedding in the healthy burst scenario.
- Broker outage does not affect booking; outbox rows stay pending.

## Architecture

One Express service plus a small event worker (same image, different command). `routes -> thin handlers -> src/db transaction module`. All reserve/cancel SQL lives in one transactions module. Bounded `pg.Pool` (default 20). Pino JSON logs; prom-client metrics with SQL-derived seat gauges at scrape time.
