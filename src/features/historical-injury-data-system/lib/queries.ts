import { useQuery } from "@tanstack/react-query";
import { supabase, dbTable } from "../../../lib/supabase";
import type { RecoveryStat } from "./types";

export interface GamesMissedBucket {
  label: string;
  min: number;
  max: number;
  count: number;
}

export interface ReturnCaseAggRow {
  injury_type_slug: string;
  age_at_injury: number | null;
  total_prior_injuries: number | null;
  same_body_part_prior: number | null;
  recovery_days: number | null;
  games_missed: number | null;
}

/**
 * Fetch raw injuries for a league to compute games-missed distributions client-side.
 * Returns only injuries with return_date (completed recoveries).
 */
export function useGamesMissedDistribution(leagueSlug?: string) {
  return useQuery<{ injuryType: string; gamesMissed: number }[]>({
    queryKey: ["games-missed-dist", leagueSlug ?? "all"],
    queryFn: async () => {
      let q = supabase
        .from(dbTable("injuries"))
        .select("injury_type,games_missed,league_slug:player_id")
        .not("return_date", "is", null)
        .not("games_missed", "is", null)
        .gt("games_missed", 0)
        .order("games_missed", { ascending: true })
        .limit(1000);

      // We can't easily filter by league here without a join.
      // Instead, fetch all and filter client-side if needed.

      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []).map((d: any) => ({
        injuryType: d.injury_type as string,
        gamesMissed: d.games_missed as number,
      }));
    },
    staleTime: 10 * 60 * 1000,
  });
}

/**
 * Fetch return case data for age impact and reinjury rate analysis.
 */
export function useReturnCaseAggregates(leagueSlug?: string) {
  return useQuery<ReturnCaseAggRow[]>({
    queryKey: ["return-case-aggs", leagueSlug ?? "all"],
    queryFn: async () => {
      let q = supabase
        .from(dbTable("injury_return_cases"))
        .select("injury_type_slug,age_at_injury,total_prior_injuries,same_body_part_prior,recovery_days,games_missed")
        .not("recovery_days", "is", null)
        .order("recovery_days", { ascending: true })
        .limit(1000);

      if (leagueSlug && leagueSlug !== "all") {
        q = q.eq("league_slug", leagueSlug);
      }

      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as ReturnCaseAggRow[];
    },
    staleTime: 10 * 60 * 1000,
  });
}

export function useRecoveryStats(leagueSlug?: string) {
  return useQuery<RecoveryStat[]>({
    queryKey: ["recovery-stats", leagueSlug ?? "all"],
    queryFn: async () => {
      let q = supabase
        .from(dbTable("recovery_statistics"))
        .select("*")
        .order("league_slug")
        .order("median_recovery_days", { ascending: false });

      if (leagueSlug && leagueSlug !== "all") {
        q = q.eq("league_slug", leagueSlug);
      }

      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as RecoveryStat[];
    },
    staleTime: 5 * 60 * 1000,
  });
}

export function useRecoveryStatByInjuryType(injuryTypeSlug: string, leagueSlug: string) {
  return useQuery<RecoveryStat | null>({
    queryKey: ["recovery-stat", injuryTypeSlug, leagueSlug],
    queryFn: async () => {
      const { data, error } = await supabase
        .from(dbTable("recovery_statistics"))
        .select("*")
        .eq("injury_type_slug", injuryTypeSlug)
        .eq("league_slug", leagueSlug)
        .maybeSingle();

      if (error) throw new Error(error.message);
      return data as unknown as RecoveryStat | null;
    },
    staleTime: 5 * 60 * 1000,
    enabled: Boolean(injuryTypeSlug && leagueSlug),
  });
}
