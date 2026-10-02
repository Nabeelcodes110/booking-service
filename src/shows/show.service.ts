import type { Pool } from 'pg';
import { withTransaction } from '../db/pool';
import { AppError } from '../errors';
import { DEFAULT_PER_USER_LIMIT, type CreateShowInput } from './show.schemas';
import type { SeatRow, ShowRepository, ShowRow } from './show.repository';

export interface ShowView {
  show_id: string;
  name: string;
  price_paise: number;
  per_user_limit: number;
  seats: { seat_id: string; status: 'available' | 'confirmed' }[];
  counts: { available: number; held: number; confirmed: number; total_seats: number };
}

export class ShowService {
  constructor(
    private readonly pool: Pool,
    private readonly repo: ShowRepository,
  ) {}

  /** Show row and all seat rows are written in one transaction: either the whole show exists or nothing does. */
  async createShow(input: CreateShowInput): Promise<ShowView> {
    const seatIds = [...input.seats].sort();
    return withTransaction(
      this.pool,
      async (db) => {
        const show = await this.repo.insertShow(db, {
          name: input.name,
          pricePaise: input.price_paise,
          perUserLimit: input.per_user_limit ?? DEFAULT_PER_USER_LIMIT,
        });
        await this.repo.insertSeats(db, show.id, seatIds);
        return toView(
          show,
          seatIds.map((seat_id) => ({ seat_id, reservation_id: null })),
        );
      },
    );
  }

  /**
   * Show, seats and counts are read in one REPEATABLE READ read-only transaction (one snapshot), and the
   * counts are derived from the very seat rows returned, so available + held + confirmed = total_seats
   * holds for every response even while reservations commit concurrently.
   */
  async getShow(showId: string): Promise<ShowView> {
    return withTransaction(
      this.pool,
      async (db) => {
        const show = await this.repo.findShow(db, showId);
        if (!show) throw new AppError(404, 'not_found', 'Show not found');
        return toView(show, await this.repo.listSeats(db, showId));
      },
      { isolation: 'REPEATABLE READ', readOnly: true },
    );
  }
}

function toView(show: ShowRow, seatRows: SeatRow[]): ShowView {
  const seats = seatRows.map((s) => ({
    seat_id: s.seat_id,
    status: s.reservation_id === null ? ('available' as const) : ('confirmed' as const),
  }));
  const confirmed = seats.filter((s) => s.status === 'confirmed').length;
  return {
    show_id: show.id,
    name: show.name,
    price_paise: show.price_paise,
    per_user_limit: show.per_user_limit,
    seats,
    // held is always 0: reservations confirm immediately, there are no expiring holds.
    counts: { available: seats.length - confirmed, held: 0, confirmed, total_seats: seats.length },
  };
}
