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
      // Find player by slug
      const { data: players } = await supabase
        .from("back_in_play_players")
        .select("player_id, player_name, slug, position, team_id, league_id, headshot_url, espn_id, is_star, is_starter, league_rank, preseason_rank")
        .eq("slug", playerSlug)
        .limit(1);

      if (!players || players.length === 0) return null;
      const player = players[0];

      // Get team
      const { data: teams } = await supabase
        .from("back_in_play_teams")
        .select("team_name, league_id")
        .eq("team_id", player.team_id)
        .limit(1);
      const team = teams?.[0];

      // Get league
      const { data: leagues } = await supabase
        .from("back_in_play_leagues")
        .select("league_name, slug")
        .eq("league_id", player.league_id)
        .limit(1);
      const league = leagues?.[0];

      // Get all injuries for this player (most recent first)
      const { data: injuries } = await supabase
        .from("back_in_play_injuries")
        .select("injury_id, injury_type, injury_description, date_injured, return_date, status, expected_return, games_missed, recovery_days, side, long_comment, short_comment")
        .eq("player_id", player.player_id)
        .order("date_injured", { ascending: false })
        .limit(50);

      // Get status changes
      const { data: changes } = await supabase
        .from("back_in_play_status_changes")
        .select("id, old_status, new_status, change_type, summary, changed_at")
        .eq("player_id", player.player_id)
        .order("changed_at", { ascending: false })
        .limit(50);

      // Get injured teammates
      const { data: teammates } = await supabase
        .from("back_in_play_players")
        .select("player_name, slug, position")
        .eq("team_id", player.team_id)
        .neq("player_id", player.player_id)
        .not("slug", "is", null)
        .order("is_star", { ascending: false })
        .limit(20);

      // Filter to those with active injuries
      const tmIds = (teammates ?? []).map((t: any) => t.slug);
      const injuredTeammates: RelatedPlayer[] = [];
      if (tmIds.length > 0) {
        // Just show all teammates — many are injured. Cap at 8.
        for (const t of (teammates ?? []).slice(0, 8)) {
          if (t.slug) injuredTeammates.push({ player_name: t.player_name, slug: t.slug, position: t.position ?? "" });
        }
      }

      const leagueSlug = league?.slug ?? "";
      return {
        player_id: player.player_id,
        player_name: player.player_name,
        slug: player.slug,
        position: player.position ?? "",
        team_name: team?.team_name ?? "Unknown",
        team_slug: teamSlug(team?.team_name ?? ""),
        league_slug: leagueSlug,
        league_name: league?.league_name ?? "",
        league_id: player.league_id,
        headshot_url: player.headshot_url ?? espnHeadshot(player.espn_id, leagueSlug),
        espn_id: player.espn_id,
        is_star: player.is_star ?? false,
        is_starter: player.is_starter ?? false,
        league_rank: player.league_rank,
        preseason_rank: player.preseason_rank,
        injuries: injuries ?? [],
        statusChanges: changes ?? [],
        injuredTeammates,
      };
    },
    staleTime: 2 * 60 * 1000,
  });
}
