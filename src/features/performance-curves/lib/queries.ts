import { useQuery } from "@tanstack/react-query";
import { supabase, dbTable } from "../../../lib/supabase";
import type { PerformanceCurve, ReturnCase } from "./types";

function parseJsonArray(val: unknown): number[] {
  if (Array.isArray(val)) return val;
  if (typeof val === "string") {
    try { return JSON.parse(val); } catch { return []; }
  }
  return [];
}

function mapCurve(raw: Record<string, unknown>): PerformanceCurve {
  return {
    ...raw,
    avg_pct_recent: parseJsonArray(raw.avg_pct_recent),
    avg_pct_season: parseJsonArray(raw.avg_pct_season),
    median_pct_recent: parseJsonArray(raw.median_pct_recent),
    p25_pct_recent: parseJsonArray(raw.p25_pct_recent),
    p75_pct_recent: parseJsonArray(raw.p75_pct_recent),
    avg_minutes_pct: parseJsonArray(raw.avg_minutes_pct),
    stddev_pct_recent: parseJsonArray(raw.stddev_pct_recent),
    stderr_pct_recent: parseJsonArray(raw.stderr_pct_recent),
  } as PerformanceCurve;
}

export function usePerformanceCurves(leagueSlug?: string, injuryTypeSlug?: string) {
  return useQuery<PerformanceCurve[]>({
    queryKey: ["performance-curves", leagueSlug ?? "all", injuryTypeSlug ?? "all"],
    queryFn: async () => {
      let q = supabase
        .from(dbTable("performance_curves"))
        .select("*")
        .gte("sample_size", 3)
        .order("sample_size", { ascending: false });

      if (leagueSlug && leagueSlug !== "all") {
        q = q.eq("league_slug", leagueSlug);
      }
      if (injuryTypeSlug) {
        q = q.eq("injury_type_slug", injuryTypeSlug);
      }

      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return ((data ?? []) as Record<string, unknown>[]).map(mapCurve);
    },
    staleTime: 10 * 60 * 1000,
  });
}

export function usePerformanceCurve(leagueSlug: string, injuryTypeSlug: string) {
  return useQuery<PerformanceCurve | null>({
    queryKey: ["performance-curve", leagueSlug, injuryTypeSlug],
    enabled: Boolean(leagueSlug && injuryTypeSlug),
    queryFn: async () => {
      const { data, error } = await supabase
        .from(dbTable("performance_curves"))
        .select("*")
        .eq("league_slug", leagueSlug)
        .eq("injury_type_slug", injuryTypeSlug)
        .maybeSingle();

      if (error) throw new Error(error.message);
      if (!data) return null;
      return mapCurve(data as Record<string, unknown>);
    },
    staleTime: 10 * 60 * 1000,
  });
}

export function usePlayerReturnCase(injuryId: string) {
  return useQuery<ReturnCase | null>({
    queryKey: ["return-case", injuryId],
    enabled: Boolean(injuryId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from(dbTable("injury_return_cases"))
        .select("*")
        .eq("injury_id", injuryId)
        .maybeSingle();

      if (error) throw new Error(error.message);
      if (!data) return null;

      const raw = data as Record<string, unknown>;
      return {
        ...raw,
        post_game_composites: typeof raw.post_game_composites === "string"
          ? JSON.parse(raw.post_game_composites)
          : (raw.post_game_composites ?? []),
      } as ReturnCase;
    },
    staleTime: 10 * 60 * 1000,
  });
}
