# Paytm Money: Seat Reservation at Scale

## Mission and scope
Build, deploy and operate the supplied take-home service. The running API is graded, not a polished essay or UI. Approximately one day is the intended budget. Evaluators clone the public repository, verify deployment and burst the live URL with approximately 20,000 concurrent reservations. AI assistance is expected, but Nabeel must understand and extend the code live.

Project tasks: https://app.notion.com/p/1a9c070212ae478fa929e3ba9eeb277d
Plan: https://app.notion.com/p/3ed5e2ce419181939c34ce146469754b

## Stack and boundaries
- Node.js, Express, strict TypeScript. Pin a supported runtime and dependencies; commit the lockfile. Use pg with explicit SQL transactions, Zod for validation, Pino for structured logs, prom-client for metrics and Vitest plus HTTP integration tests against real PostgreSQL.
- PostgreSQL is the only system of record for seats, reservations, quotas, idempotency and the outbox. Use migrations and parameterized SQL.
- Dockerfile and Docker Compose for API, PostgreSQL and RabbitMQ; worker may use the same application image with a separate command.
- RabbitMQ handles committed reservation/cancellation events through a transactional outbox. It does not decide who wins a seat and is not required for a reservation response. Do not return 202 for booking or send booking requests through a queue.
- Redis is optional. Introduce only after measurement for a justified non-authoritative use. Never use Redis locks, cached availability, or Redis-only idempotency as the correctness boundary.
- Keep one service plus a small event worker. No frontend, Kubernetes, external payment gateway or premature microservices.

## Product decisions
1. Reservations confirm immediately. Choose explicit owner-only cancellation, not expiring holds. API seat statuses are available or confirmed; held count remains zero.
2. Multi-seat requests are all-or-nothing. Any occupied requested seat declines the entire request with 409 and no quota consumption.
3. Default per-user limit is 4 seats per show. Allow a validated optional per_user_limit on show creation; immutable thereafter. Cancelled seats stop counting toward quota.
4. Money is integer paise. Reject non-integers, negatives, and unsafe amounts. If using SQL bigint, avoid implicit conversion to an unsafe JS number; enforce Number.MAX_SAFE_INTEGER bounds for public numeric values and totals.
5. There is no required real charge endpoint. One immutable amount is stored per reservation. State this explicitly; do not claim a real payment provider has exactly-once semantics.

## API contract
- POST /shows: admin JWT required; body name, unique nonempty seats, price_paise and optional per_user_limit. 201 returns show ID, seat states and counts. Create show and seats atomically.
- POST /shows/:id/reserve: user JWT required. Body seats and idempotency_key. Support Idempotency-Key header too if convenient; reject differing header/body keys. 201 on first successful booking, 200 on a successful replay with original reservation body and Idempotent-Replayed: true. This distinguishes one new 201 from retries. Response: reservation_id, show_id, user_id, seats, amount_paise, status=confirmed.
- POST /reservations/:id/cancel: owner only; 200 returns cancelled status. Repeating cancellation succeeds without changing quota twice. A foreign owner gets 403 (or consistently concealed 404).
- GET /shows/:id: per-seat states and counts {available, held, confirmed, total_seats}. Every response uses one database snapshot and satisfies available + held + confirmed = total_seats.
- GET /health/live: process liveness, no dependency requirement. GET /health/ready: bounded real database probe, 503 if unreachable. GET /metrics: Prometheus text exposition.
- Stable error envelope: error.code, error.message, request_id. Domain conflicts: 409 seat_taken, per_user_limit, idempotency_conflict. Validation 400, invalid/missing auth 401, forbidden 403, missing resource 404.
- JWT signature, allowed algorithm, expiration, issuer and audience are verified; user identity is verified sub only. Ignore a spoofed body user_id for identity. Admin role comes only from verified claims. Provide a local/offline development token generator and safe evaluator credentials/instructions; never expose a public arbitrary admin-token mint endpoint or signing secret.

## Database model and invariants
Use shows; show_seats with primary key (show_id, seat_id) and current reservation_id nullable; reservations with immutable owner/show/seats/amount and confirmed/cancelled lifecycle; user_show_usage with primary key (show_id, user_id) and nonnegative active_count; idempotency_requests with unique (user_id, show_id, key), canonical request fingerprint, original HTTP status and response; outbox with unique event_id; optional processed_events for consumer deduplication.
- Enforce foreign keys, uniqueness and valid lifecycle/count checks. Reference seat ownership to a reservation consistently with the same show (prefer a composite foreign key).
- Quota is a stored counter updated within the reservation/cancellation transaction, never a stale application count. Test the counter against active seat ownership.
- Canonicalize validated seats in stable sorted order. Reject duplicate labels, empty arrays, excessive lengths and oversized keys. Equal seat sets in a different input order are the same body by documented contract.
- No global show row lock for every reservation: unrelated users/seats should proceed independently.

