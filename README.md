# Booking Service

Seat reservation API (Node.js, Express, TypeScript, PostgreSQL). Live deployment: https://booking-service-83x6.onrender.com

## Running the burst test

`npm run burst` fires a load test at the service and checks that the results are correct. It is the same
script for local and live runs; it defaults to the live URL above.

### What it does

1. Creates fresh shows through the public API (safe to re-run; nothing is reset or deleted).
2. Releases everything at once from one barrier:
   - **Hot-seat storm:** `--count` different users all try to book the same single seat. Exactly one gets 201, the rest get 409 `seat_taken`.
   - **Per-user limit:** each of `--limit-users` users requests 10 seats in parallel. Each gets 4 x 201 and 6 x 409 `per_user_limit`.
   - **Retries:** for each of `--retry-groups` users, `--retry-size` identical requests (plus one with the seats in reverse order) share one idempotency key. Exactly one 201, the rest 200 replays. A later request with the same key and different seats must return 409 `idempotency_conflict`.
3. While that runs, a poller reads the seat chart and checks available + held + confirmed = total in every snapshot.
4. Cancel / rebook checks: foreign cancel (403), repeated cancels, rebooking a freed seat, a stale cancel, and replaying the cancelled booking's key.
5. Final reconciliation of every show, then a report.

### Setup

1. `npm ci`
2. Set `JWT_SECRET` to the **same secret the target service uses** (at least 32 characters). The script mints its own admin and user tokens with it. For the live service, use the secret configured on Render. For a local run, use your local one. You can put it in `.env`; `npm run burst` loads `.env` automatically.

### Run

```powershell
# live service (default URL)
$env:JWT_SECRET = "<secret used by the service>"
npm run burst -- --count 2000 --sockets 500 --timeout-ms 60000

# local service
$env:BASE_URL = "http://localhost:3100"
$env:JWT_SECRET = "<local secret>"
npm run burst -- --count 500 --sockets 100
```

Start small and ramp up (for example 500, 2000, 5000), moving on only while the run passes. Save the output with
`npm run burst -- --count 2000 --sockets 500`.

### Flags

Every flag has an environment-variable equivalent. If both are given, the flag wins. All numeric values must be whole numbers of at least 1.

| Flag | Env var | Default | What it means |
|---|---|---|---|
| `--base-url` | `BASE_URL` | `https://booking-service-83x6.onrender.com` | Address of the service to test. Trailing slashes are ignored. |
| `--count` | `COUNT` | `500` | Size of the hot-seat storm: how many different users try to book the same one seat at the same moment. |
| `--sockets` | `SOCKETS` | smaller of `--count` and `1000` | Most connections open at once from the test machine. This is the real concurrency. Requests beyond it wait in a queue inside the test. |
| `--timeout-ms` | `TIMEOUT_MS` | `30000` | How long one request may wait for an answer before the test gives up. A give-up counts as a transport failure and fails the run. |
| `--limit-users` | `LIMIT_USERS` | `20` | Number of users testing the per-user limit (4 seats per show by default). Each gets its own show. |
| `--retry-groups` | `RETRY_GROUPS` | `20` | Number of independent idempotency tests, each with its own show, user and key. |
| `--retry-size` | `RETRY_SIZE` | `10` | How many identical same-key requests each retry group sends at once. Only one may create a booking. |
| `--poll-ms` | `POLL_MS` | `100` | Pause between the background seat-chart checks that run during the burst. |

Environment-only settings:

| Env var | Default | What it means |
|---|---|---|
| `JWT_SECRET` | none (required) | Signing secret, at least 32 characters, same as the target service. Used to mint test tokens. Never commit it. |
| `JWT_ISSUER` | `booking-service` | Token issuer claim. Must match the service. |
| `JWT_AUDIENCE` | `booking-api` | Token audience claim. Must match the service. |

The phase-1 burst sends `count + limit-users x 10 + retry-groups x (retry-size + 1)` requests. With the defaults that is 500 + 200 + 220 = 920.

### Reading the report

- **THROUGHPUT:** requests per second during the phase-1 burst, and over the whole run.
- **peak in-flight / peak on-the-wire:** in-flight counts requests submitted and not yet answered; on-the-wire counts those holding a socket. Concurrency is the on-the-wire figure, capped by `--sockets`. Quote it that way; 20,000 total requests is not 20,000 concurrent.
- **status / reason distribution:** every response type seen, such as `201`, `409 seat_taken`, `502 no_error_code`. `no_error_code` means the body was not the service's JSON error envelope, so the response came from a proxy or platform and not the application.
- **5xx / transport failures:** both must be 0 for a healthy run. A 429 also fails the run.
- **latency:** p50, p95, p99 and max in milliseconds, both from submission and from socket assignment.
- **RESULT:** `PASS` or `FAIL (n violations)`.

Exit codes: `0` all assertions passed, `1` at least one assertion failed, `2` bad arguments or setup failure (for example the service was unreachable or returned 5xx while creating a show).

### Notes and limits

- A run against the live service reflects that instance's CPU, memory and database connection limits. Record the instance size alongside any result.
- Results depend on the machine and network running the test as well as on the service.
