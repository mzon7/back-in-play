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

export function usePerformanceCurves(leagueSlug?: string, injuryTypeSlug?: string, position?: string, returnType?: string) {
  return useQuery<PerformanceCurve[]>({
    queryKey: ["performance-curves", leagueSlug ?? "all", injuryTypeSlug ?? "all", position ?? "all", returnType ?? ""],
    queryFn: async () => {
      let q = supabase
        .from(dbTable("performance_curves"))
        .select("*")
        .gte("sample_size", 3)
        .eq("return_type", returnType ?? "")
        .order("sample_size", { ascending: false });

      if (leagueSlug && leagueSlug !== "all") {
        q = q.eq("league_slug", leagueSlug);
      }
      if (injuryTypeSlug) {
        q = q.eq("injury_type_slug", injuryTypeSlug);
      }
      // Filter by position: "" = all positions combined, specific position = that position only
      // League-aware position groups for combined filters
      const GROUPS_BY_LEAGUE: Record<string, Record<string, string[]>> = {
        nba: { G: ["G", "PG", "SG"], F: ["F", "PF", "SF"] },
        nhl: { W: ["W", "LW", "RW"], D: ["D", "LD", "RD"] },
        nfl: {
          QB: ["QB", "Quarterback"], RB: ["RB", "Running Back", "FB", "Fullback"],
          WR: ["WR", "Wide Receiver"], TE: ["TE", "Tight End"],
          OL: ["OL", "OT", "G", "C", "Center", "Guard", "LT", "RT", "Offensive Tackle", "T", "LS", "Long Snapper"],
          DL: ["DL", "DE", "DT", "Defensive End", "Defensive Tackle"],
          LB: ["LB", "ILB", "OLB", "Linebacker"],
          DB: ["CB", "S", "SS", "FS", "Cornerback", "Safety"],
          K: ["K", "Kicker", "P", "Punter"],
        },
        mlb: { P: ["SP", "RP", "LHP", "RHP"], IF: ["1B", "2B", "3B", "SS"], OF: ["OF", "LF", "CF", "RF"] },
        "premier-league": { DEF: ["CB", "DF", "DEF"], MID: ["CM", "MID"], FWD: ["FWD", "RW", "LW"] },
      };
      if (position && position !== "all") {
        const leagueGroups = leagueSlug && leagueSlug !== "all" ? (GROUPS_BY_LEAGUE[leagueSlug] ?? {}) : {};
        const group = leagueGroups[position];
        if (group) {
          q = q.in("position", group);
        } else {
          q = q.eq("position", position);
        }
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
      // Collapse PG/SG → G and PF/SF → F so the UI shows grouped labels
      // Add combined group labels when sub-positions exist
      const GROUP_MEMBERS: Record<string, Record<string, string[]>> = {
        nba: { G: ["PG", "SG"], F: ["PF", "SF"] },
        nhl: { W: ["LW", "RW"], D: ["LD", "RD"] },
        nfl: {
          QB: ["Quarterback"], RB: ["Running Back", "Fullback", "FB"],
          WR: ["Wide Receiver"], TE: ["Tight End"],
          OL: ["OT", "Center", "Guard", "LT", "RT", "Offensive Tackle", "T", "LS", "Long Snapper"],
          DL: ["DE", "DT", "Defensive End", "Defensive Tackle"],
          LB: ["ILB", "OLB", "Linebacker"],
          DB: ["CB", "S", "SS", "FS", "Cornerback", "Safety"],
        },
        mlb: { P: ["SP", "RP", "LHP", "RHP"], IF: ["1B", "2B", "3B", "SS"], OF: ["LF", "CF", "RF"] },
        "premier-league": { DEF: ["CB", "DF"], MID: ["CM"], FWD: ["RW", "LW"] },
      };
      // Collapse full names to abbreviations for NFL (dedup), keep individual positions too
      const NFL_DEDUP: Record<string, string> = {
        Quarterback: "QB", "Running Back": "RB", Fullback: "FB",
        "Wide Receiver": "WR", "Tight End": "TE",
        "Offensive Tackle": "OT", Center: "C", Guard: "G", "Long Snapper": "LS",
        "Defensive End": "DE", "Defensive Tackle": "DT",
        Linebacker: "LB", Cornerback: "CB", Safety: "S",
        Kicker: "K", Punter: "P",
      };
      const dedup = leagueSlug === "nfl" ? NFL_DEDUP : {};
      const mapped = (data ?? []).map((d: { position: string }) => dedup[d.position] ?? d.position);
      // Start with individual positions
      const individual = Array.from(new Set(mapped)).filter(Boolean);
      // Add combined groups where at least 2 sub-positions exist in the data
      const groups = leagueSlug && leagueSlug !== "all" ? (GROUP_MEMBERS[leagueSlug] ?? {}) : {};
      for (const [groupLabel, members] of Object.entries(groups)) {
        const hasMembers = members.filter(m => individual.includes(dedup[m] ?? m));
        if (hasMembers.length >= 1 && !individual.includes(groupLabel)) {
          individual.push(groupLabel);
        }
      }
      const filtered = individual.filter(p => p !== "Unknown");
      return filtered.sort();
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