## Atomic reservation algorithm
One PostgreSQL transaction on one checked-out pg client; every query uses that client. Release it in finally, rollback on failure. READ COMMITTED with the following locks is the baseline; document any change.
1. Validate token and input, load immutable show configuration, calculate bounded integer total and canonical fingerprint.
2. Claim idempotency row with INSERT ... ON CONFLICT DO NOTHING. Conflicting concurrent inserts wait for the first transaction. Read the committed existing row: different fingerprint => 409; matching fingerprint => replay stored outcome without booking again. New idempotency rows and final results commit together; never leave a durable pending row from an abandoned transaction.
3. Upsert the user's show_usage row then SELECT ... FOR UPDATE. Check active_count + requested seats against limit. Every reserve/cancel path acquires this quota lock before seat locks.
4. Lock requested show_seats individually in sorted seat-label order with SELECT ... FOR UPDATE, or use another demonstrably ordered equivalent. Validate all requested seats exist and are available after locking. Decline without allocation if any fail. Avoid locking every seat in the show.
5. Insert reservation; update each seat conditionally only if reservation_id IS NULL; assert exactly the requested number changed. Increment quota, persist original response, insert outbox event, then COMMIT. Return success only after commit.
6. Persist expected domain declines and their response in the idempotency row, committing without seat or quota changes. A failed key continues replaying that decline even if availability later changes; use a new key for a new attempt.
Lock order: idempotency claim → user's quota → seat labels ascending. Cancellation starts with quota → seats ascending → reservation state update. Do not acquire reservation locks before quota in another path. Demonstrate the wait graph in WRITEUP.md. Handle actual deadlock/serialization failures with bounded whole-transaction retry; never retry arbitrary failures blindly. An uncertain commit is resolved by retrying the same durable key, not allocating again with a new key.

## Cancellation safety
Read immutable reservation owner/show/seats, verify token owner, then acquire the same user's quota lock. Re-read lifecycle under serialization, lock seats ascending, and transition confirmed → cancelled once. Clear each seat ONLY WHERE reservation_id equals the cancelled reservation ID; assert ownership for first cancellation. Decrement quota once and append cancellation outbox event in the same transaction. A repeated old cancellation must not clear seats rebooked under a new reservation. A retry of the original reserve returns its original result with replay marker and never reactivates a cancelled reservation; document original-response semantics.

## Load and failures
- Correctness across processes/restarts must come from PostgreSQL, never an in-memory mutex. Hot-seat losers receive 409, never raw SQL errors.
- Use a bounded DB connection pool; do not create 20,000 connections. Keep transactions short, avoid network calls inside them, measure pool wait/locks and p95/p99 latency. A conditional failed-seat check may reduce hot-seat lock work only if final allocation still uses the transaction above.
- Healthy target burst must produce zero 5xx AND zero transport failures/timeouts, with all valid new hot-seat losers receiving 409. A 429 overload response does not pass that exact scenario. Do not relabel database outages as seat_taken.
- During database outage/partition, fail closed with readiness 503 and honest service failure; never book locally. Zero-5xx burst target assumes healthy dependencies, not arbitrary outages. Do not promise measured throughput before measurement.
- Graceful shutdown: stop accepting work, drain bounded in-flight requests, close pool/worker connections. Configure request/server/load-generator timeouts consistently and report infrastructure limits.

## RabbitMQ events
Write outbox events atomically with successful state transitions. Publish persistent messages to durable queues with publisher confirms; mark dispatched only after confirmation. A crash between confirmation and marking can duplicate delivery. Consumer deduplicates event_id in the same transaction as its demonstration projection/audit effect and acknowledges only after durable success. Include retries, bounded prefetch and dead-letter handling. Keep consumers out of seat allocation/quota changes. Broker downtime leaves events pending and booking remains available; track backlog and recovery. No exactly-once-delivery claim.

