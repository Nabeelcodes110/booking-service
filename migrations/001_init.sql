-- Core schema. PostgreSQL is the only system of record for seats, reservations,
-- quota, idempotency and the outbox. Money is integer paise stored as bigint.

-- A show: immutable configuration (price, per-user limit) read by every reservation.
CREATE TABLE shows (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  price_paise    bigint NOT NULL CHECK (price_paise BETWEEN 1 AND 1000000000),
  per_user_limit integer NOT NULL DEFAULT 4 CHECK (per_user_limit BETWEEN 1 AND 100),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- A booking. Owner, show, seats and amount never change; only status confirmed -> cancelled does
-- (enforced by the trigger further down). One reservation can cover several seats.
CREATE TABLE reservations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  show_id      uuid NOT NULL REFERENCES shows (id),
  user_id      text NOT NULL CHECK (char_length(user_id) BETWEEN 1 AND 128),
  seats        text[] NOT NULL CHECK (cardinality(seats) BETWEEN 1 AND 10),
  -- 9007199254740991 = Number.MAX_SAFE_INTEGER
  amount_paise bigint NOT NULL CHECK (amount_paise BETWEEN 1 AND 9007199254740991),
  status       text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  -- A cancelled reservation must have a cancellation time; a confirmed one must not.
  CHECK ((status = 'confirmed' AND cancelled_at IS NULL) OR (status = 'cancelled' AND cancelled_at IS NOT NULL)),
  -- Target for the composite FK from show_seats: a seat may only point at a reservation of the SAME show.
  UNIQUE (id, show_id)
);
CREATE INDEX reservations_user_idx ON reservations (user_id, show_id);

-- One row per physical seat of a show. reservation_id NULL = available, set = confirmed.
-- This is the row that reserve locks (SELECT ... FOR UPDATE, ascending seat_id) to decide who wins a seat.
CREATE TABLE show_seats (
  show_id        uuid NOT NULL REFERENCES shows (id),
  seat_id        text NOT NULL CHECK (char_length(seat_id) BETWEEN 1 AND 32),
  reservation_id uuid,
  -- Composite key: the same seat label can exist in different shows, never twice in one show.
  PRIMARY KEY (show_id, seat_id),
  -- MATCH SIMPLE: not enforced while reservation_id IS NULL (seat available).
  FOREIGN KEY (reservation_id, show_id) REFERENCES reservations (id, show_id)
);
-- Lets cancellation find the seats of a reservation without scanning the table.
CREATE INDEX show_seats_reservation_idx ON show_seats (reservation_id) WHERE reservation_id IS NOT NULL;

-- Stored per-user quota counter: how many seats this user currently holds in this show.
-- Reserve and cancel lock this row FIRST (before any seat row), so a user's own requests are serialized
-- and the limit check never reads a stale application-side count. Cancelled seats are subtracted.
CREATE TABLE user_show_usage (
  show_id      uuid NOT NULL REFERENCES shows (id),
  user_id      text NOT NULL,
  -- The counter can never go negative, even if a bug decrements twice.
  active_count integer NOT NULL DEFAULT 0 CHECK (active_count >= 0),
  PRIMARY KEY (show_id, user_id)
);

-- Durable idempotency record: one row per (user, show, key). It stores a fingerprint of the request body
-- and, once finished, the original HTTP status and response so a retry replays it instead of booking again.
CREATE TABLE idempotency_requests (
  user_id        text NOT NULL,
  show_id        uuid NOT NULL REFERENCES shows (id),
  key            text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 128),
  -- SHA-256 hex of the canonical request (sorted seats). Same key + different fingerprint = 409 conflict.
  fingerprint    text NOT NULL CHECK (char_length(fingerprint) = 64),
  -- NULL status/response only exist inside the claiming transaction; they commit together with the outcome,
  -- so a crashed request never leaves a durable "pending" row.
  status_code    integer CHECK (status_code BETWEEN 200 AND 599),
  response       jsonb,
  reservation_id uuid REFERENCES reservations (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- The uniqueness that makes two concurrent requests with the same key collide: the second waits for the first.
  PRIMARY KEY (user_id, show_id, key),
  -- Status and response are either both present or both absent.
  CHECK ((status_code IS NULL) = (response IS NULL))
);

-- Consumer-side deduplication: the consumer inserts (consumer, event_id) in the same transaction as its own
-- effect. A duplicate delivery hits the primary key and is skipped, so the effect happens once.
CREATE TABLE processed_events (
  consumer     text NOT NULL,
  event_id     uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

-- Immutability guards.
-- Why triggers: CHECK constraints can only look at the new row, not compare it with the old one. A trigger
-- sees both OLD and NEW, so it can say "this column may not change". Doing it in the database means no code
-- path (a future endpoint, a script, a manual UPDATE) can silently rewrite the price, owner, seats or amount

-- A trigger function runs automatically before each UPDATE (see CREATE TRIGGER below it) and either raises
-- an error (the UPDATE fails) or returns NEW (the UPDATE proceeds).
CREATE FUNCTION shows_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- IS DISTINCT FROM is a NULL-safe "not equal".
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.price_paise IS DISTINCT FROM OLD.price_paise
     OR NEW.per_user_limit IS DISTINCT FROM OLD.per_user_limit THEN
    RAISE EXCEPTION 'shows are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shows_immutable_trg BEFORE UPDATE ON shows FOR EACH ROW EXECUTE FUNCTION shows_immutable();

-- Reservations: identity fields are frozen; the only allowed change is the status/cancelled_at transition,
-- and a cancelled reservation can never go back to confirmed (a replayed old key must not rebook).
CREATE FUNCTION reservations_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.show_id IS DISTINCT FROM OLD.show_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.seats IS DISTINCT FROM OLD.seats
     OR NEW.amount_paise IS DISTINCT FROM OLD.amount_paise OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'reservation owner, show, seats and amount are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'cancelled' AND NEW.status IS DISTINCT FROM 'cancelled' THEN
    RAISE EXCEPTION 'a cancelled reservation cannot be reactivated' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reservations_immutable_trg BEFORE UPDATE ON reservations FOR EACH ROW EXECUTE FUNCTION reservations_immutable();
