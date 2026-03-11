import { useQuery } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";

export interface InjuryRow {
  injury_id: string;
  player_id: string;
  injury_type: string;
  injury_type_slug: string;
  injury_description: string | null;
  date_injured: string;
  return_date: string | null;
  recovery_days: number | null;
  games_missed: number | null;
  status: string;
  source: string | null;
  expected_return: string | null;
  side: string | null;
  long_comment: string | null;
  short_comment: string | null;
  injury_location: string | null;
  rank_at_injury: number | null;
  game_minutes: number | null;
  // joined
  player_name?: string;
  position?: string;
  team_name?: string;
  league_slug?: string;
  league_name?: string;
  league_rank?: number | null;
  preseason_rank?: number | null;
  headshot_url?: string | null;
  pre_injury_avg_minutes?: number | null;
}

export interface LeagueRow {
  league_id: string;
  league_name: string;
  slug: string;
}

export function useLeagues() {
  return useQuery<LeagueRow[]>({
    queryKey: ["bip-leagues"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("back_in_play_leagues")
        .select("league_id, league_name, slug")
        .order("league_name");
      if (error) throw error;
      return data ?? [];
    },
  });
}

/**
 * Landing page: injuries for TOP 50 players across ALL leagues.
 * A player qualifies if preseason_rank <= 50 OR rank_at_injury <= 50.
 */
export function useTopPlayerInjuries() {
  return useQuery<InjuryRow[]>({
    queryKey: ["bip-top-injuries"],
    queryFn: async () => {
      // Step 1: Get all leagues
      const { data: leagues } = await supabase
        .from("back_in_play_leagues")
        .select("league_id, league_name, slug");
      if (!leagues || leagues.length === 0) return [];

      const leagueMap = new Map<string, { name: string; slug: string }>();
      leagues.forEach((l) => leagueMap.set(l.league_id, { name: l.league_name, slug: l.slug }));

      // Step 2: Get all teams (for team name lookup)
      const { data: teams } = await supabase
        .from("back_in_play_teams")
        .select("team_id, team_name, league_id");
      const teamMap = new Map<string, { name: string; leagueId: string }>();
      (teams ?? []).forEach((t) => teamMap.set(t.team_id, { name: t.team_name, leagueId: t.league_id }));

      // Step 3: Get players with preseason_rank or league_rank <= 50
      const { data: rankedPlayers } = await supabase
        .from("back_in_play_players")
        .select("player_id, player_name, position, team_id, league_rank, preseason_rank, headshot_url, pre_injury_avg_minutes")
        .or("league_rank.lte.50,preseason_rank.lte.50");

      if (!rankedPlayers || rankedPlayers.length === 0) return [];

      const playerMap = new Map<string, typeof rankedPlayers[0]>();
      rankedPlayers.forEach((p) => playerMap.set(p.player_id, p));
      const playerIds = Array.from(playerMap.keys());

      // Step 4: Get recent injuries for these ranked players
      const sixtyDaysAgo = new Date();
      sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
      const cutoff = sixtyDaysAgo.toISOString().slice(0, 10);

      const { data: injuries, error } = await supabase
        .from("back_in_play_injuries")
        .select("*")
        .in("player_id", playerIds)
        .gte("date_injured", cutoff)
        .order("date_injured", { ascending: false });

      if (error) throw error;

      // Also include injuries where rank_at_injury <= 50
      const { data: rankedInjuries } = await supabase
        .from("back_in_play_injuries")
        .select("*")
        .lte("rank_at_injury", 50)
        .gte("date_injured", cutoff)
        .order("date_injured", { ascending: false });

      // Merge and deduplicate
      const injMap = new Map<string, typeof injuries extends (infer T)[] ? T : never>();
      for (const inj of (injuries ?? [])) {
        injMap.set(inj.injury_id, inj);
      }
      for (const inj of (rankedInjuries ?? [])) {
        injMap.set(inj.injury_id, inj);
      }

      // Fetch missing players from rankedInjuries
      const missingPlayerIds = new Set<string>();
      for (const inj of injMap.values()) {
        if (!playerMap.has(inj.player_id)) {
          missingPlayerIds.add(inj.player_id);
        }
      }
      if (missingPlayerIds.size > 0) {
        const { data: extraPlayers } = await supabase
          .from("back_in_play_players")
          .select("player_id, player_name, position, team_id, league_rank, preseason_rank, headshot_url, pre_injury_avg_minutes")
          .in("player_id", Array.from(missingPlayerIds));
        (extraPlayers ?? []).forEach((p) => playerMap.set(p.player_id, p));
      }

      // Enrich
      return Array.from(injMap.values()).map((inj) => {
        const player = playerMap.get(inj.player_id);
        const team = player ? teamMap.get(player.team_id) : undefined;
        const league = team ? leagueMap.get(team.leagueId) : undefined;
        return {
          ...inj,
          player_name: player?.player_name ?? "Unknown",
          position: player?.position ?? "",
          team_name: team?.name ?? "",
          league_slug: league?.slug ?? "",
          league_name: league?.name ?? "",
          league_rank: player?.league_rank ?? null,
          preseason_rank: player?.preseason_rank ?? null,
          headshot_url: player?.headshot_url ?? null,
          pre_injury_avg_minutes: player?.pre_injury_avg_minutes ?? null,
        };
      });
    },
    staleTime: 5 * 60 * 1000,
  });
}

