import type { PoolClient } from 'pg';
import { toSafeInt } from '../db/pool';

export interface ShowRow {
  id: string;
  name: string;
  price_paise: number;
  per_user_limit: number;
}

export interface SeatRow {
  seat_id: string;
  reservation_id: string | null;
}

/** SQL only. Takes the caller's transaction client so the service decides transaction boundaries. */
export class ShowRepository {
  async insertShow(
    db: PoolClient,
    show: { name: string; pricePaise: number; perUserLimit: number },
  ): Promise<ShowRow> {
    const { rows } = await db.query<{ id: string; name: string; price_paise: string; per_user_limit: number }>(
      `INSERT INTO shows (name, price_paise, per_user_limit)
       VALUES ($1, $2, $3)
       RETURNING id, name, price_paise, per_user_limit`,
      [show.name, show.pricePaise, show.perUserLimit],
    );
    return toShowRow(rows[0]!);
  }

  /** One statement inserts every seat; with the show insert in the same transaction, both commit or neither. */
  async insertSeats(db: PoolClient, showId: string, seatIds: string[]): Promise<void> {
    await db.query(
      `INSERT INTO show_seats (show_id, seat_id)
       SELECT $1, unnest($2::text[])`,
      [showId, seatIds],
    );
  }

  async findShow(db: PoolClient, showId: string): Promise<ShowRow | null> {
    const { rows } = await db.query<{ id: string; name: string; price_paise: string; per_user_limit: number }>(
      'SELECT id, name, price_paise, per_user_limit FROM shows WHERE id = $1',
      [showId],
    );
    return rows[0] ? toShowRow(rows[0]) : null;
  }

  async listSeats(db: PoolClient, showId: string): Promise<SeatRow[]> {
    const { rows } = await db.query<SeatRow>(
      'SELECT seat_id, reservation_id FROM show_seats WHERE show_id = $1 ORDER BY seat_id',
      [showId],
    );
    return rows;
  }
}

function toShowRow(r: { id: string; name: string; price_paise: string; per_user_limit: number }): ShowRow {
  return { id: r.id, name: r.name, price_paise: toSafeInt(r.price_paise), per_user_limit: r.per_user_limit };
}
