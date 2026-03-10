import { useQuery } from "@tanstack/react-query";
import { supabase, dbTable } from "../../../lib/supabase";
import type { RecoveryStat } from "./types";

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
