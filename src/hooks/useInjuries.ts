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
  is_star?: boolean;
  is_starter?: boolean;
}

export interface LeagueRow {
  league_id: string;
  league_name: string;
  slug: string;
}

export interface StatusChangeRow {
  id: string;
  player_id: string;
  injury_id: string | null;
  old_status: string | null;
  new_status: string;
  change_type: string;
  summary: string;
  changed_at: string;
  player_name?: string;
  team_name?: string;
  league_slug?: string;
  headshot_url?: string | null;
}

function espnHeadshot(espnId: string | null | undefined): string | null {
  if (!espnId) return null;
  return `https://a.espncdn.com/i/headshots/nba/players/full/${espnId}.png`;
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
 */
export function useTopPlayerInjuries() {
  return useQuery<InjuryRow[]>({
    queryKey: ["bip-top-injuries"],
    queryFn: async () => {
      const { data: leagues } = await supabase
        .from("back_in_play_leagues")
        .select("league_id, league_name, slug");
      if (!leagues || leagues.length === 0) return [];

      const leagueMap = new Map<string, { name: string; slug: string }>();
      leagues.forEach((l) => leagueMap.set(l.league_id, { name: l.league_name, slug: l.slug }));

      const { data: teams } = await supabase
        .from("back_in_play_teams")
        .select("team_id, team_name, league_id");
      const teamMap = new Map<string, { name: string; leagueId: string }>();
      (teams ?? []).forEach((t) => teamMap.set(t.team_id, { name: t.team_name, leagueId: t.league_id }));

      const { data: rankedPlayers } = await supabase
        .from("back_in_play_players")
        .select("player_id, player_name, position, team_id, league_rank, preseason_rank, headshot_url, pre_injury_avg_minutes, espn_id, is_star, is_starter")
        .or("league_rank.lte.50,preseason_rank.lte.50");

      if (!rankedPlayers || rankedPlayers.length === 0) return [];

      const playerMap = new Map<string, typeof rankedPlayers[0]>();
      rankedPlayers.forEach((p) => playerMap.set(p.player_id, p));
      const playerIds = Array.from(playerMap.keys());

      const cutoff = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);

      // Chunk player IDs to avoid URL length limits
      const injuries: any[] = [];
      for (let i = 0; i < playerIds.length; i += 100) {
        const chunk = playerIds.slice(i, i + 100);
        const { data, error } = await supabase
          .from("back_in_play_injuries")
          .select("*")
          .in("player_id", chunk)
          .gte("date_injured", cutoff)
          .order("date_injured", { ascending: false });
        if (error) throw error;
        if (data) injuries.push(...data);
      }

      const { data: rankedInjuries } = await supabase
        .from("back_in_play_injuries")
        .select("*")
        .lte("rank_at_injury", 50)
        .gte("date_injured", cutoff)
        .order("date_injured", { ascending: false });

      const injMap = new Map<string, any>();
      for (const inj of injuries) injMap.set(inj.injury_id, inj);
      for (const inj of (rankedInjuries ?? [])) injMap.set(inj.injury_id, inj);

      const missingPlayerIds = new Set<string>();
      for (const inj of injMap.values()) {
        if (!playerMap.has(inj.player_id)) missingPlayerIds.add(inj.player_id);
      }
      if (missingPlayerIds.size > 0) {
        const { data: extraPlayers } = await supabase
          .from("back_in_play_players")
          .select("player_id, player_name, position, team_id, league_rank, preseason_rank, headshot_url, pre_injury_avg_minutes, espn_id, is_star, is_starter")
          .in("player_id", Array.from(missingPlayerIds));
        (extraPlayers ?? []).forEach((p) => playerMap.set(p.player_id, p));
      }

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
          headshot_url: player?.headshot_url ?? espnHeadshot(player?.espn_id) ?? null,
          pre_injury_avg_minutes: player?.pre_injury_avg_minutes ?? null,
          is_star: player?.is_star ?? false,
          is_starter: player?.is_starter ?? false,
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
      // 1. Get league → teams (small set, ~30 per league)
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

      // 2. Get players for this league's teams (~30 team IDs, fits easily in URL)
      const { data: players } = await supabase
        .from("back_in_play_players")
        .select("player_id, player_name, position, team_id, league_rank, preseason_rank, headshot_url, pre_injury_avg_minutes, espn_id, is_star, is_starter")
        .in("team_id", teamIds);
      const playerMap = new Map<string, any>();
      (players ?? []).forEach((p: any) => playerMap.set(p.player_id, p));
      const playerIdSet = new Set(playerMap.keys());
      if (playerIdSet.size === 0) return [];

      // 3. Fetch ALL recent injuries (no player filter), then filter client-side
      const cutoff = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
      const { data: allInjuries, error } = await supabase
        .from("back_in_play_injuries")
        .select("*")
        .gte("date_injured", cutoff)
        .neq("status", "cleared")
        .order("date_injured", { ascending: false });
      if (error) throw error;

      // 4. Filter to only this league's players and enrich
      return (allInjuries ?? [])
        .filter((inj) => playerIdSet.has(inj.player_id))
        .map((inj) => {
          const player = playerMap.get(inj.player_id);
          return {
            ...inj,
            player_name: player?.player_name ?? "Unknown",
            position: player?.position ?? "",
            team_name: player ? (teamMap.get(player.team_id) ?? "") : "",
            league_slug: leagueSlug,
            league_rank: player?.league_rank ?? null,
            preseason_rank: player?.preseason_rank ?? null,
            headshot_url: player?.headshot_url ?? espnHeadshot(player?.espn_id) ?? null,
            pre_injury_avg_minutes: player?.pre_injury_avg_minutes ?? null,
            is_star: player?.is_star ?? false,
            is_starter: player?.is_starter ?? false,
          };
        });
    },
    staleTime: 5 * 60 * 1000,
  });
}

