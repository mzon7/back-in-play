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
  player_slug?: string;
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
  player_slug?: string;
  team_name?: string;
  league_slug?: string;
  headshot_url?: string | null;
}

function espnHeadshot(espnId: string | null | undefined): string | null {
  if (!espnId) return null;
  return `https://a.espncdn.com/i/headshots/nba/players/full/${espnId}.png`;
}

// ─── Shared embedded select for injuries → players → teams → leagues ─────────
const INJURY_JOIN_SELECT = `
  *,
  player:back_in_play_players!inner(
    player_name, slug, position, league_rank, preseason_rank, league_id,
    headshot_url, pre_injury_avg_minutes, espn_id, is_star, is_starter,
    team:back_in_play_teams!inner(
      team_name,
      league:back_in_play_leagues(league_name, slug)
    )
  )
`;

/** Flatten nested Supabase join result into flat InjuryRow */
function flattenInjuryRow(raw: any): InjuryRow {
  const p = raw.player;
  const t = p?.team;
  const l = t?.league;
  const { player: _, ...injury } = raw;
  return {
    ...injury,
    player_name: p?.player_name ?? "Unknown",
    player_slug: p?.slug ?? "",
    position: p?.position ?? "",
    team_name: t?.team_name ?? "",
    league_slug: l?.slug ?? "",
    league_name: l?.league_name ?? "",
    league_rank: p?.league_rank ?? null,
    preseason_rank: p?.preseason_rank ?? null,
    headshot_url: p?.headshot_url ?? espnHeadshot(p?.espn_id) ?? null,
    pre_injury_avg_minutes: p?.pre_injury_avg_minutes ?? null,
    is_star: p?.is_star ?? false,
    is_starter: p?.is_starter ?? false,
  };
}

// ─── Leagues (1 call, cached) ────────────────────────────────────────────────
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

// ─── Top Player Injuries (2 parallel calls, down from 6+) ───────────────────
export function useTopPlayerInjuries() {
  return useQuery<InjuryRow[]>({
    queryKey: ["bip-top-injuries"],
    queryFn: async () => {
      const cutoff = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);

      // Two parallel queries: by injury rank + by player rank
      const [byInjuryRank, byPlayerRank] = await Promise.all([
        supabase
          .from("back_in_play_injuries")
          .select(INJURY_JOIN_SELECT)
          .lte("rank_at_injury", 50)
          .gte("date_injured", cutoff)
          .order("date_injured", { ascending: false })
          .limit(100),
        supabase
          .from("back_in_play_injuries")
          .select(INJURY_JOIN_SELECT)
          .or("league_rank.lte.50,preseason_rank.lte.50", { referencedTable: "player" })
          .gte("date_injured", cutoff)
          .order("date_injured", { ascending: false })
          .limit(100),
      ]);

      if (byInjuryRank.error) throw byInjuryRank.error;
      if (byPlayerRank.error) throw byPlayerRank.error;

      // Merge, deduplicate, skip Unknown teams
      const seen = new Set<string>();
      const result: InjuryRow[] = [];
      for (const raw of [...(byInjuryRank.data ?? []), ...(byPlayerRank.data ?? [])]) {
        if (seen.has(raw.injury_id)) continue;
        seen.add(raw.injury_id);
        if ((raw as any).player?.team?.team_name === "Unknown") continue;
        result.push(flattenInjuryRow(raw));
      }
      return result;
    },
    staleTime: 5 * 60 * 1000,
  });
}

