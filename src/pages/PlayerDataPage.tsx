/**
 * Player & Team Data Viewer — localhost-only debugging/auditing tool.
 */

import { useState, useMemo, Fragment } from "react";
import { useQuery } from "@tanstack/react-query";
import { SiteHeader } from "../components/SiteHeader";
import { supabase } from "../lib/supabase";

// ─── Constants ──────────────────────────────────────────────────────────────

type TabMode = "player" | "team" | "coverage" | "injuries";

const LEAGUE_STATS: Record<string, { key: string; label: string }[]> = {
  nba: [
    { key: "stat_pts", label: "PTS" },
    { key: "stat_reb", label: "REB" },
    { key: "stat_ast", label: "AST" },
    { key: "stat_stl", label: "STL" },
    { key: "stat_blk", label: "BLK" },
  ],
  nhl: [
    { key: "stat_goals", label: "G" },
    { key: "stat_assists", label: "A" },
    { key: "stat_sog", label: "SOG" },
  ],
  nfl: [
    { key: "stat_pass_yds", label: "Pass Yds" },
    { key: "stat_rush_yds", label: "Rush Yds" },
    { key: "stat_rec", label: "Rec" },
    { key: "stat_rec_yds", label: "Rec Yds" },
    { key: "stat_pass_td", label: "Pass TD" },
    { key: "stat_rush_td", label: "Rush TD" },
  ],
  mlb: [
    { key: "stat_h", label: "H" },
    { key: "stat_rbi", label: "RBI" },
    { key: "stat_r", label: "R" },
    { key: "stat_hr", label: "HR" },
    { key: "stat_sb", label: "SB" },
    { key: "stat_k", label: "K" },
    { key: "stat_ip", label: "IP" },
  ],
  "premier-league": [
    { key: "stat_goals", label: "Goals" },
    { key: "stat_assists", label: "Assists" },
    { key: "stat_sog", label: "Shots" },
  ],
};

// Expected regular-season game counts per league
const EXPECTED_GAMES: Record<string, number> = {
  nba: 82,
  nhl: 82,
  nfl: 17,
  mlb: 162,
  "premier-league": 38,
};



// ─── Shared helpers ─────────────────────────────────────────────────────────

function fmt(v: number | null | undefined): string {
  if (v == null || v === 0) return "—";
  return Number(v).toFixed(1);
}

function fmtOdds(v: string | number | null | undefined): string {
  if (v == null) return "";
  const n = Number(v);
  if (isNaN(n)) return String(v);
  return n > 0 ? `+${n}` : String(n);
}

/** Market key → short display label */
function marketLabel(m: string): string {
  const map: Record<string, string> = {
    player_points: "PTS",
    player_rebounds: "REB",
    player_assists: "AST",
    player_threes: "3PM",
    player_blocks: "BLK",
    player_steals: "STL",
    player_points_rebounds_assists: "PRA",
    player_points_rebounds: "PR",
    player_points_assists: "PA",
    player_rebounds_assists: "RA",
    player_goals: "Goals",
    player_shots_on_target: "SOT",
    player_shots: "Shots",
    batter_hits: "H",
    batter_total_bases: "TB",
    batter_rbis: "RBI",
    player_pass_yds: "Pass Yds",
    player_rush_yds: "Rush Yds",
    player_reception_yds: "Rec Yds",
    player_pass_tds: "Pass TD",
    player_receptions: "Rec",
    player_anytime_td: "Any TD",
  };
  return map[m] ?? m.replace("player_", "").replace(/_/g, " ");
}

/** Data quality dot color: green / yellow / red */
function qualityColor(games: number, leagueSlug: string): string {
  const expected = EXPECTED_GAMES[leagueSlug];
  if (!expected) return "bg-white/20"; // unknown league
  const ratio = games / expected;
  if (ratio >= 0.9) return "bg-emerald-400";
  if (ratio >= 0.7) return "bg-yellow-400";
  return "bg-red-400";
}

// ─── Data hooks: Player mode ────────────────────────────────────────────────

function usePlayerSearch(query: string) {
  return useQuery({
    queryKey: ["player-search-master", query],
    queryFn: async () => {
      if (query.length < 2) return [];
      const { data } = await supabase
        .from("back_in_play_master_players")
        .select("player_name, player_team, player_position, league_slug")
        .ilike("player_name", `%${query}%`)
        .limit(20);
      if (!data) return [];
      return data.map((row: any) => ({
        player_name: row.player_name,
        position: row.player_position,
        team: { team_name: row.player_team },
        league: { slug: row.league_slug },
      }));
    },
    enabled: query.length >= 2,
  });
}

function usePlayerGameLogs(playerName: string | null, leagueSlug: string | null) {
  return useQuery({
    queryKey: ["player-game-logs-master", playerName, leagueSlug],
    queryFn: async () => {
      if (!playerName) return [];
      const allLogs: any[] = [];
      let offset = 0;
      const PAGE = 1000;
      while (true) {
        const { data } = await supabase
          .from("back_in_play_master_games")
          .select("*")
          .eq("player_name", playerName)
          .eq("league_slug", leagueSlug ?? "nba")
          .order("game_date", { ascending: false })
          .range(offset, offset + PAGE - 1);
        if (!data || data.length === 0) break;
        allLogs.push(...data);
        if (data.length < PAGE) break;
        offset += PAGE;
      }
      return allLogs;
    },
    enabled: !!playerName,
  });
}

