import { useQuery } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";

export interface RelatedPlayer {
  player_name: string;
  slug: string;
  position: string;
}

export interface PlayerPageData {
  player_id: string;
  player_name: string;
  slug: string;
  position: string;
  team_id: string;
  team_name: string;
  team_slug: string;
  league_slug: string;
  league_name: string;
  league_id: string;
  headshot_url: string | null;
  espn_id: string | null;
  is_star: boolean;
  is_starter: boolean;
  league_rank: number | null;
  preseason_rank: number | null;
  injuries: PlayerInjury[];
  statusChanges: StatusChange[];
  injuredTeammates: RelatedPlayer[];
}

export interface PlayerInjury {
  injury_id: string;
  injury_type: string;
  injury_description: string | null;
  date_injured: string;
  return_date: string | null;
  status: string;
  expected_return: string | null;
  games_missed: number | null;
  recovery_days: number | null;
  side: string | null;
  long_comment: string | null;
  short_comment: string | null;
}

export interface StatusChange {
  id: string;
  old_status: string | null;
  new_status: string;
  change_type: string;
  summary: string;
  changed_at: string;
}

function espnHeadshot(espnId: string | null | undefined, league?: string): string | null {
  if (!espnId) return null;
  const sport = league === "nfl" ? "nfl" : league === "nhl" ? "nhl" : league === "mlb" ? "mlb" : "nba";
  return `https://a.espncdn.com/i/headshots/${sport}/players/full/${espnId}.png`;
}

function teamSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function usePlayerPage(playerSlug: string) {
  return useQuery<PlayerPageData | null>({
    queryKey: ["player-page", playerSlug],
    enabled: !!playerSlug,
    queryFn: async () => {
      // 1. Player with team + league join (1 call)
      const { data: players } = await supabase
        .from("back_in_play_players")
        .select(`
          player_id, player_name, slug, position, team_id, league_id,
          headshot_url, espn_id, is_star, is_starter, league_rank, preseason_rank,
          team:back_in_play_teams!inner(
            team_name,
            league:back_in_play_leagues(league_name, slug)
          )
        `)
        .eq("slug", playerSlug)
        .limit(1);

      if (!players?.length) return null;
      const raw = players[0] as any;
      const player = {
        player_id: raw.player_id,
        player_name: raw.player_name,
        slug: raw.slug,
        position: raw.position ?? "",
        team_id: raw.team_id,
        league_id: raw.league_id,
        headshot_url: raw.headshot_url,
        espn_id: raw.espn_id,
        is_star: raw.is_star ?? false,
        is_starter: raw.is_starter ?? false,
        league_rank: raw.league_rank,
        preseason_rank: raw.preseason_rank,
        team_name: raw.team?.team_name ?? "Unknown",
        league_slug: raw.team?.league?.slug ?? "",
        league_name: raw.team?.league?.league_name ?? "",
      };

      // 2. Parallel: injuries + status changes + teammates (3 calls in parallel)
      const [injuriesRes, changesRes, teammatesRes] = await Promise.all([
        supabase
          .from("back_in_play_injuries")
          .select("injury_id, injury_type, injury_description, date_injured, return_date, status, expected_return, games_missed, recovery_days, side, long_comment, short_comment")
          .eq("player_id", player.player_id)
          .order("date_injured", { ascending: false })
          .limit(50),
        supabase
          .from("back_in_play_status_changes")
          .select("id, old_status, new_status, change_type, summary, changed_at")
          .eq("player_id", player.player_id)
          .order("changed_at", { ascending: false })
          .limit(50),
        supabase
          .from("back_in_play_players")
          .select("player_name, slug, position")
          .eq("team_id", player.team_id)
          .neq("player_id", player.player_id)
          .not("slug", "is", null)
          .order("is_star", { ascending: false })
          .limit(8),
      ]);

      const leagueSlug = player.league_slug;
      return {
        ...player,
        team_slug: teamSlug(player.team_name),
        headshot_url: player.headshot_url ?? espnHeadshot(player.espn_id, leagueSlug),
        injuries: injuriesRes.data ?? [],
        statusChanges: changesRes.data ?? [],
        injuredTeammates: (teammatesRes.data ?? [])
          .filter((t: any) => t.slug)
          .map((t: any) => ({ player_name: t.player_name, slug: t.slug, position: t.position ?? "" })),
      };
    },
    staleTime: 2 * 60 * 1000,
  });
}