## Observability
- JSON logs: request_id/correlation ID, route template, outcome/reason, status, latency and reservation ID when useful. Validate incoming IDs or generate one. Never log JWTs, secrets or entire sensitive bodies.
- Counters: reservations_confirmed_total (new committed bookings only), reservations_cancelled_total, reservations_declined_total{reason}, idempotent_replays_total. The exercise lists idempotent-replay as a decline reason: expose that required label if needed, but document successful 200 replays separately so outcomes do not imply a new booking. Replays never increment confirmed.
- Gauge: seats_available and preferably confirmed/held/total from authoritative SQL in one snapshot at scrape time. Do not increment/decrement process-local seat gauges or serve stale cached availability.
- Durable state-transition totals derived from PostgreSQL provide restart-safe business counters; request outcome counters are process-local unless explicitly persisted. Document instance labels, resets and aggregation. Lifetime confirmation counter minus cancellation counter equals active confirmed reservations, not seats; use separate seats-confirmed/released totals for seat reconciliation.
- Request duration histogram, pool wait and usage, transaction retries, readiness failures, outbox oldest age/backlog. Avoid user/key/seat labels with unbounded cardinality. Document the show-label cardinality tradeoff.
- Alert proposals: invariant mismatch, healthy-load 5xx/transport failures, elevated latency/DB wait, DB unready, oldest outbox age, unexpected replay conflicts. Provide metric URLs and either public safe logs or a short screen recording.

## Verification and burst requirements
Use real PostgreSQL integration tests. Prove:
- 500 different users/keys storm one seat: exactly one 201, 499 seat_taken 409, no 5xx.
- One user runs 10 parallel requests on distinct seats with limit 4: at most four active seats.
- Same key concurrent identical body: one new booking, same reservation/amount on all replays; changed seats => 409. Replay after cancellation never rebooks.
- Overlapping multi-seat requests in reversed input order: all-or-nothing, no deadlock leak; failure doesn't consume quota.
- Spoofed body identity cannot act for another user; foreign cancellation fails.
- Cancel vs reserve, repeated cancellation after rebooking, process restart and crash/response-loss idempotency.
- GET and metric state reconcile during and after reserve/cancel load; exact totals, not only nonnegative counts.
- DB down readiness fails closed; RabbitMQ down booking works and events recover without duplicate effects.
Provide one-command burst taking BASE_URL, with token/admin setup instructions, configurable count/concurrency, fresh shows, hot-seat storm, limit tests, retry/body-conflict tests and cancellation/rebooking. Ramp locally then run approximately 20,000 concurrent requests live if feasible. Use a barrier and enough load-generator sockets/workers; report actual peak in-flight and distinguish 20,000 total requests from 20,000 concurrent. Print status/reason distribution, replay counts, 5xx, transport failures, latency percentiles and final reconciliation. Poll state during load. Exit nonzero on violated assertions. Record exact command/configuration/environment/results; do not substitute a smaller test silently.

## Deployment and deliverables
- Public Git repo, incremental honest commits; never fabricate or backdate history.
- Multi-stage Docker image with non-root runtime, pinned tooling, npm ci, health configuration; Compose includes reproducible migrations and dependency healthchecks. .env.example contains placeholders only.
- Public API and reachable PostgreSQL; provision RabbitMQ as a separate worker dependency. Free-tier suitability is a measured constraint, not an assumption. Document cold start, migration order, TLS, secrets and connection budgets. Avoid destructive seed/reset on startup.
- Run clean checkout build, lint/typecheck/tests, Compose startup, live smoke and live burst; preserve evidence. README includes API examples, token acquisition, local run, burst, live URL, metrics/log access and limitations.
- WRITEUP.md: exact atomic mechanism/lock order, idempotency scope and response semantics, cancellation, partition tradeoff, 2am alerts, directed versus agent-decided AI usage and next steps. Keep it short and technically defensible.

## Agent working rules
Claim one Notion task and follow dependencies. Read existing repository conventions before editing. Keep handlers thin and transaction code centralized. Never weaken constraints to make a test pass. Add meaningful tests for correctness boundaries. Record checks, changed files, commit and remaining limitations when completing a task. Do not report tests/deployment/load results you did not run. Explain SQL and tradeoffs to Nabeel; leave code suitable for a live interview extension. Prioritize correctness, observable live deployment and evidence over optional infrastructure sophistication.

Reference documentation: https://www.postgresql.org/docs/17/explicit-locking.html ; https://www.rabbitmq.com/docs/confirms ; https://www.rabbitmq.com/docs/reliability