// ─── Per-League Injuries (2 calls, down from 4+) ────────────────────────────
export function useCurrentInjuries(leagueSlug: string) {
  return useQuery<InjuryRow[]>({
    queryKey: ["bip-injuries", leagueSlug],
    enabled: !!leagueSlug,
    queryFn: async () => {
      // 1. Resolve league slug → id (fast, small table)
      const { data: leagues } = await supabase
        .from("back_in_play_leagues")
        .select("league_id")
        .eq("slug", leagueSlug)
        .limit(1);
      if (!leagues?.length) return [];
      const leagueId = leagues[0].league_id;

      const cutoff = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);

      // 2. Single joined query filtered by player's league_id
      const { data, error } = await supabase
        .from("back_in_play_injuries")
        .select(INJURY_JOIN_SELECT)
        .eq("player.league_id", leagueId)
        .gte("date_injured", cutoff)
        .neq("status", "cleared")
        .order("date_injured", { ascending: false })
        .limit(500);

      if (error) throw error;
      return (data ?? [])
        .filter((raw: any) => raw.player?.team?.team_name !== "Unknown")
        .map(flattenInjuryRow);
    },
    staleTime: 5 * 60 * 1000,
  });
}

// ─── Player Props ────────────────────────────────────────────────────────────
export interface PropRow {
  id: string;
  player_id: string;
  player_name: string;
  market: string;
  line: number | null;
  over_price: string | null;
  under_price: string | null;
  source: string;
  game_date: string;
}

/** Fetch today's props for a list of player IDs. */
export function usePlayerProps(playerIds: string[]) {
  const today = new Date().toISOString().slice(0, 10);
  return useQuery<Map<string, PropRow[]>>({
    queryKey: ["bip-props", today, playerIds.length],
    enabled: playerIds.length > 0,
    queryFn: async () => {
      const map = new Map<string, PropRow[]>();
      for (let i = 0; i < playerIds.length; i += 50) {
        const chunk = playerIds.slice(i, i + 50);
        const { data, error } = await supabase
          .from("back_in_play_player_props")
          .select("id, player_id, player_name, market, line, over_price, under_price, source, game_date")
          .in("player_id", chunk)
          .eq("game_date", today);
        if (error) throw error;
        for (const row of data ?? []) {
          const existing = map.get(row.player_id) ?? [];
          existing.push(row);
          map.set(row.player_id, existing);
        }
      }
      return map;
    },
    staleTime: 5 * 60 * 1000,
  });
}

/** Fetch today's props for a single player. */
export function useSinglePlayerProps(playerId: string | undefined) {
  const today = new Date().toISOString().slice(0, 10);
  return useQuery<PropRow[]>({
    queryKey: ["bip-player-props", playerId, today],
    enabled: !!playerId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("back_in_play_player_props")
        .select("id, player_id, player_name, market, line, over_price, under_price, source, game_date")
        .eq("player_id", playerId!)
        .eq("game_date", today);
      if (error) throw error;
      return data ?? [];
    },
    staleTime: 5 * 60 * 1000,
  });
}

// ─── Status Changes (2 calls, down from 4) ──────────────────────────────────
export function useStatusChanges(limit = 30) {
  return useQuery<StatusChangeRow[]>({
    queryKey: ["bip-status-changes", limit],
    queryFn: async () => {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      // 1. Fetch changes
      const { data: changes, error } = await supabase
        .from("back_in_play_status_changes")
        .select("*")
        .gte("changed_at", cutoff)
        .neq("change_type", "updated")
        .order("changed_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      if (!changes?.length) return [];

      // 2. Fetch all needed players with team/league joins in ONE call
      const playerIds = Array.from(new Set(changes.map((c) => c.player_id)));
      const { data: players } = await supabase
        .from("back_in_play_players")
        .select(`
          player_id, player_name, slug, headshot_url, espn_id,
          team:back_in_play_teams!inner(
            team_name,
            league:back_in_play_leagues(slug)
          )
        `)
        .in("player_id", playerIds);

      const playerMap = new Map<string, any>();
      (players ?? []).forEach((p) => playerMap.set(p.player_id, p));

      return changes.map((c) => {
        const p = playerMap.get(c.player_id);
        return {
          ...c,
          player_name: p?.player_name ?? "Unknown",
          player_slug: p?.slug ?? "",
          team_name: p?.team?.team_name ?? "",
          league_slug: p?.team?.league?.slug ?? "",
          headshot_url: p?.headshot_url ?? espnHeadshot(p?.espn_id) ?? null,
        };
      });
    },
    staleTime: 60 * 1000,
  });
}
