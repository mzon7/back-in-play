import { useQuery } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";

export interface TeamPageData {
  team_id: string;
  team_name: string;
  league_slug: string;
  league_name: string;
  injuries: TeamInjury[];
}

export interface TeamInjury {
  injury_id: string;
  player_name: string;
  player_slug: string;
  position: string;
  injury_type: string;
  status: string;
  date_injured: string;
  expected_return: string | null;
  games_missed: number | null;
  headshot_url: string | null;
  espn_id: string | null;
  is_star: boolean;
  is_starter: boolean;
}

function espnHeadshot(espnId: string | null, league?: string): string | null {
  if (!espnId) return null;
  const sport = league === "nfl" ? "nfl" : league === "nhl" ? "nhl" : league === "mlb" ? "mlb" : "nba";
  return `https://a.espncdn.com/i/headshots/${sport}/players/full/${espnId}.png`;
}

export function useTeamPage(leagueSlug: string, teamSlug: string) {
  return useQuery<TeamPageData | null>({
    queryKey: ["team-page", leagueSlug, teamSlug],
    enabled: !!leagueSlug && !!teamSlug,
    queryFn: async () => {
      // 1. Get league
      const { data: leagues } = await supabase
        .from("back_in_play_leagues")
        .select("league_id, league_name, slug")
        .eq("slug", leagueSlug)
        .limit(1);
      if (!leagues?.length) return null;
      const league = leagues[0];

      // 2. Get teams in league, match by slug
      const { data: teams } = await supabase
        .from("back_in_play_teams")
        .select("team_id, team_name")
        .eq("league_id", league.league_id)
        .neq("team_name", "Unknown");

      const team = teams?.find((t) => {
        const slug = t.team_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        return slug === teamSlug;
      });
      if (!team) return null;

      // 3. Single query: injuries with player joins, filtered by team
      const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
      const { data: injuries } = await supabase
        .from("back_in_play_injuries")
        .select(`
          injury_id, injury_type, status, date_injured, expected_return, games_missed,
          player:back_in_play_players!inner(
            player_name, slug, position, headshot_url, espn_id, is_star, is_starter
          )
        `)
        .eq("player.team_id", team.team_id)
        .gte("date_injured", cutoff)
        .order("date_injured", { ascending: false })
        .limit(200);

      return {
        team_id: team.team_id,
        team_name: team.team_name,
        league_slug: leagueSlug,
        league_name: league.league_name,
        injuries: (injuries ?? []).map((inj: any) => {
          const p = inj.player;
          return {
            injury_id: inj.injury_id,
            player_name: p?.player_name ?? "Unknown",
            player_slug: p?.slug ?? "",
            position: p?.position ?? "",
            injury_type: inj.injury_type,
            status: inj.status,
            date_injured: inj.date_injured,
            expected_return: inj.expected_return,
            games_missed: inj.games_missed,
            headshot_url: p?.headshot_url ?? espnHeadshot(p?.espn_id ?? null, leagueSlug),
            espn_id: p?.espn_id ?? null,
            is_star: p?.is_star ?? false,
            is_starter: p?.is_starter ?? false,
          };
        }),
      };
    },
    staleTime: 2 * 60 * 1000,
  });
}
