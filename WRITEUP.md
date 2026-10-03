# WRITEUP

## 1. The atomic decision

**Mechanism:** one PostgreSQL transaction on one pooled client (`withTransaction`, READ COMMITTED). Who gets a seat is decided by a row lock.

Reserve, in order (`ReservationService.reserve`):

1. **Load the show.** Read price and per-user limit. These never change, so no lock is needed.
2. **Claim the idempotency key.** `INSERT ... ON CONFLICT DO NOTHING`. If the same key is already in progress, wait for it and return its result instead of booking again.
3. **Lock the user's quota row.** Upsert the user's `user_show_usage` row, then `SELECT ... FOR UPDATE`. If `active_count + requested > limit`, decline with 409 `per_user_limit`.
4. **Lock the requested seats in sorted order.** `SELECT ... FROM show_seats WHERE show_id=$1 AND seat_id = ANY($2) ORDER BY seat_id COLLATE "C" FOR UPDATE`. If any seat is missing or already booked, decline the whole request with 409 `seat_taken`. Nothing is allocated and no quota is used.
5. **Book and commit.** Insert the reservation, then `UPDATE show_seats SET reservation_id = $r WHERE ... AND reservation_id IS NULL` and check that exactly the requested number of rows changed (otherwise roll back). Increase the quota counter, store the response on the idempotency row, and COMMIT. Success is returned only after the commit.

**Why it is race-free:** two requests for the same seat both need that seat row's lock.The second blocks until the first
commits or rolls back, then sees `reservation_id` set and declines. Even without the lock, the conditional `UPDATE ... WHERE reservation_id IS NULL`
plus the row-count assertion would refuse a double allocation. A composite foreign key `(reservation_id, show_id)` also stops a seat
pointing at a reservation of a different show. Nothing depends on in-process state, so it holds across processes and restarts.

**Deadlock free:** a deadlock is two requests each holding something the other needs, so both wait forever.
Imagine Alice asks for seats `[S2, S1]` and Bob asks for `[S1, S2]` at the same moment. If each request locked seats in the order the client sent them:

```
Alice: lock S2 (ok)        Bob: lock S1 (ok)
Alice: lock S1 -> waits for Bob
Bob:   lock S2 -> waits for Alice     <- each waits for the other: deadlock
```

The fix is in step 4 of the flow above: `lockSeats` sorts the labels (`ORDER BY seat_id COLLATE "C"`) and locks them in a single statement, so both requests ask for `S1` first, then `S2`:

```
Alice: lock S1 (ok), then S2 (ok), commit
Bob:   lock S1 -> waits for Alice's commit, then lock S2 -> sees it taken or free, decides
```

Whoever gets `S1` first wins the queue and the other simply waits its turn. Nobody ever holds a lock the first one needs, so no cycle can form.

**Multi-seat and deadlock:** every request takes locks in the same global order: **idempotency claim → user's quota row → seats in ascending label order**.
The seats are locked in one statement with `ORDER BY seat_id COLLATE "C"`, so the order does not depend on the database collation or on the order
the client listed them. Two overlapping requests in opposite input orders therefore queue behind each other instead of waiting in a cycle.
Cancellation uses the same order (quota → seats → reservation update) and never locks a reservation row before the quota row.

Wait graph for two overlapping requests, A wanting [S2, S1] and B wanting [S1, S2] (both normalised to S1, S2):

```
A: holds quota(A) -> locks S1 -> wants S2
B: holds quota(B) -> wants S1 (waits for A)      B waits on A only; A never waits on B => no cycle
```

If PostgreSQL still reports a deadlock (`40P01`) or serialization failure (`40001`), the whole transaction is re-run, at most 3 attempts.
Every other error rolls back and propagates. It is never retried blindly.

## 2. Idempotency

- **Where the key lives:** `idempotency_requests`, primary key `(user_id, show_id, key)`. The scope is one user and one show, so two users can use the same key string independently.
- **How one booking is enforced:** the first step of the transaction is `INSERT ... ON CONFLICT DO NOTHING`. A concurrent request with the same key blocks on that unique index until the first transaction ends, then reads the committed row. The claim, the booking and the stored response commit together, so a crashed request leaves no durable "pending" row.
- **Same key, same body:** the stored status and response are replayed: `200` with `Idempotent-Replayed: true` and the original reservation body. The first success was `201`.
- **Same key, different body:** the request is fingerprinted (SHA-256 of the show and the **sorted** seats, so the same seats in a different order are the same body). A different fingerprint returns 409 `idempotency_conflict`.
- **Declines are stored too:** a `seat_taken` or `per_user_limit` decline is committed on the key. That key keeps replaying the decline even if the seat frees up later. A new attempt needs a new key.
- **After cancellation:** retrying the original reserve key returns the original reservation and never reactivates it (a trigger also forbids `cancelled → confirmed`).
- **What "exactly once" means here:** exactly one booking effect per key in PostgreSQL. It does not mean exactly-once message delivery or a payment gateway guarantee. An uncertain commit (client never saw the response) is resolved by retrying the same key.

## 3. Holds and expiry

There are no holds and no expiry. Reservations confirm immediately and are released only by an explicit, owner-only cancellation (as per description). API seat statuses are `available` or `confirmed`, and `held` is always 0. This removes a whole class of timer and sweeper races. 

## 4. Consistency versus availability under a partition

The service chooses **consistency**. PostgreSQL is the only source of truth for seats, quota and idempotency. If the database is unreachable the service does not
book locally, from a cache, or through a queue. Requests fail with an honest error and readiness should report 503. The cost is that
a partition makes booking unavailable. The benefit is that no seat can ever be sold twice. A message broker, when added, must not decide who wins a seat.

## 5. Observability: what would page me at 2am
- Reconciliation mismatch: any show where available + held + confirmed ≠ total, or the stored quota counter ≠ active seats.
- 5xx rate or transport failures above zero during normal load.
- p95/p99 latency, or time waiting for a database connection, climbing.
- Database readiness failing.
- A spike in `idempotency_conflict`, meaning clients are reusing keys with different bodies.

## 6. AI usage

- Directed by me: Tech stack, project stucture, Tasks breakdown, architecture.
- Decided by the AI agent: Atomic mechanism (reviewed the code line by line with full understanding and tested the functionality), burst script.

## 7. Measured results so far

- A burst of 20,000 requests with 1,000 sockets against the first instance failed: 502s and the instance reported failure (resource limits). Cause was CPU outage.
- After upgrading, a run of 8,000 hot-seat requests plus the max, retry and cancel scenarios with **700 concurrent sockets** passed all assertions: 0 × 5xx, 0 transport failures, 1 × 201 and 7,999 × 409 `seat_taken` on the hot seat, about 210 req/s during the burst.

