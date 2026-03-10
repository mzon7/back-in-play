import { useQuery } from "@tanstack/react-query";
import { supabase, dbTable } from "../../../lib/supabase";
import type { InjuryWithPlayer } from "./types";

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

export function useLatestInjuries({ limit = 10 } = {}) {
  return useQuery<InjuryWithPlayer[]>({
    queryKey: ["latest-injuries", limit],
    queryFn: async () => {
      const { data, error } = await supabase
        .from(dbTable("injuries"))
        .select(INJURY_SELECT)
        .order("date_injured", { ascending: false })
        .limit(limit);

      if (error) throw error;
      return (data ?? []) as unknown as InjuryWithPlayer[];
    },
    staleTime: 60_000,
  });
}

export function useCurrentlyInjured({ limit = 10 } = {}) {
  return useQuery<InjuryWithPlayer[]>({
    queryKey: ["currently-injured", limit],
    queryFn: async () => {
      // Emulate current_injuries view: latest injury per player where status != 'returned'
      const { data, error } = await supabase
        .from(dbTable("injuries"))
        .select(INJURY_SELECT)
        .neq("status", "returned")
        .order("date_injured", { ascending: false })
        .limit(limit * 3); // over-fetch to dedupe by player

      if (error) throw error;

      // Dedupe: one entry per player (first occurrence = most recent)
      const seen = new Set<string>();
      const deduped: InjuryWithPlayer[] = [];
      for (const row of (data ?? []) as unknown as InjuryWithPlayer[]) {
        if (!seen.has(row.player_id)) {
          seen.add(row.player_id);
          deduped.push(row);
          if (deduped.length >= limit) break;
        }
      }
      return deduped;
    },
    staleTime: 60_000,
  });
}

export function useReturningSoon({ limit = 10, windowDays = 14 } = {}) {
  return useQuery<InjuryWithPlayer[]>({
    queryKey: ["returning-soon", limit, windowDays],
    queryFn: async () => {
      const today = new Date().toISOString().split("T")[0];
      const future = new Date(Date.now() + windowDays * 86_400_000)
        .toISOString()
        .split("T")[0];

      const { data, error } = await supabase
        .from(dbTable("injuries"))
        .select(INJURY_SELECT)
        .neq("status", "returned")
        .gte("expected_return_date", today)
        .lte("expected_return_date", future)
        .order("expected_return_date", { ascending: true })
        .limit(limit);

      if (error) throw error;
      return (data ?? []) as unknown as InjuryWithPlayer[];
    },
    staleTime: 60_000,
  });
}
