import { supabase, dbTable } from "../../lib/supabase";
import { todayUTC, futureDateUTC } from "../../lib/dates";
import { withDbErrorCapture } from "../../lib/errorReporting";

// ─── Types ───────────────────────────────────────────────────────────────────

export type InjuryStatus =
  | "out"
  | "doubtful"
  | "questionable"
  | "probable"
  | "returned";

export interface InjuryWithPlayer {
  injury_id: string;
  player_id: string;
  injury_type: string;
  injury_type_slug: string;
  injury_description: string | null;
  date_injured: string;
  expected_recovery_range: string | null;
  expected_return_date: string | null;
  status: InjuryStatus;
  back_in_play_players: {
    player_id: string;
    player_name: string;
    slug: string;
    position: string | null;
    back_in_play_teams: {
      team_id: string;
      team_name: string;
      back_in_play_leagues: {
        league_id: string;
        league_name: string;
        slug: string;
      };
    };
  };
}

// ─── Shared select fragment ───────────────────────────────────────────────────

const INJURY_SELECT = `
  injury_id,
  player_id,
  injury_type,
  injury_type_slug,
  injury_description,
  date_injured,
  expected_recovery_range,
  expected_return_date,
  status,
  back_in_play_players (
    player_id,
    player_name,
    slug,
    position,
    back_in_play_teams (
      team_id,
      team_name,
      back_in_play_leagues (
        league_id,
        league_name,
        slug
      )
    )
  )
`.trim();

// ─── Repository functions ─────────────────────────────────────────────────────

/**
 * Fetch the most recently reported injuries across all leagues,
 * ordered by date_injured descending.
 */
export async function getLatestInjuries(limit = 10): Promise<InjuryWithPlayer[]> {
  const { data, error } = await withDbErrorCapture(
    supabase
      .from(dbTable("injuries"))
      .select(INJURY_SELECT)
      .order("date_injured", { ascending: false })
      .limit(limit),
    "injuriesRepo.getLatestInjuries",
  );

  if (error) throw error;
  return (data ?? []) as unknown as InjuryWithPlayer[];
}

/**
 * Fetch one current (non-returned) injury per player, using the
 * current_injuries view (DISTINCT ON player_id ordered by date_injured DESC).
 * Falls back to client-side deduplication if the view join cannot be resolved.
 */
export async function getCurrentlyInjured(limit = 10): Promise<InjuryWithPlayer[]> {
  // Query from the current_injuries view — PostgREST resolves FK joins through
  // view columns when the underlying FK constraints are present on the source table.
  const { data, error } = await withDbErrorCapture(
    supabase
      .from("current_injuries")
      .select(INJURY_SELECT)
      .order("date_injured", { ascending: false })
      .limit(limit),
    "injuriesRepo.getCurrentlyInjured",
  );

  if (error) {
    // Fallback: emulate the view client-side using the base table
    const fallback = await withDbErrorCapture(
      supabase
        .from(dbTable("injuries"))
        .select(INJURY_SELECT)
        .neq("status", "returned")
        .order("date_injured", { ascending: false })
        .limit(limit * 3),
      "injuriesRepo.getCurrentlyInjured.fallback",
    );

    if (fallback.error) throw fallback.error;

    const seen = new Set<string>();
    const deduped: InjuryWithPlayer[] = [];
    for (const row of (fallback.data ?? []) as unknown as InjuryWithPlayer[]) {
      if (!seen.has(row.player_id)) {
        seen.add(row.player_id);
        deduped.push(row);
        if (deduped.length >= limit) break;
      }
    }
    return deduped;
  }

  return (data ?? []) as unknown as InjuryWithPlayer[];
}

/**
 * Fetch players expected to return within the next `windowDays` days,
 * ordered by expected_return_date ascending (soonest first).
 */
export async function getReturningSoon(
  limit = 10,
  windowDays = 14,
): Promise<InjuryWithPlayer[]> {
  // Boundaries are computed in UTC so the window is consistent regardless of
  // the user's timezone (date columns in Postgres store calendar dates, not
  // timestamps, so comparing UTC date strings is the correct approach).
  const today = todayUTC();
  const future = futureDateUTC(windowDays);

  const { data, error } = await withDbErrorCapture(
    supabase
      .from("current_injuries")
      .select(INJURY_SELECT)
      .not("expected_return_date", "is", null)
      .gte("expected_return_date", today)
      .lte("expected_return_date", future)
      .order("expected_return_date", { ascending: true })
      .limit(limit),
    "injuriesRepo.getReturningSoon",
  );

  if (error) {
    // Fallback: query base table directly
    const fallback = await withDbErrorCapture(
      supabase
        .from(dbTable("injuries"))
        .select(INJURY_SELECT)
        .neq("status", "returned")
        .not("expected_return_date", "is", null)
        .gte("expected_return_date", today)
        .lte("expected_return_date", future)
        .order("expected_return_date", { ascending: true })
        .limit(limit),
      "injuriesRepo.getReturningSoon.fallback",
    );

    if (fallback.error) throw fallback.error;
    // Explicit null guard: exclude any rows that slipped through without a
    // return date (the DB filter should already prevent this, but safety-first).
    return ((fallback.data ?? []) as unknown as InjuryWithPlayer[]).filter(
      (r) => r.expected_return_date !== null,
    );
  }

  // Client-side null guard for the view path as well
  return ((data ?? []) as unknown as InjuryWithPlayer[]).filter(
    (r) => r.expected_return_date !== null,
  );
}