function usePlayerInjuries(playerName: string | null, leagueSlug: string | null) {
  return useQuery({
    queryKey: ["player-injuries-corrected", playerName, leagueSlug],
    queryFn: async () => {
      if (!playerName) return [];
      const { data, error } = await supabase
        .from("back_in_play_injuries_corrected")
        .select(
          "date_injured, return_date, injury_type, games_missed, grade, start_day_diff, return_day_diff, match_notes, original_date_injured, original_return_date"
        )
        .eq("player_name", playerName)
        .eq("league_slug", leagueSlug ?? "nba")
        .in("grade", ["A", "B"])
        .order("date_injured", { ascending: false })
        .limit(200);
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!playerName,
  });
}

/** Fetch ALL props for a player (across all game dates) for overlay on game logs */
function usePlayerAllProps(playerId: string | null) {
  return useQuery({
    queryKey: ["player-all-props", playerId],
    queryFn: async () => {
      if (!playerId) return new Map<string, any[]>();
      const allProps: any[] = [];
      let offset = 0;
      const PAGE = 1000;
      while (true) {
        const { data } = await supabase
          .from("back_in_play_player_props")
          .select("game_date, market, line, over_price, under_price, source")
          .eq("player_id", playerId)
          .order("game_date", { ascending: false })
          .range(offset, offset + PAGE - 1);
        if (!data || data.length === 0) break;
        allProps.push(...data);
        if (data.length < PAGE) break;
        offset += PAGE;
      }
      // Group by game_date
      const byDate = new Map<string, any[]>();
      for (const p of allProps) {
        const existing = byDate.get(p.game_date) ?? [];
        existing.push(p);
        byDate.set(p.game_date, existing);
      }
      return byDate;
    },
    enabled: !!playerId,
  });
}

/** Fetch game scores + odds + ESPN event_id for a player's team, keyed by game_date */
function usePlayerGameContext(playerTeamName: string | null, leagueSlug: string | null) {
  return useQuery({
    queryKey: ["player-game-context", playerTeamName, leagueSlug],
    queryFn: async () => {
      if (!playerTeamName || !leagueSlug) return new Map<string, any>();

      // Load games where this team is home or away
      let allGames: any[] = [];
      let offset = 0;
      const PAGE = 1000;
      while (true) {
        const { data } = await supabase
          .from("back_in_play_games")
          .select("game_date, home_team, away_team, home_score, away_score, event_id")
          .eq("league_slug", leagueSlug)
          .or(`home_team.eq.${playerTeamName},away_team.eq.${playerTeamName}`)
          .range(offset, offset + PAGE - 1);
        if (!data || data.length === 0) break;
        allGames.push(...data);
        if (data.length < PAGE) break;
        offset += PAGE;
      }

      // Load odds for this sport
      const sportKey: Record<string, string> = {
        nba: "basketball_nba", nhl: "icehockey_nhl", nfl: "americanfootball_nfl", mlb: "baseball_mlb",
      };
      const sk = sportKey[leagueSlug];
      let allOdds: any[] = [];
      if (sk) {
        offset = 0;
        while (true) {
          const { data } = await supabase
            .from("back_in_play_game_odds")
            .select("game_date, home_team, away_team, h2h_home_price, h2h_away_price, spread_home_line, total_line, source")
            .eq("sport_key", sk)
            .in("source", ["fanduel", "draftkings"])
            .range(offset, offset + PAGE - 1);
          if (!data || data.length === 0) break;
          allOdds.push(...data);
          if (data.length < PAGE) break;
          offset += PAGE;
        }
      }

      // Index games by date
      const byDate = new Map<string, any>();
      for (const g of allGames) {
        byDate.set(g.game_date, g);
      }

      // Index odds by date+home (dedup prefer fanduel)
      const oddsByDate = new Map<string, any>();
      for (const o of allOdds) {
        const key = o.game_date;
        const existing = oddsByDate.get(key);
        if (!existing || o.source === "fanduel") {
          oddsByDate.set(key, o);
        }
      }

      // Merge
      const result = new Map<string, any>();
      for (const [date, game] of byDate) {
        const odds = oddsByDate.get(date);
        result.set(date, { ...game, odds });
      }
      return result;
    },
    enabled: !!playerTeamName && !!leagueSlug,
    staleTime: 120_000,
  });
}

// ─── Data hooks: Team mode ──────────────────────────────────────────────────

function useTeamSearch(query: string) {
  return useQuery({
    queryKey: ["team-search", query],
    queryFn: async () => {
      if (query.length < 2) return [];
      const { data } = await supabase
        .from("back_in_play_teams")
        .select(
          "team_id, team_name, espn_team_id, league:back_in_play_leagues(slug, league_name)"
        )
        .ilike("team_name", `%${query}%`)
        .neq("team_name", "Unknown")
        .limit(20);
      return data ?? [];
    },
    enabled: query.length >= 2,
  });
}

function useTeamRoster(teamId: string | null) {
  return useQuery({
    queryKey: ["team-roster", teamId],
    queryFn: async () => {
      if (!teamId) return [];
      const { data } = await supabase
        .from("back_in_play_players")
        .select("player_id, player_name, position, is_star, is_starter")
        .eq("team_id", teamId)
        .order("player_name")
        .limit(200);
      return data ?? [];
    },
    enabled: !!teamId,
  });
}

function useTeamSchedule(teamName: string | null, leagueSlug: string | null) {
  return useQuery({
    queryKey: ["team-schedule", teamName, leagueSlug],
    queryFn: async () => {
      if (!teamName) return [];
      // Query back_in_play_games where team is home or away
      const allGames: any[] = [];
      let offset = 0;
      const PAGE = 1000;
      while (true) {
        const { data } = await supabase
          .from("back_in_play_games")
          .select("game_date, home_team, away_team, home_score, away_score, season")
          .or(`home_team.ilike.%${teamName}%,away_team.ilike.%${teamName}%`)
          .order("game_date", { ascending: false })
          .range(offset, offset + PAGE - 1);
        if (!data || data.length === 0) break;
        allGames.push(...data);
        if (data.length < PAGE) break;
        offset += PAGE;
      }
      return allGames;
    },
    enabled: !!teamName,
  });
}

// ─── Derived data ───────────────────────────────────────────────────────────

interface SeasonSummary {
  season: number;
  games: number;
  averages: Record<string, number>;
  logs: any[];
}

function buildSeasonSummaries(logs: any[], leagueSlug: string): SeasonSummary[] {
  const statDefs = LEAGUE_STATS[leagueSlug] ?? LEAGUE_STATS.nba;
  const bySeason = new Map<number, any[]>();
  for (const log of logs) {
    const s = log.season ?? 0;
    if (!bySeason.has(s)) bySeason.set(s, []);
    bySeason.get(s)!.push(log);
  }

  const summaries: SeasonSummary[] = [];
  for (const [season, seasonLogs] of bySeason) {
    const averages: Record<string, number> = {};
    for (const stat of statDefs) {
      const vals = seasonLogs.map((l: any) => l[stat.key]).filter((v: any) => v != null && v !== 0);
      averages[stat.key] = vals.length > 0 ? vals.reduce((a: number, b: number) => a + b, 0) / vals.length : 0;
    }
    summaries.push({ season, games: seasonLogs.length, averages, logs: seasonLogs });
  }

  summaries.sort((a, b) => b.season - a.season);
  return summaries;
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function InjuryHistorySection({ playerName, leagueSlug }: { playerName: string; leagueSlug: string }) {
  const { data: injuries, isLoading } = usePlayerInjuries(playerName, leagueSlug);

  if (isLoading) return <p className="text-white/20 text-xs py-2 animate-pulse">Loading injuries...</p>;
  if (!injuries || injuries.length === 0) return null;

  return (
    <div className="bg-amber-500/[0.06] border border-amber-500/20 rounded-xl p-4 mb-6">
      <h3 className="text-sm font-bold text-amber-400 mb-2">Verified Injury History ({injuries.length})</h3>
      <p className="text-[10px] text-amber-400/30 mb-2">Grade A+B injuries verified against ESPN box scores. Dates corrected from actual game absences.</p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-amber-400/50 border-b border-amber-500/10">
              <th className="px-2 py-1.5 text-center font-medium">Grade</th>
              <th className="px-2 py-1.5 text-left font-medium">Injured</th>
              <th className="px-2 py-1.5 text-left font-medium">Returned</th>
              <th className="px-2 py-1.5 text-left font-medium">Injury</th>
              <th className="px-2 py-1.5 text-right font-medium">GP Missed</th>
              <th className="px-2 py-1.5 text-left font-medium text-white/20">Original Dates</th>
            </tr>
          </thead>
          <tbody>
            {injuries.map((inj: any, i: number) => (
              <tr key={i} className="border-b border-amber-500/[0.06] hover:bg-amber-500/[0.04]">
                <td className="px-2 py-1 text-center">
                  <span className={`text-[10px] font-bold ${inj.grade === "A" ? "text-emerald-400" : "text-blue-400"}`}>{inj.grade}</span>
                </td>
                <td className="px-2 py-1 font-mono text-amber-300/70">{inj.date_injured || "—"}</td>
                <td className="px-2 py-1 font-mono text-white/40">{inj.return_date || "—"}</td>
                <td className="px-2 py-1 text-amber-300/80">{inj.injury_type || "—"}</td>
                <td className="px-2 py-1 text-right font-mono text-white/50">{inj.games_missed ?? "—"}</td>
                <td className="px-2 py-1 text-[10px] text-white/15 font-mono" title={inj.match_notes ?? ""}>
                  {inj.original_date_injured ?? ""} → {inj.original_return_date ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PropsSubRow({ props }: { props: any[] }) {
  if (!props || props.length === 0) return null;
  const items = props.map(
    (p) => `${marketLabel(p.market)} ${p.line} (${fmtOdds(p.over_price)}/${fmtOdds(p.under_price)})`
  );
  return (
    <tr>
      <td colSpan={99} className="px-3 py-0.5 pb-1.5">
        <span className="text-[10px] text-white/20">Props: </span>
        <span className="text-[10px] text-white/25">{items.join(" · ")}</span>
      </td>
    </tr>
  );
}

// ─── Player Mode ────────────────────────────────────────────────────────────

function PlayerMode() {
  const [searchText, setSearchText] = useState("");
  const [selectedPlayer, setSelectedPlayer] = useState<any>(null);
  const [expandedSeason, setExpandedSeason] = useState<number | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);

  const leagueSlug: string = (selectedPlayer?.league as any)?.slug ?? "nba";
  const teamName: string = (selectedPlayer?.team as any)?.team_name ?? null;

  const { data: searchResults, isLoading: searching } = usePlayerSearch(searchText);
  const { data: gameLogs, isLoading: loadingLogs } = usePlayerGameLogs(selectedPlayer?.player_name ?? null, leagueSlug);
  const { data: propsMap } = usePlayerAllProps(selectedPlayer?.player_id ?? null);
  const { data: gameContext } = usePlayerGameContext(teamName, leagueSlug);
  const statDefs = LEAGUE_STATS[leagueSlug] ?? LEAGUE_STATS.nba;

  const seasonSummaries = useMemo(() => {
    if (!gameLogs || gameLogs.length === 0) return [];
    return buildSeasonSummaries(gameLogs, leagueSlug);
  }, [gameLogs, leagueSlug]);

  function selectPlayer(p: any) {
    setSelectedPlayer(p);
    setSearchText(p.player_name);
    setShowDropdown(false);
    setExpandedSeason(null);
  }

  return (
    <>
      {/* Search */}
      <div className="relative mb-6">
        <input
          type="text"
          value={searchText}
          onChange={(e) => {
            setSearchText(e.target.value);
            setShowDropdown(true);
          }}
          onFocus={() => setShowDropdown(true)}
          placeholder="Search player name..."
          className="w-full rounded-lg bg-white/5 border border-white/10 px-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-blue-500/40"
        />
        {showDropdown && searchText.length >= 2 && (
          <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-[#111827] border border-white/10 rounded-lg shadow-xl max-h-64 overflow-y-auto">
            {searching && <p className="px-4 py-3 text-xs text-white/30">Searching...</p>}
            {!searching && searchResults && searchResults.length === 0 && (
              <p className="px-4 py-3 text-xs text-white/30">No players found</p>
            )}
            {searchResults?.map((p: any) => (
              <button
                key={p.player_id}
                onClick={() => selectPlayer(p)}
                className="w-full text-left px-4 py-2.5 hover:bg-white/5 flex items-center gap-3 border-b border-white/5 last:border-0"
              >
                <span className="text-sm text-white">{p.player_name}</span>
                <span className="text-[10px] text-white/30">
                  {p.position} · {(p.team as any)?.team_name ?? "?"} · {((p.league as any)?.slug ?? "").toUpperCase()}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Player Info */}
      {selectedPlayer && (
        <div className="bg-white/5 border border-white/10 rounded-xl p-4 mb-6">
          <h2 className="text-lg font-bold">{selectedPlayer.player_name}</h2>
          <div className="flex gap-3 mt-1 text-xs text-white/40">
            <span>{selectedPlayer.position}</span>
            <span>{(selectedPlayer.team as any)?.team_name ?? "—"}</span>
            <span>{leagueSlug.toUpperCase()}</span>
            <span className="text-white/20">ID: {selectedPlayer.player_id}</span>
          </div>
        </div>
      )}

      {/* Injury History */}
      {selectedPlayer && <InjuryHistorySection playerName={selectedPlayer.player_name} leagueSlug={leagueSlug} />}

      {/* Loading */}
      {loadingLogs && selectedPlayer && (
        <p className="text-white/30 text-sm text-center py-8 animate-pulse">Loading game logs...</p>
      )}

      {/* No data */}
      {selectedPlayer && !loadingLogs && gameLogs && gameLogs.length === 0 && (
        <div className="bg-white/[0.02] rounded-xl p-6 text-center">
          <p className="text-white/30 text-sm">No game logs found for this player.</p>
        </div>
      )}

      {/* Season Summaries */}
      {seasonSummaries.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-white/30 mb-2">
            {gameLogs?.length ?? 0} total game logs across {seasonSummaries.length} season
            {seasonSummaries.length > 1 ? "s" : ""}
          </p>

          {seasonSummaries.map((ss) => {
            const dotColor = qualityColor(ss.games, leagueSlug);
            const expected = EXPECTED_GAMES[leagueSlug];
            const pct = expected ? Math.round((ss.games / expected) * 100) : null;

            return (
              <div key={ss.season} className="bg-white/[0.03] border border-white/[0.06] rounded-xl overflow-hidden">
                {/* Season header — clickable */}
                <button
                  onClick={() => setExpandedSeason(expandedSeason === ss.season ? null : ss.season)}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/[0.02] transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <span className={`w-2 h-2 rounded-full ${dotColor} flex-shrink-0`} title={pct != null ? `${pct}% of expected ${expected} GP` : undefined} />
                    <span className="text-sm font-bold text-white">{ss.season}</span>
                    <span className="text-xs text-white/30">
                      {ss.games} GP{pct != null ? ` (${pct}%)` : ""}
                    </span>
                  </div>
                  <div className="flex items-center gap-4">
                    {statDefs.map((s) => (
                      <div key={s.key} className="text-right">
                        <p className="text-[9px] text-white/20">{s.label}</p>
                        <p className="text-xs font-mono text-white/60">{fmt(ss.averages[s.key])}</p>
                      </div>
                    ))}
                    <span className="text-white/20 text-xs ml-2">{expandedSeason === ss.season ? "▲" : "▼"}</span>
                  </div>
                </button>

                {/* Expanded game logs with props */}
                {expandedSeason === ss.season && (
                  <div className="border-t border-white/[0.06]">
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-white/20 border-b border-white/[0.06]">
                            <th className="px-3 py-2 text-left font-medium">Date</th>
                            <th className="px-3 py-2 text-left font-medium">Opp</th>
                            <th className="px-3 py-2 text-center font-medium">Score</th>
                            <th className="px-3 py-2 text-right font-medium">Min</th>
                            {statDefs.map((s) => (
                              <th key={s.key} className="px-3 py-2 text-right font-medium">
                                {s.label}
                              </th>
                            ))}
                            <th className="px-2 py-2 text-right font-medium text-white/15">Spread</th>
                            <th className="px-2 py-2 text-right font-medium text-white/15">Total</th>
                            <th className="px-2 py-2 text-right font-medium text-white/15">ML</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ss.logs.map((log: any, i: number) => {
                            const dateProps = propsMap?.get(log.game_date) ?? [];
                            const ctx = gameContext?.get(log.game_date);
                            const odds = ctx?.odds;
                            const espnUrl = ctx?.event_id ? `https://www.espn.com/${leagueSlug === "premier-league" ? "soccer" : leagueSlug}/game/_/gameId/${ctx.event_id}` : null;
                            const scoreText = ctx?.home_score != null ? `${ctx.home_score}-${ctx.away_score}` : null;

                            return (
                              <Fragment key={i}>
                                <tr className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                                  <td className="px-3 py-1.5 text-white/50 font-mono">
                                    {log.game_date}
                                    {dateProps.length > 0 && (
                                      <span className="ml-1 text-[9px] text-blue-400/40">P</span>
                                    )}
                                  </td>
                                  <td className="px-3 py-1.5 text-white/40">{log.opponent || "—"}</td>
                                  <td className="px-3 py-1.5 text-center font-mono">
                                    {espnUrl && scoreText ? (
                                      <a href={espnUrl} target="_blank" rel="noopener noreferrer"
                                         className="text-blue-400/60 hover:text-blue-400 text-[10px]">{scoreText}</a>
                                    ) : scoreText ? (
                                      <span className="text-white/30 text-[10px]">{scoreText}</span>
                                    ) : <span className="text-white/15 text-[10px]">—</span>}
                                  </td>
                                  <td className="px-3 py-1.5 text-right text-white/40 font-mono">
                                    {log.minutes != null ? Math.round(log.minutes) : "—"}
                                  </td>
                                  {statDefs.map((s) => (
                                    <td key={s.key} className="px-3 py-1.5 text-right font-mono text-white/50">
                                      {log[s.key] != null ? log[s.key] : "—"}
                                    </td>
                                  ))}
                                  <td className="px-2 py-1.5 text-right font-mono text-white/20 text-[10px]">
                                    {odds?.spread_home_line != null ? fmtOdds(odds.spread_home_line) : "—"}
                                  </td>
                                  <td className="px-2 py-1.5 text-right font-mono text-white/20 text-[10px]">
                                    {odds?.total_line ?? "—"}
                                  </td>
                                  <td className="px-2 py-1.5 text-right font-mono text-white/20 text-[10px]">
                                    {odds?.h2h_home_price != null ? fmtOdds(odds.h2h_home_price) : "—"}
                                  </td>
                                </tr>
                                {dateProps.length > 0 && <PropsSubRow props={dateProps} />}
                              </Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ─── Team Mode ──────────────────────────────────────────────────────────────

function TeamMode() {
  const [searchText, setSearchText] = useState("");
  const [selectedTeam, setSelectedTeam] = useState<any>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [expandedSeason, setExpandedSeason] = useState<string | null>(null);

  const { data: searchResults, isLoading: searching } = useTeamSearch(searchText);
  const { data: roster, isLoading: loadingRoster } = useTeamRoster(selectedTeam?.team_id ?? null);
  const { data: schedule, isLoading: loadingSchedule } = useTeamSchedule(
    selectedTeam?.team_name ?? null,
    (selectedTeam?.league as any)?.slug ?? null
  );

  const leagueSlug: string = (selectedTeam?.league as any)?.slug ?? "";

  // Group schedule by season
  const scheduleBySeason = useMemo(() => {
    if (!schedule || schedule.length === 0) return [];
    const bySeason = new Map<string, any[]>();
    for (const g of schedule) {
      const s = g.season ?? "Unknown";
      if (!bySeason.has(s)) bySeason.set(s, []);
      bySeason.get(s)!.push(g);
    }
    const out = Array.from(bySeason.entries()).map(([season, games]) => ({ season, games }));
    out.sort((a, b) => (b.season > a.season ? 1 : -1));
    return out;
  }, [schedule]);

  function selectTeam(t: any) {
    setSelectedTeam(t);
    setSearchText(t.team_name);
    setShowDropdown(false);
    setExpandedSeason(null);
  }

  return (
    <>
      {/* Search */}
      <div className="relative mb-6">
        <input
          type="text"
          value={searchText}
          onChange={(e) => {
            setSearchText(e.target.value);
            setShowDropdown(true);
          }}
          onFocus={() => setShowDropdown(true)}
          placeholder="Search team name..."
          className="w-full rounded-lg bg-white/5 border border-white/10 px-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-blue-500/40"
        />
        {showDropdown && searchText.length >= 2 && (
          <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-[#111827] border border-white/10 rounded-lg shadow-xl max-h-64 overflow-y-auto">
            {searching && <p className="px-4 py-3 text-xs text-white/30">Searching...</p>}
            {!searching && searchResults && searchResults.length === 0 && (
              <p className="px-4 py-3 text-xs text-white/30">No teams found</p>
            )}
            {searchResults?.map((t: any) => (
              <button
                key={t.team_id}
                onClick={() => selectTeam(t)}
                className="w-full text-left px-4 py-2.5 hover:bg-white/5 flex items-center gap-3 border-b border-white/5 last:border-0"
              >
                <span className="text-sm text-white">{t.team_name}</span>
                <span className="text-[10px] text-white/30">
                  {((t.league as any)?.slug ?? "").toUpperCase()}
                  {t.espn_team_id ? ` · ESPN: ${t.espn_team_id}` : ""}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Team Info */}
      {selectedTeam && (
        <div className="bg-white/5 border border-white/10 rounded-xl p-4 mb-6">
          <h2 className="text-lg font-bold">{selectedTeam.team_name}</h2>
          <div className="flex gap-3 mt-1 text-xs text-white/40">
            <span>{((selectedTeam.league as any)?.league_name ?? leagueSlug).toUpperCase()}</span>
            <span className="text-white/20">ID: {selectedTeam.team_id}</span>
            {selectedTeam.espn_team_id && <span className="text-white/20">ESPN: {selectedTeam.espn_team_id}</span>}
          </div>
        </div>
      )}

      {/* Roster */}
      {selectedTeam && (
        <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4 mb-6">
          <h3 className="text-sm font-bold text-white/70 mb-2">
            Current Roster
            {loadingRoster && <span className="text-white/20 font-normal ml-2 animate-pulse">loading...</span>}
          </h3>
          {roster && roster.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {roster.map((p: any) => (
                <span
                  key={p.player_id}
                  className={`text-[11px] px-2 py-0.5 rounded border ${
                    p.is_star
                      ? "border-yellow-500/30 bg-yellow-500/10 text-yellow-300"
                      : p.is_starter
                        ? "border-blue-500/20 bg-blue-500/[0.06] text-blue-300/80"
                        : "border-white/[0.06] bg-white/[0.02] text-white/40"
                  }`}
                >
                  {p.player_name}
                  <span className="text-[9px] text-white/20 ml-1">{p.position}</span>
                </span>
              ))}
            </div>
          ) : !loadingRoster ? (
            <p className="text-xs text-white/20">No roster data found.</p>
          ) : null}
        </div>
      )}

      {/* Schedule */}
      {loadingSchedule && selectedTeam && (
        <p className="text-white/30 text-sm text-center py-8 animate-pulse">Loading schedule...</p>
      )}

      {selectedTeam && !loadingSchedule && schedule && schedule.length === 0 && (
        <div className="bg-white/[0.02] rounded-xl p-6 text-center">
          <p className="text-white/30 text-sm">No schedule data found in back_in_play_games.</p>
        </div>
      )}

      {scheduleBySeason.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-white/30 mb-2">
            {schedule?.length ?? 0} total games across {scheduleBySeason.length} season
            {scheduleBySeason.length > 1 ? "s" : ""}
          </p>

          {scheduleBySeason.map((ss) => (
            <div key={ss.season} className="bg-white/[0.03] border border-white/[0.06] rounded-xl overflow-hidden">
              <button
                onClick={() => setExpandedSeason(expandedSeason === ss.season ? null : ss.season)}
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/[0.02] transition-colors"
              >
                <div className="flex items-center gap-3">
                  <span className="text-sm font-bold text-white">{ss.season}</span>
                  <span className="text-xs text-white/30">{ss.games.length} games</span>
                </div>
                <span className="text-white/20 text-xs">{expandedSeason === ss.season ? "▲" : "▼"}</span>
              </button>

              {expandedSeason === ss.season && (
                <div className="border-t border-white/[0.06]">
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-white/20 border-b border-white/[0.06]">
                          <th className="px-3 py-2 text-left font-medium">Date</th>
                          <th className="px-3 py-2 text-left font-medium">Home</th>
                          <th className="px-3 py-2 text-center font-medium">Score</th>
                          <th className="px-3 py-2 text-left font-medium">Away</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ss.games.map((g: any, i: number) => {
                          const isHome = (g.home_team ?? "").toLowerCase().includes((selectedTeam?.team_name ?? "").toLowerCase());
                          return (
                            <tr key={i} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                              <td className="px-3 py-1.5 text-white/50 font-mono">{g.game_date}</td>
                              <td className={`px-3 py-1.5 ${isHome ? "text-blue-300/70 font-medium" : "text-white/40"}`}>
                                {g.home_team}
                              </td>
                              <td className="px-3 py-1.5 text-center font-mono text-white/50">
                                {g.home_score != null && g.away_score != null
                                  ? `${g.home_score} - ${g.away_score}`
                                  : "—"}
                              </td>
                              <td className={`px-3 py-1.5 ${!isHome ? "text-blue-300/70 font-medium" : "text-white/40"}`}>
                                {g.away_team}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ─── Coverage mode ───────────────────────────────────────────────────────────

const SPORT_KEYS: Record<string, string> = {
  basketball_nba: "NBA",
  icehockey_nhl: "NHL",
  americanfootball_nfl: "NFL",
  baseball_mlb: "MLB",
  soccer_epl: "EPL",
};

const SPORT_EXPECTED: Record<string, number> = {
  basketball_nba: 82,
  icehockey_nhl: 82,
  americanfootball_nfl: 17,
  baseball_mlb: 162,
  soccer_epl: 38,
};

type TeamSeasonOdds = {
  sport: string; label: string; season: string; team: string;
  expected: number;
  ml: number; spread: number; total: number;       // open
  closeMl: number; closeSpread: number; closeTotal: number; // close
};

/** Fetch per-team odds coverage — paginated to handle >1000 rows */
function useOddsCoverage(dkFdOnly: boolean) {
  return useQuery({
    queryKey: ["odds-coverage-v3", dkFdOnly],
    queryFn: async () => {
      const rows: TeamSeasonOdds[] = [];
      for (const [sportKey, label] of Object.entries(SPORT_KEYS)) {
        const expected = SPORT_EXPECTED[sportKey] ?? 0;
        // Paginate: fetch events with market-level detail
        let allData: any[] = [];
        let offset = 0;
        const PAGE = 1000;
        while (true) {
          let query = supabase
            .from("back_in_play_game_odds")
            .select("event_id, game_date, home_team, away_team, source, h2h_home_price, spread_home_line, total_line, close_h2h_home_price, close_spread_home_line, close_total_line")
            .eq("sport_key", sportKey)
            .order("event_id")
            .range(offset, offset + PAGE - 1);
          if (dkFdOnly) {
            query = query.in("source", ["fanduel", "draftkings"]);
          }
          const { data } = await query;
          if (!data || data.length === 0) break;
          allData.push(...data);
          if (data.length < PAGE) break;
          offset += PAGE;
        }
        // Dedup by event_id — merge across bookmaker rows (pick best data per field)
        const eventMap = new Map<string, any>();
        for (const r of allData) {
          const existing = eventMap.get(r.event_id);
          if (!existing) {
            eventMap.set(r.event_id, { ...r });
          } else {
            // Merge: keep non-null values from any source
            for (const key of ["h2h_home_price", "spread_home_line", "total_line",
                               "close_h2h_home_price", "close_spread_home_line", "close_total_line"]) {
              if (r[key] != null && existing[key] == null) existing[key] = r[key];
            }
          }
        }
        // Build per-team per-season counts with per-market breakdown
        type MktCounts = { ml: number; spread: number; total: number; closeMl: number; closeSpread: number; closeTotal: number };
        const teamCounts: Record<string, Record<string, MktCounts>> = {};
        for (const r of eventMap.values()) {
          const d = r.game_date;
          if (!d) continue;
          const yr = parseInt(d.slice(0, 4));
          const mo = parseInt(d.slice(5, 7));
          const seasonYr = mo >= 7 ? yr : yr - 1;
          const season = sportKey === "americanfootball_nfl"
            ? `${seasonYr}`
            : `${seasonYr}-${String(seasonYr + 1).slice(2)}`;
          for (const team of [r.home_team, r.away_team]) {
            if (!team) continue;
            if (!teamCounts[season]) teamCounts[season] = {};
            if (!teamCounts[season][team]) teamCounts[season][team] = { ml: 0, spread: 0, total: 0, closeMl: 0, closeSpread: 0, closeTotal: 0 };
            const c = teamCounts[season][team];
            if (r.h2h_home_price != null) c.ml++;
            if (r.spread_home_line != null) c.spread++;
            if (r.total_line != null) c.total++;
            if (r.close_h2h_home_price != null) c.closeMl++;
            if (r.close_spread_home_line != null) c.closeSpread++;
            if (r.close_total_line != null) c.closeTotal++;
          }
        }
        for (const [season, teams] of Object.entries(teamCounts)) {
          for (const [team, c] of Object.entries(teams)) {
            rows.push({ sport: sportKey, label, season, team, expected, ...c });
          }
        }
      }
      return rows;
    },
    staleTime: 120_000,
  });
}

/** Team games list — shows when you click a team in the box scores table */
function TeamGamesList({ league, team, season }: { league: string; team: string; season: number }) {
  const { data, isLoading } = useQuery({
    queryKey: ["team-games-list", league, team, season],
    queryFn: async () => {
      // Query games where this team is home or away for this season
      let allGames: any[] = [];
      let offset = 0;
      const PAGE = 200;
      while (true) {
        const { data: homeGames } = await supabase
          .from("back_in_play_games")
          .select("game_date, home_team, away_team, home_score, away_score, event_id")
          .eq("league_slug", league)
          .eq("season", season)
          .or(`home_team.eq.${team},away_team.eq.${team}`)
          .order("game_date")
          .range(offset, offset + PAGE - 1);
        if (!homeGames || homeGames.length === 0) break;
        allGames.push(...homeGames);
        if (homeGames.length < PAGE) break;
        offset += PAGE;
      }
      return allGames;
    },
    staleTime: 120_000,
  });

  if (isLoading) return <div className="px-4 py-2 text-[10px] text-white/30 animate-pulse">Loading games...</div>;
  if (!data || data.length === 0) return <div className="px-4 py-2 text-[10px] text-white/20">No games found</div>;

  // ESPN URL mapping by sport
  const espnSport: Record<string, string> = { nba: "nba", nhl: "nhl", nfl: "nfl", mlb: "mlb" };
  const sport = espnSport[league] ?? league;

  return (
    <div className="bg-white/[0.01] max-h-[300px] overflow-y-auto">
      <table className="w-full text-[10px]">
        <thead className="sticky top-0 bg-[#0a0f1a]">
          <tr className="text-white/20 border-b border-white/[0.06]">
            <th className="px-2 py-1 text-left">Date</th>
            <th className="px-2 py-1 text-left">Home</th>
            <th className="px-2 py-1 text-center">Score</th>
            <th className="px-2 py-1 text-left">Away</th>
            <th className="px-2 py-1 text-center">Link</th>
          </tr>
        </thead>
        <tbody>
          {data.map((g: any, i: number) => {
            const isHome = g.home_team === team;
            const espnUrl = g.event_id ? `https://www.espn.com/${sport}/game/_/gameId/${g.event_id}` : null;
            return (
              <tr key={i} className="border-b border-white/[0.02] hover:bg-white/[0.02]">
                <td className="px-2 py-0.5 text-white/40 font-mono">{g.game_date}</td>
                <td className={`px-2 py-0.5 ${isHome ? "text-blue-300/70 font-medium" : "text-white/30"}`}>{g.home_team}</td>
                <td className="px-2 py-0.5 text-center font-mono text-white/40">
                  {g.home_score != null ? `${g.home_score}-${g.away_score}` : "—"}
                </td>
                <td className={`px-2 py-0.5 ${!isHome ? "text-blue-300/70 font-medium" : "text-white/30"}`}>{g.away_team}</td>
                <td className="px-2 py-0.5 text-center">
                  {espnUrl ? (
                    <a href={espnUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400/50 hover:text-blue-400 text-[9px]">ESPN</a>
                  ) : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Fetch per-league per-season player game log coverage (derived from player_game_logs) */
const GAMES_LEAGUE_MAP: Record<string, { label: string; expected: number }> = {
  nba: { label: "NBA", expected: 82 },
  nhl: { label: "NHL", expected: 82 },
  nfl: { label: "NFL", expected: 17 },
  mlb: { label: "MLB", expected: 162 },
};

type TeamSeasonGames = { league: string; label: string; season: number; team: string; games: number };

function useGamesCoverage() {
  return useQuery({
    queryKey: ["games-coverage-v4"],
    queryFn: async () => {
      const rows: TeamSeasonGames[] = [];
      for (const [slug, cfg] of Object.entries(GAMES_LEAGUE_MAP)) {
        let allGames: any[] = [];
        let offset = 0;
        const PAGE = 1000;
        while (true) {
          const { data } = await supabase
            .from("back_in_play_games")
            .select("season, home_team, away_team")
            .eq("league_slug", slug)
            .range(offset, offset + PAGE - 1);
          if (!data || data.length === 0) break;
          allGames.push(...data);
          if (data.length < PAGE) break;
          offset += PAGE;
        }
        // Count per team per season (each game counts for both home and away)
        const teamCounts: Record<string, Record<string, number>> = {};
        for (const g of allGames) {
          const season = String(g.season ?? 0);
          if (season === "0") continue;
          for (const team of [g.home_team, g.away_team]) {
            if (!team) continue;
            if (!teamCounts[season]) teamCounts[season] = {};
            teamCounts[season][team] = (teamCounts[season][team] ?? 0) + 1;
          }
        }
        for (const [season, teams] of Object.entries(teamCounts)) {
          for (const [team, count] of Object.entries(teams)) {
            rows.push({ league: slug, label: cfg.label, season: parseInt(season), team, games: count });
          }
        }
      }
      return rows;
    },
    staleTime: 120_000,
  });
}

/** Color helper for coverage numbers */
function covColor(val: number, exp: number) {
  if (exp <= 0) return "text-white/50";
  const pct = val / exp;
  if (pct >= 0.9) return "text-emerald-400";
  if (pct >= 0.6) return "text-yellow-400";
  return "text-red-400";
}

/** Per-team odds table with ML/Spread/Total breakdown + "All 3" summary */
function OddsCoverageTable({ data }: { data: TeamSeasonOdds[] }) {
  const sorted = [...data].sort((a, b) => a.team.localeCompare(b.team));
  const c = "px-1.5 py-1 text-xs text-right font-mono";
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-white/30 border-b border-white/[0.06]">
            <th className="px-2 py-1.5 text-left font-medium">Team</th>
            <th className="px-1.5 py-1.5 text-right font-medium" title="Open moneyline">ML</th>
            <th className="px-1.5 py-1.5 text-right font-medium" title="Open spread">Sprd</th>
            <th className="px-1.5 py-1.5 text-right font-medium" title="Open total">Tot</th>
            <th className="px-1.5 py-1.5 text-right font-medium text-white/50" title="Games with all 3 open markets">All3</th>
            <th className="px-1.5 py-1.5 text-center font-medium text-white/20">|</th>
            <th className="px-1.5 py-1.5 text-right font-medium" title="Close moneyline">cML</th>
            <th className="px-1.5 py-1.5 text-right font-medium" title="Close spread">cSprd</th>
            <th className="px-1.5 py-1.5 text-right font-medium" title="Close total">cTot</th>
            <th className="px-1.5 py-1.5 text-right font-medium text-white/50" title="Games with all 3 close markets">cAll3</th>
            <th className="px-1.5 py-1.5 text-right font-medium text-white/20">Exp</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => {
            const all3Open = Math.min(r.ml, r.spread, r.total);
            const all3Close = Math.min(r.closeMl, r.closeSpread, r.closeTotal);
            return (
              <tr key={i} className="border-b border-white/[0.02] hover:bg-white/[0.02]">
                <td className="px-2 py-1 text-xs text-white/50">{r.team}</td>
                <td className={`${c} ${covColor(r.ml, r.expected)}`}>{r.ml}</td>
                <td className={`${c} ${covColor(r.spread, r.expected)}`}>{r.spread}</td>
                <td className={`${c} ${covColor(r.total, r.expected)}`}>{r.total}</td>
                <td className={`${c} font-bold ${covColor(all3Open, r.expected)}`}>{all3Open}</td>
                <td className="px-0.5 text-white/10 text-center">|</td>
                <td className={`${c} ${covColor(r.closeMl, r.expected)}`}>{r.closeMl}</td>
                <td className={`${c} ${covColor(r.closeSpread, r.expected)}`}>{r.closeSpread}</td>
                <td className={`${c} ${covColor(r.closeTotal, r.expected)}`}>{r.closeTotal}</td>
                <td className={`${c} font-bold ${covColor(all3Close, r.expected)}`}>{all3Close}</td>
                <td className={`${c} text-white/20`}>{r.expected}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CoverageMode() {
  const [dkFdOnly, setDkFdOnly] = useState(true);
  const { data: odds, isLoading: loadingOdds } = useOddsCoverage(dkFdOnly);
  const { data: gamesData, isLoading: loadingGames } = useGamesCoverage();
  const [expandedOdds, setExpandedOdds] = useState<string | null>(null);
  const [expandedGames, setExpandedGames] = useState<string | null>(null);
  const [selectedTeamGames, setSelectedTeamGames] = useState<string | null>(null);
  const [showOddsInfo, setShowOddsInfo] = useState(false);
  const [showGamesInfo, setShowGamesInfo] = useState(false);

  // Group games by league+season
  const gamesBySeason = useMemo(() => {
    if (!gamesData) return {};
    const grouped: Record<string, { label: string; expected: number; teams: TeamSeasonGames[]; totalGames: number }> = {};
    for (const r of gamesData) {
      const seasonLabel = r.league === "nfl" ? `${r.season}` : `${r.season}-${String(r.season + 1).slice(2)}`;
      const key = `${r.league}|${seasonLabel}`;
      if (!grouped[key]) grouped[key] = { label: r.label, expected: GAMES_LEAGUE_MAP[r.league]?.expected ?? 0, teams: [], totalGames: 0 };
      grouped[key].teams.push(r);
      grouped[key].totalGames += r.games;
    }
    return grouped;
  }, [gamesData]);

  // Group odds by sport+season
  const oddsBySportSeason = useMemo(() => {
    if (!odds) return {};
    const grouped: Record<string, { label: string; teams: TeamSeasonOdds[]; expected: number; totals: { ml: number; spread: number; total: number; closeMl: number; closeSpread: number; closeTotal: number } }> = {};
    for (const r of odds) {
      const key = `${r.sport}|${r.season}`;
      if (!grouped[key]) grouped[key] = { label: r.label, teams: [], expected: r.expected, totals: { ml: 0, spread: 0, total: 0, closeMl: 0, closeSpread: 0, closeTotal: 0 } };
      grouped[key].teams.push(r);
      grouped[key].totals.ml += r.ml;
      grouped[key].totals.spread += r.spread;
      grouped[key].totals.total += r.total;
      grouped[key].totals.closeMl += r.closeMl;
      grouped[key].totals.closeSpread += r.closeSpread;
      grouped[key].totals.closeTotal += r.closeTotal;
    }
    return grouped;
  }, [odds]);


  return (
    <>
      {/* Odds Coverage — per team */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-bold text-white/70">Team Odds Coverage (Open & Close)</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setDkFdOnly(!dkFdOnly)}
              className={`px-2 py-1 rounded-md text-[10px] font-medium transition-colors border ${
                dkFdOnly
                  ? "bg-blue-500/20 border-blue-500/30 text-blue-300"
                  : "bg-white/5 border-white/10 text-white/30"
              }`}
            >
              {dkFdOnly ? "DK/FD only" : "All books"}
            </button>
            <button
              onClick={() => setShowOddsInfo(!showOddsInfo)}
              className="shrink-0 w-6 h-6 rounded-full border border-white/15 text-white/35 hover:text-white/70 hover:border-white/30 transition-colors text-xs font-semibold flex items-center justify-center"
              title="Column explanations"
            >?</button>
          </div>
        </div>
        {showOddsInfo && (
          <div className="rounded-lg bg-white/[0.04] border border-white/10 p-3 mb-3 text-[11px] text-white/50 space-y-1">
            <p><span className="text-white/70 font-medium">ML</span> — Games with open moneyline (h2h) odds</p>
            <p><span className="text-white/70 font-medium">Sprd</span> — Games with open spread (point spread) odds</p>
            <p><span className="text-white/70 font-medium">Tot</span> — Games with open game total (over/under) odds</p>
            <p><span className="text-white/70 font-medium">All3</span> — Games where all 3 open markets are present (min of ML, Sprd, Tot). This is the number of fully usable games.</p>
            <p><span className="text-white/70 font-medium">cML / cSprd / cTot</span> — Same as above but for closing odds (odds at game time)</p>
            <p><span className="text-white/70 font-medium">cAll3</span> — Games with all 3 closing markets present</p>
            <p><span className="text-white/70 font-medium">Exp</span> — Expected games per team per season (82 NBA/NHL, 17 NFL, 162 MLB, 38 EPL)</p>
            <p className="pt-1 text-white/30">Colors: <span className="text-emerald-400">green</span> = 90%+ of expected, <span className="text-yellow-400">yellow</span> = 60%+, <span className="text-red-400">red</span> = below 60%</p>
          </div>
        )}
        {loadingOdds ? (
          <p className="text-white/30 text-xs animate-pulse">Loading odds coverage...</p>
        ) : (
          <div className="space-y-1">
            {Object.entries(oddsBySportSeason)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, group]) => {
                const [, season] = key.split("|");
                const n = group.teams.length;
                const t = group.totals;
                const avgAll3 = n > 0 ? Math.round(Math.min(t.ml, t.spread, t.total) / n) : 0;
                const avgAny = n > 0 ? Math.round(Math.max(t.ml, t.spread, t.total) / n) : 0;
                const avgClAll3 = n > 0 ? Math.round(Math.min(t.closeMl, t.closeSpread, t.closeTotal) / n) : 0;
                // Use avgAny for color (so EPL with ML-only doesn't show red)
                const color = avgAny >= group.expected * 0.9 ? "text-emerald-400" : avgAny >= group.expected * 0.5 ? "text-yellow-400" : "text-red-400";
                const all3Color = avgAll3 >= group.expected * 0.9 ? "text-emerald-400" : avgAll3 >= group.expected * 0.5 ? "text-yellow-400" : "text-red-400";
                const clColor = avgClAll3 >= group.expected * 0.8 ? "text-emerald-400" : avgClAll3 >= group.expected * 0.4 ? "text-yellow-400" : "text-red-400";

                return (
                  <div key={key} className="bg-white/[0.03] border border-white/[0.06] rounded-xl overflow-hidden">
                    <button
                      onClick={() => setExpandedOdds(expandedOdds === key ? null : key)}
                      className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-white/[0.02] transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-xs font-bold text-white/70">{group.label}</span>
                        <span className="text-xs text-white/40 font-mono">{season}</span>
                        <span className={`text-xs font-mono ${color}`}>{n} teams</span>
                      </div>
                      <div className="flex items-center gap-4 text-xs">
                        <span className="text-white/30">any <span className={`font-mono ${color}`}>{avgAny}</span>/{group.expected}</span>
                        <span className="text-white/30">all3 <span className={`font-mono ${all3Color}`}>{avgAll3}</span></span>
                        <span className="text-white/30">close <span className={`font-mono ${clColor}`}>{avgClAll3}</span></span>
                        <span className="text-white/20">{expandedOdds === key ? "▲" : "▼"}</span>
                      </div>
                    </button>
                    {expandedOdds === key && (
                      <div className="border-t border-white/[0.06] p-2">
                        <OddsCoverageTable data={group.teams} />
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        )}
      </div>

      {/* Team Box Scores — per team per season */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-bold text-white/70">Team Box Scores (ESPN Games)</h2>
          <button
            onClick={() => setShowGamesInfo(!showGamesInfo)}
            className="shrink-0 w-6 h-6 rounded-full border border-white/15 text-white/35 hover:text-white/70 hover:border-white/30 transition-colors text-xs font-semibold flex items-center justify-center"
            title="Column explanations"
          >?</button>
        </div>
        {showGamesInfo && (
          <div className="rounded-lg bg-white/[0.04] border border-white/10 p-3 mb-3 text-[11px] text-white/50 space-y-1">
            <p><span className="text-white/70 font-medium">Games</span> — Box score games per team from ESPN schedule + box score API</p>
            <p><span className="text-white/70 font-medium">Exp</span> — Expected games per team per season (82 NBA/NHL, 17 NFL, 162 MLB)</p>
            <p className="pt-1 text-white/30">Colors: <span className="text-emerald-400">green</span> = 90%+, <span className="text-yellow-400">yellow</span> = 60%+, <span className="text-red-400">red</span> = below 60%</p>
          </div>
        )}
        {loadingGames ? (
          <p className="text-white/30 text-xs animate-pulse">Loading game coverage...</p>
        ) : (
          <div className="space-y-1">
            {Object.entries(gamesBySeason)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, group]) => {
                const [, season] = key.split("|");
                const n = group.teams.length;
                const avgGames = n > 0 ? Math.round(group.totalGames / n) : 0;
                const color = avgGames >= group.expected * 0.9 ? "text-emerald-400" : avgGames >= group.expected * 0.5 ? "text-yellow-400" : "text-red-400";
                return (
                  <div key={key} className="bg-white/[0.03] border border-white/[0.06] rounded-xl overflow-hidden">
                    <button
                      onClick={() => setExpandedGames(expandedGames === key ? null : key)}
                      className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-white/[0.02] transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-xs font-bold text-white/70">{group.label}</span>
                        <span className="text-xs text-white/40 font-mono">{season}</span>
                        <span className={`text-xs font-mono ${color}`}>{n} teams</span>
                      </div>
                      <div className="flex items-center gap-4 text-xs">
                        <span className="text-white/30">avg <span className={`font-mono ${color}`}>{avgGames}</span>/{group.expected}</span>
                        <span className="text-white/20">{expandedGames === key ? "▲" : "▼"}</span>
                      </div>
                    </button>
                    {expandedGames === key && (
                      <div className="border-t border-white/[0.06] p-2 overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-white/30 border-b border-white/[0.06]">
                              <th className="px-2 py-1.5 text-left font-medium">Team</th>
                              <th className="px-2 py-1.5 text-right font-medium">Games</th>
                              <th className="px-2 py-1.5 text-right font-medium text-white/20">Exp</th>
                            </tr>
                          </thead>
                          <tbody>
                            {[...group.teams].sort((a, b) => a.team.localeCompare(b.team)).map((t, i) => {
                              const teamKey = `${key}|${t.team}`;
                              return (
                                <Fragment key={i}>
                                  <tr className="border-b border-white/[0.02] hover:bg-white/[0.02] cursor-pointer"
                                      onClick={() => setSelectedTeamGames(selectedTeamGames === teamKey ? null : teamKey)}>
                                    <td className="px-2 py-1 text-xs text-blue-300/70 hover:text-blue-300">{t.team} {selectedTeamGames === teamKey ? "▲" : "▼"}</td>
                                    <td className={`px-2 py-1 text-xs text-right font-mono ${covColor(t.games, group.expected)}`}>{t.games}</td>
                                    <td className="px-2 py-1 text-xs text-right font-mono text-white/20">{group.expected}</td>
                                  </tr>
                                  {selectedTeamGames === teamKey && (
                                    <tr>
                                      <td colSpan={3} className="p-0">
                                        <TeamGamesList league={group.label.toLowerCase() === "epl" ? "premier-league" : group.label.toLowerCase()} team={t.team} season={parseInt(key.split("|")[1])} />
                                      </td>
                                    </tr>
                                  )}
                                </Fragment>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        )}
      </div>

      {/* Player Stats Coverage */}
      <div className="mb-8">
        <h2 className="text-sm font-bold text-white/70 mb-2">Player Stats Coverage</h2>
        <PlayerStatsCoverage />
      </div>

    </>
  );
}

/** Player stats coverage: pick league+season, see all players with game counts */
function PlayerStatsCoverage() {
  const [league, setLeague] = useState("nba");
  const [season, setSeason] = useState(2024);

  const expected: Record<string, number> = { nba: 82, nhl: 82, nfl: 17, mlb: 162 };

  const { data, isLoading } = useQuery({
    queryKey: ["player-stats-coverage", league, season],
    queryFn: async () => {
      // Get all player game logs for this league+season, count per player
      let allLogs: any[] = [];
      let offset = 0;
      const PAGE = 1000;
      while (true) {
        const { data: rows } = await supabase
          .from("back_in_play_player_game_logs")
          .select("player_id")
          .eq("league_slug", league)
          .eq("season", season)
          .range(offset, offset + PAGE - 1);
        if (!rows || rows.length === 0) break;
        allLogs.push(...rows);
        if (rows.length < PAGE) break;
        offset += PAGE;
      }
      // Count per player
      const counts: Record<string, number> = {};
      for (const r of allLogs) {
        counts[r.player_id] = (counts[r.player_id] ?? 0) + 1;
      }
      // Get player names
      const playerIds = Object.keys(counts);
      if (playerIds.length === 0) return [];
      const names: Record<string, string> = {};
      // Fetch in chunks
      for (let i = 0; i < playerIds.length; i += 50) {
        const chunk = playerIds.slice(i, i + 50);
        const { data: players } = await supabase
          .from("back_in_play_players")
          .select("player_id, player_name")
          .in("player_id", chunk);
        if (players) {
          for (const p of players) names[p.player_id] = p.player_name;
        }
      }
      return playerIds.map(pid => ({
        name: names[pid] ?? pid,
        games: counts[pid],
        pid,
      })).sort((a, b) => a.name.localeCompare(b.name));
    },
    staleTime: 120_000,
  });

  const exp = expected[league] ?? 82;

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <select value={league} onChange={e => setLeague(e.target.value)}
          className="bg-white/5 border border-white/10 rounded px-2 py-1 text-xs text-white/70">
          <option value="nba">NBA</option>
          <option value="nhl">NHL</option>
          <option value="nfl">NFL</option>
          <option value="mlb">MLB</option>
        </select>
        <select value={season} onChange={e => setSeason(parseInt(e.target.value))}
          className="bg-white/5 border border-white/10 rounded px-2 py-1 text-xs text-white/70">
          {Array.from({ length: 15 }, (_, i) => 2025 - i).map(yr => (
            <option key={yr} value={yr}>{yr}-{String(yr + 1).slice(2)}</option>
          ))}
        </select>
        <span className="text-[10px] text-white/30">{data?.length ?? 0} players, exp {exp} GP</span>
      </div>
      {isLoading ? (
        <p className="text-white/30 text-xs animate-pulse">Loading...</p>
      ) : data && data.length > 0 ? (
        <div className="overflow-y-auto max-h-[400px] bg-white/[0.02] border border-white/[0.06] rounded-xl">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-[#0a0f1a]">
              <tr className="text-white/30 border-b border-white/[0.06]">
                <th className="px-2 py-1.5 text-left font-medium">Player</th>
                <th className="px-2 py-1.5 text-right font-medium">Games</th>
                <th className="px-2 py-1.5 text-right font-medium text-white/20">/{exp}</th>
              </tr>
            </thead>
            <tbody>
              {data.map((p, i) => (
                <tr key={i} className="border-b border-white/[0.02] hover:bg-white/[0.02]">
                  <td className="px-2 py-0.5 text-white/50">{p.name}</td>
                  <td className={`px-2 py-0.5 text-right font-mono ${covColor(p.games, exp)}`}>{p.games}</td>
                  <td className="px-2 py-0.5 text-right font-mono text-white/15">{exp}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-white/20 text-xs">No data for this season</p>
      )}
    </div>
  );
}

// ─── Injury Review mode ─────────────────────────────────────────────────────

function InjuryReviewMode() {
  const [league, setLeague] = useState("nba");
  const [gradeFilter, setGradeFilter] = useState<string>("all");

  const { data, isLoading } = useQuery({
    queryKey: ["injury-review", league, gradeFilter],
    queryFn: async () => {
      let query = supabase
        .from("back_in_play_injuries_corrected")
        .select("*")
        .eq("league_slug", league)
        .order("original_date_injured", { ascending: false })
        .limit(500);
      if (gradeFilter !== "all") {
        query = query.eq("grade", gradeFilter);
      }
      const { data } = await query;
      return data ?? [];
    },
    staleTime: 60_000,
  });

  // Grade summary counts
  const { data: gradeCounts } = useQuery({
    queryKey: ["injury-grade-counts", league],
    queryFn: async () => {
      const { data } = await supabase
        .from("back_in_play_injuries_corrected")
        .select("grade")
        .eq("league_slug", league)
        .limit(50000);
      if (!data) return {};
      const counts: Record<string, number> = {};
      for (const r of data) {
        counts[r.grade] = (counts[r.grade] ?? 0) + 1;
      }
      return counts;
    },
    staleTime: 60_000,
  });

  const gradeColor: Record<string, string> = {
    A: "text-emerald-400", B: "text-blue-400", C: "text-yellow-400", D: "text-red-400", U: "text-white/30",
  };
  const _gradeLabel: Record<string, string> = {
    A: "All 3 match", B: "2 of 3", C: "1 of 3", D: "None match", U: "Unmatched",
  };
  void _gradeLabel; // suppress unused warning

  return (
    <div>
      {/* Filters */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <select value={league} onChange={e => setLeague(e.target.value)}
          className="bg-white/5 border border-white/10 rounded px-2 py-1 text-xs text-white/70">
          <option value="nba">NBA</option>
          <option value="nhl">NHL</option>
          <option value="nfl">NFL</option>
          <option value="mlb">MLB</option>
        </select>

        <div className="flex gap-1">
          {["all", "A", "B", "C", "D", "U"].map(g => (
            <button key={g}
              onClick={() => setGradeFilter(g)}
              className={`px-2 py-1 rounded text-[10px] font-medium border transition-colors ${
                gradeFilter === g
                  ? "bg-white/10 border-white/20 text-white"
                  : "bg-white/[0.02] border-white/5 text-white/30 hover:text-white/50"
              }`}
            >
              {g === "all" ? "All" : g} {gradeCounts?.[g] != null ? `(${gradeCounts[g].toLocaleString()})` : ""}
            </button>
          ))}
        </div>
      </div>

      {/* Grade legend */}
      <div className="flex gap-4 mb-4 text-[10px] text-white/30">
        <span><span className="text-emerald-400 font-bold">A</span> = start ≤3d + return ≤7d + duration ≤30%</span>
        <span><span className="text-blue-400 font-bold">B</span> = 2 of 3</span>
        <span><span className="text-yellow-400 font-bold">C</span> = 1 of 3</span>
        <span><span className="text-red-400 font-bold">D</span> = none</span>
        <span><span className="text-white/30 font-bold">U</span> = unmatched</span>
      </div>

      {isLoading ? (
        <p className="text-white/30 text-xs animate-pulse">Loading...</p>
      ) : data && data.length > 0 ? (
        <div className="overflow-x-auto bg-white/[0.02] border border-white/[0.06] rounded-xl">
          <table className="w-full text-[10px]">
            <thead className="sticky top-0 bg-[#0a0f1a]">
              <tr className="text-white/30 border-b border-white/[0.06]">
                <th className="px-2 py-1.5 text-center font-medium">Grade</th>
                <th className="px-2 py-1.5 text-left font-medium">Player</th>
                <th className="px-2 py-1.5 text-left font-medium">Injury</th>
                <th className="px-2 py-1.5 text-left font-medium">Reported Start</th>
                <th className="px-2 py-1.5 text-left font-medium">Detected Start</th>
                <th className="px-2 py-1.5 text-right font-medium">Start Diff</th>
                <th className="px-2 py-1.5 text-left font-medium">Reported End</th>
                <th className="px-2 py-1.5 text-left font-medium">Detected End</th>
                <th className="px-2 py-1.5 text-right font-medium">Ret Diff</th>
                <th className="px-2 py-1.5 text-right font-medium">Det GP</th>
                <th className="px-2 py-1.5 text-right font-medium">Dur %Off</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r: any, i: number) => (
                <tr key={i} className="border-b border-white/[0.02] hover:bg-white/[0.02]">
                  <td className={`px-2 py-1 text-center font-bold ${gradeColor[r.grade] ?? "text-white/30"}`}>
                    {r.grade}
                  </td>
                  <td className="px-2 py-1 text-white/60">{r.player_name}</td>
                  <td className="px-2 py-1 text-white/40">{r.injury_type ?? "—"}</td>
                  <td className="px-2 py-1 font-mono text-white/40">{r.original_date_injured ?? "—"}</td>
                  <td className="px-2 py-1 font-mono text-white/60">{r.date_injured ?? "—"}</td>
                  <td className={`px-2 py-1 text-right font-mono ${
                    (r.start_day_diff ?? 99) <= 3 ? "text-emerald-400" : (r.start_day_diff ?? 99) <= 7 ? "text-yellow-400" : "text-red-400"
                  }`}>
                    {r.start_day_diff != null ? `${r.start_day_diff}d` : "—"}
                  </td>
                  <td className="px-2 py-1 font-mono text-white/40">{r.original_return_date ?? "—"}</td>
                  <td className="px-2 py-1 font-mono text-white/60">{r.return_date ?? "—"}</td>
                  <td className={`px-2 py-1 text-right font-mono ${
                    (r.return_day_diff ?? 99) <= 7 ? "text-emerald-400" : (r.return_day_diff ?? 99) <= 14 ? "text-yellow-400" : "text-red-400"
                  }`}>
                    {r.return_day_diff != null ? `${r.return_day_diff}d` : "—"}
                  </td>
                  <td className="px-2 py-1 text-right font-mono text-white/50">
                    {r.games_missed ?? "—"}
                  </td>
                  <td className={`px-2 py-1 text-right font-mono ${
                    (r.duration_pct_off ?? 999) <= 30 ? "text-emerald-400" : (r.duration_pct_off ?? 999) <= 50 ? "text-yellow-400" : "text-red-400"
                  }`}>
                    {r.duration_pct_off != null ? `${r.duration_pct_off}%` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-white/20 text-xs">No injury data for this league. Run detect_player_absences.py --save-to-db first.</p>
      )}

      <p className="text-[9px] text-white/15 mt-2">Showing up to 500 injuries. Filter by grade to see specific categories.</p>
    </div>
  );
}

// ─── Main page ──────────────────────────────────────────────────────────────

export default function PlayerDataPage() {
  const [tab, setTab] = useState<TabMode>("player");

  return (
    <div className="min-h-screen bg-[#0a0f1a] text-white">
      <SiteHeader />
      <div className="max-w-3xl mx-auto px-4 py-6">
        <h1 className="text-xl font-bold mb-1">Data Viewer</h1>
        <p className="text-xs text-white/30 mb-4">Debug tool — search a player or team to audit data.</p>

        {/* Tab toggle */}
        <div className="flex gap-1 mb-6 bg-white/[0.04] rounded-lg p-1 w-fit">
          <button
            onClick={() => setTab("player")}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
              tab === "player" ? "bg-white/10 text-white" : "text-white/40 hover:text-white/60"
            }`}
          >
            Player
          </button>
          <button
            onClick={() => setTab("team")}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
              tab === "team" ? "bg-white/10 text-white" : "text-white/40 hover:text-white/60"
            }`}
          >
            Team
          </button>
          <button
            onClick={() => setTab("coverage")}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
              tab === "coverage" ? "bg-white/10 text-white" : "text-white/40 hover:text-white/60"
            }`}
          >
            Coverage
          </button>
          <button
            onClick={() => setTab("injuries")}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
              tab === "injuries" ? "bg-white/10 text-white" : "text-white/40 hover:text-white/60"
            }`}
          >
            Injuries
          </button>
        </div>

        {tab === "player" ? <PlayerMode /> : tab === "team" ? <TeamMode /> : tab === "coverage" ? <CoverageMode /> : <InjuryReviewMode />}
      </div>
    </div>
  );
}