export function useCurrentInjuries(leagueSlug: string) {
  return useQuery<InjuryRow[]>({
    queryKey: ["bip-injuries", leagueSlug],
    enabled: !!leagueSlug,
    queryFn: async () => {
      const { data: leagues } = await supabase
        .from("back_in_play_leagues")
        .select("league_id")
        .eq("slug", leagueSlug)
        .limit(1);

      if (!leagues || leagues.length === 0) return [];
      const leagueId = leagues[0].league_id;

      const { data: teams } = await supabase
        .from("back_in_play_teams")
        .select("team_id, team_name")
        .eq("league_id", leagueId);

      const teamMap = new Map<string, string>();
      (teams ?? []).forEach((t) => teamMap.set(t.team_id, t.team_name));
      const teamIds = Array.from(teamMap.keys());

      if (teamIds.length === 0) return [];

      const { data: players } = await supabase
        .from("back_in_play_players")
        .select("player_id, player_name, position, team_id, league_rank, preseason_rank, headshot_url, pre_injury_avg_minutes")
        .in("team_id", teamIds);

      const playerMap = new Map<string, typeof players extends (infer T)[] | null ? T : never>();
      (players ?? []).forEach((p) =>
        playerMap.set(p.player_id, p),
      );
      const playerIds = Array.from(playerMap.keys());

      if (playerIds.length === 0) return [];

      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const cutoff = thirtyDaysAgo.toISOString().slice(0, 10);

      const { data: injuries, error } = await supabase
        .from("back_in_play_injuries")
        .select("*")
        .in("player_id", playerIds)
        .gte("date_injured", cutoff)
        .neq("status", "cleared")
        .order("date_injured", { ascending: false });

      if (error) throw error;

      return (injuries ?? []).map((inj) => {
        const player = playerMap.get(inj.player_id);
        return {
          ...inj,
          player_name: player?.player_name ?? "Unknown",
          position: player?.position ?? "",
          team_name: player ? (teamMap.get(player.team_id) ?? "") : "",
          league_slug: leagueSlug,
          league_rank: player?.league_rank ?? null,
          preseason_rank: player?.preseason_rank ?? null,
          headshot_url: player?.headshot_url ?? null,
          pre_injury_avg_minutes: player?.pre_injury_avg_minutes ?? null,
        };
      });
    },
    staleTime: 5 * 60 * 1000,
  });
}
