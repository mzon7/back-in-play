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

function parseJsonObj(val: unknown): Record<string, (number | null)[]> | null {
  if (val == null) return null;
  if (typeof val === "object" && !Array.isArray(val)) return val as Record<string, (number | null)[]>;
  if (typeof val === "string") {
    try { return JSON.parse(val); } catch { return null; }
  }
  return null;
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
    stat_avg_pct: parseJsonObj(raw.stat_avg_pct),
    stat_median_pct: parseJsonObj(raw.stat_median_pct),
    stat_stddev_pct: parseJsonObj(raw.stat_stddev_pct),
    stat_stderr_pct: parseJsonObj(raw.stat_stderr_pct),
  } as PerformanceCurve;
}

export function usePerformanceCurves(leagueSlug?: string, injuryTypeSlug?: string, position?: string) {
  return useQuery<PerformanceCurve[]>({
    queryKey: ["performance-curves", leagueSlug ?? "all", injuryTypeSlug ?? "all", position ?? "all"],
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
      // Filter by position: "" = all positions combined, specific position = that position only
      if (position && position !== "all") {
        q = q.eq("position", position);
      } else {
        q = q.eq("position", "");
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
        .eq("position", "")
        .maybeSingle();

      if (error) throw new Error(error.message);
      if (!data) return null;
      return mapCurve(data as Record<string, unknown>);
    },
    staleTime: 10 * 60 * 1000,
  });
}

/** Get distinct positions that have curves for a given league */
export function usePositionsWithCurves(leagueSlug?: string) {
  return useQuery<string[]>({
    queryKey: ["curve-positions", leagueSlug ?? "all"],
    queryFn: async () => {
      let q = supabase
        .from(dbTable("performance_curves"))
        .select("position")
        .gte("sample_size", 3)
        .neq("position", "");

      if (leagueSlug && leagueSlug !== "all") {
        q = q.eq("league_slug", leagueSlug);
      }

      const { data, error } = await q;
      if (error) throw new Error(error.message);
      const positions = Array.from(new Set((data ?? []).map((d: { position: string }) => d.position))).filter(Boolean);
      return positions.sort();
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