export function useStatusChanges(limit = 30) {
  return useQuery<StatusChangeRow[]>({
    queryKey: ["bip-status-changes", limit],
    queryFn: async () => {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      const { data: changes, error } = await supabase
        .from("back_in_play_status_changes")
        .select("*")
        .gte("changed_at", cutoff)
        .neq("change_type", "updated")
        .order("changed_at", { ascending: false })
        .limit(limit);

      if (error) throw error;
      if (!changes || changes.length === 0) return [];

      const playerIds = Array.from(new Set(changes.map((c) => c.player_id)));
      const { data: players } = await supabase
        .from("back_in_play_players")
        .select("player_id, player_name, team_id, headshot_url, espn_id")
        .in("player_id", playerIds);

      const playerMap = new Map<string, { name: string; teamId: string; headshot: string | null }>();
      (players ?? []).forEach((p) => {
        const headshot = p.headshot_url
          ?? (p.espn_id ? `https://a.espncdn.com/i/headshots/nba/players/full/${p.espn_id}.png` : null);
        playerMap.set(p.player_id, { name: p.player_name, teamId: p.team_id, headshot });
      });

      const teamIds = Array.from(new Set([...playerMap.values()].map((p) => p.teamId).filter(Boolean)));
      const { data: teams } = await supabase
        .from("back_in_play_teams")
        .select("team_id, team_name, league_id")
        .in("team_id", teamIds);
      const teamMap = new Map<string, { name: string; leagueId: string }>();
      (teams ?? []).forEach((t) => teamMap.set(t.team_id, { name: t.team_name, leagueId: t.league_id }));

      const { data: leagues } = await supabase
        .from("back_in_play_leagues")
        .select("league_id, slug");
      const leagueMap = new Map<string, string>();
      (leagues ?? []).forEach((l) => leagueMap.set(l.league_id, l.slug));

      return changes.map((c) => {
        const player = playerMap.get(c.player_id);
        const team = player ? teamMap.get(player.teamId) : undefined;
        return {
          ...c,
          player_name: player?.name ?? "Unknown",
          team_name: team?.name ?? "",
          league_slug: team ? (leagueMap.get(team.leagueId) ?? "") : "",
          headshot_url: player?.headshot ?? null,
        };
      });
    },
    staleTime: 60 * 1000,
  });
}
