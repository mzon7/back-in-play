import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import { SiteHeader } from "../components/SiteHeader";
import { SEO } from "../components/seo/SEO";
import { StatusBadge } from "../components/StatusBadge";
import { PlayerAvatar } from "../components/PlayerAvatar";
import { leagueColor } from "../lib/leagueColors";

const LEAGUE_ORDER = ["nba", "nfl", "mlb", "nhl", "premier-league"];
const LEAGUE_LABELS: Record<string, string> = {
  nba: "NBA", nfl: "NFL", mlb: "MLB", nhl: "NHL", "premier-league": "EPL",
};

const MARKET_LABELS: Record<string, string> = {
  player_points: "PTS", player_rebounds: "REB", player_assists: "AST",
  player_threes: "3PT", player_points_rebounds_assists: "PRA",
  player_pass_yds: "Pass Yds", player_rush_yds: "Rush Yds",
  player_reception_yds: "Rec Yds", player_receptions: "Rec",
  player_goals: "Goals", player_shots_on_goal: "SOG",
  player_shots: "Shots", player_shots_on_target: "SOT",
  batter_hits: "Hits", batter_total_bases: "TB", batter_rbis: "RBI",
};

// Map prop market keys to game log stat columns
const MARKET_TO_STAT: Record<string, string> = {
  player_points: "stat_pts", player_rebounds: "stat_reb", player_assists: "stat_ast",
  player_pass_yds: "stat_pass_yds", player_rush_yds: "stat_rush_yds",
  player_reception_yds: "stat_rec_yds", player_receptions: "stat_rec",
  player_goals: "stat_goals", player_shots_on_goal: "stat_sog",
  player_shots: "stat_sog", player_shots_on_target: "stat_sog",
  batter_hits: "stat_h", batter_total_bases: "stat_h", batter_rbis: "stat_rbi",
};

/** Status → subtle border color for injury cards (same as HomePage) */
const STATUS_BORDER_COLOR: Record<string, string> = {
  out:          "rgba(239,68,68,0.25)",
  ir:           "rgba(239,68,68,0.25)",
  "il-10":      "rgba(239,68,68,0.25)",
  "il-15":      "rgba(239,68,68,0.25)",
  "il-60":      "rgba(239,68,68,0.25)",
  doubtful:     "rgba(249,115,22,0.25)",
  questionable: "rgba(234,179,8,0.25)",
  "day-to-day": "rgba(245,158,11,0.25)",
  probable:     "rgba(59,130,246,0.25)",
  active:       "rgba(34,197,94,0.25)",
  returned:     "rgba(34,197,94,0.25)",
  active_today: "rgba(249,115,22,0.25)",
  reduced_load: "rgba(245,158,11,0.25)",
  back_in_play: "rgba(6,182,212,0.25)",
  suspended:    "rgba(168,85,247,0.25)",
};

function injuryCardBorder(status: string | null | undefined): string {
  if (!status) return "rgba(255,255,255,0.1)";
  const key = status.toLowerCase().replace(/-/g, "_");
  return STATUS_BORDER_COLOR[key] ?? STATUS_BORDER_COLOR[status] ?? "rgba(255,255,255,0.1)";
}

const SOURCE_LABELS: Record<string, string> = {
  draftkings: "DraftKings",
  fanduel: "FanDuel",
  betrivers: "BetRivers",
  bovada: "Bovada",
};

interface PropItem {
  id: string;
  market: string;
  line: number | null;
  over_price: string | null;
  under_price: string | null;
  source: string;
}

interface PreInjuryAvg {
  minutes: number | null;
  [statKey: string]: number | null;
}

interface PropsPlayer {
  player_id: string;
  player_name: string;
  player_slug: string;
  position: string;
  team_name: string;
  league_slug: string;
  headshot_url: string | null;
  status: string;
  injury_type: string;
  expected_return: string | null;
  is_star: boolean;
  is_starter: boolean;
  injury_date: string | null;
  props: PropItem[];
  avg5: PreInjuryAvg | null;
  avg10: PreInjuryAvg | null;
  gamesBack: number;
  avgSinceReturn: PreInjuryAvg | null;
}

function computeAvg(games: any[], n: number): PreInjuryAvg | null {
  const slice = games.slice(0, n);
  if (slice.length === 0) return null;
  const stats = ["minutes", "stat_pts", "stat_reb", "stat_ast", "stat_stl", "stat_blk",
    "stat_sog", "stat_rush_yds", "stat_pass_yds", "stat_rec", "stat_rec_yds",
    "stat_goals", "stat_h", "stat_rbi"];
  const result: PreInjuryAvg = { minutes: null };
  for (const key of stats) {
    const vals = slice.map((g: any) => g[key]).filter((v: any) => v != null);
    result[key] = vals.length > 0 ? Math.round((vals.reduce((a: number, b: number) => a + b, 0) / vals.length) * 10) / 10 : null;
  }
  return result;
}

function usePropsWithPlayers() {
  const today = new Date().toISOString().slice(0, 10);
  return useQuery<PropsPlayer[]>({
    queryKey: ["bip-props-page", today],
    queryFn: async () => {
      // 1. Get today's props
      const { data: props, error: propsErr } = await supabase
        .from("back_in_play_player_props")
        .select("id, player_id, player_name, market, line, over_price, under_price, source")
        .eq("game_date", today);
      if (propsErr) throw propsErr;
      if (!props || props.length === 0) return [];

      // 2. Group props by player_id
      const propsByPlayer = new Map<string, typeof props>();
      for (const p of props) {
        const existing = propsByPlayer.get(p.player_id) ?? [];
        existing.push(p);
        propsByPlayer.set(p.player_id, existing);
      }

      const playerIds = Array.from(propsByPlayer.keys());

      // 3. Parallel: players (with team+league joins), injuries, game logs
      const [playersRes, leaguesRes, ...injuryChunks] = await Promise.all([
        // Players with team+league join (1 call instead of 3 sequential)
        supabase
          .from("back_in_play_players")
          .select("player_id, player_name, slug, position, team_id, league_id, headshot_url, espn_id, is_star, is_starter, team:back_in_play_teams(team_name, league_id), league:back_in_play_leagues!back_in_play_players_league_id_fkey(slug)")
          .in("player_id", playerIds),
        // Leagues (small, fast)
        supabase.from("back_in_play_leagues").select("league_id, slug"),
        // Injuries — parallel chunks
        ...Array.from({ length: Math.ceil(playerIds.length / 200) }, (_, i) =>
          supabase
            .from("back_in_play_injuries")
            .select("player_id, status, injury_type, expected_return, date_injured")
            .in("player_id", playerIds.slice(i * 200, (i + 1) * 200))
            .neq("status", "cleared")
            .order("date_injured", { ascending: false })
        ),
      ]);

      const players = playersRes.data ?? [];
      const playerMap = new Map<string, any>();
      players.forEach((p: any) => playerMap.set(p.player_id, p));

      const leagueMap = new Map<string, string>();
      (leaguesRes.data ?? []).forEach((l: any) => leagueMap.set(l.league_id, l.slug));

      // Latest injury per player
      const injuryMap = new Map<string, any>();
      for (const chunk of injuryChunks) {
        for (const inj of chunk.data ?? []) {
          if (!injuryMap.has(inj.player_id)) injuryMap.set(inj.player_id, inj);
        }
      }

      // 4. Game logs — parallel chunks (heaviest query, but now parallel)
      const logChunks = await Promise.all(
        Array.from({ length: Math.ceil(playerIds.length / 100) }, (_, i) =>
          supabase
            .from("back_in_play_player_game_logs")
            .select("player_id, game_date, minutes, stat_pts, stat_reb, stat_ast, stat_stl, stat_blk, stat_sog, stat_rush_yds, stat_pass_yds, stat_rec, stat_rec_yds, stat_goals, stat_h, stat_rbi")
            .in("player_id", playerIds.slice(i * 100, (i + 1) * 100))
            .order("game_date", { ascending: false })
            .limit(2000)
        )
      );
      const gameLogMap = new Map<string, any[]>();
      for (const chunk of logChunks) {
        for (const g of chunk.data ?? []) {
          const existing = gameLogMap.get(g.player_id) ?? [];
          existing.push(g);
          gameLogMap.set(g.player_id, existing);
        }
      }

      // 5. Build result
      const result: PropsPlayer[] = [];
      for (const [pid, playerProps] of propsByPlayer) {
        const player = playerMap.get(pid);
        if (!player) continue;
        const team = (player as any).team;
        const leagueSlug = (player as any).league?.slug ?? leagueMap.get(player.league_id) ?? "";
        const injury = injuryMap.get(pid);

        // Compute pre-injury averages from game logs
        const allGames = gameLogMap.get(pid) ?? [];
        let preInjuryGames = allGames;
        const injuryDate = injury?.date_injured;
        if (injuryDate) {
          // Only games before the injury date
          preInjuryGames = allGames.filter((g: any) => g.game_date < injuryDate);
        }
        // Sort descending (most recent first)
        preInjuryGames.sort((a: any, b: any) => b.game_date.localeCompare(a.game_date));

        const avg5 = computeAvg(preInjuryGames, 5);
        const avg10 = computeAvg(preInjuryGames, 10);

        // Post-return games (after injury date)
        let postReturnGames: any[] = [];
        if (injuryDate) {
          postReturnGames = allGames
            .filter((g: any) => g.game_date > injuryDate)
            .sort((a: any, b: any) => b.game_date.localeCompare(a.game_date));
        }
        const gamesBack = postReturnGames.length;
        const avgSinceReturn = gamesBack > 0 ? computeAvg(postReturnGames, gamesBack) : null;

        result.push({
          player_id: pid,
          player_name: player.player_name,
          player_slug: player.slug ?? "",
          position: player.position ?? "",
          team_name: team?.team_name ?? "",
          league_slug: leagueSlug,
          headshot_url: player.headshot_url ?? (player.espn_id ? `https://a.espncdn.com/i/headshots/nba/players/full/${player.espn_id}.png` : null),
          status: injury?.status ?? "active",
          injury_type: injury?.injury_type ?? "",
          expected_return: injury?.expected_return ?? null,
          is_star: player.is_star ?? false,
          is_starter: player.is_starter ?? false,
          injury_date: injuryDate ?? null,
          props: playerProps.map((p) => ({
            id: p.id,
            market: p.market,
            line: p.line,
            over_price: p.over_price,
            under_price: p.under_price,
            source: p.source,
          })),
          avg5,
          avg10,
          gamesBack,
          avgSinceReturn,
        });
      }

      // Sort: stars first, then starters, then by name
      result.sort((a, b) => {
        if (a.is_star !== b.is_star) return a.is_star ? -1 : 1;
        if (a.is_starter !== b.is_starter) return a.is_starter ? -1 : 1;
        return a.player_name.localeCompare(b.player_name);
      });

      return result;
    },
    staleTime: 5 * 60 * 1000,
  });
}

function PlayerPropCard({ player, sourceFilter }: { player: PropsPlayer; sourceFilter: string }) {
  const priority = ["player_points", "player_goals", "batter_hits", "player_pass_yds", "player_rush_yds",
    "player_rebounds", "player_assists", "player_threes", "player_shots_on_goal", "batter_total_bases"];

  // Filter by source, then dedupe by market (prefer draftkings when showing all)
  const sourceProps = sourceFilter === "all"
    ? player.props
    : player.props.filter((p) => p.source === sourceFilter);

  const deduped = new Map<string, PropItem>();
  const SOURCE_PRIORITY = ["draftkings", "fanduel"];
  for (const p of sourceProps) {
    const existing = deduped.get(p.market);
    if (!existing) {
      deduped.set(p.market, p);
    } else if (sourceFilter === "all") {
      const curIdx = SOURCE_PRIORITY.indexOf(existing.source);
      const newIdx = SOURCE_PRIORITY.indexOf(p.source);
      if (newIdx !== -1 && (curIdx === -1 || newIdx < curIdx)) {
        deduped.set(p.market, p);
      }
    }
  }

  const sorted = [...deduped.values()].sort((a, b) => {
    const ai = priority.indexOf(a.market);
    const bi = priority.indexOf(b.market);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  if (sorted.length === 0) return null;

  const leagueLabel = LEAGUE_LABELS[player.league_slug] ?? "";
  const lColor = leagueColor(player.league_slug);

  return (
    <div
      className="bg-white/[0.03] rounded-xl p-4 relative overflow-hidden"
      style={{ border: `1px solid ${injuryCardBorder(player.status)}` }}
    >
      {/* Left status accent */}
      <div
        className="absolute left-0 top-2 bottom-2 w-[2px] rounded-full"
        style={{ backgroundColor: injuryCardBorder(player.status).replace(/[\d.]+\)$/, '0.6)') }}
      />
      <div className="flex items-start gap-3 mb-3">
        <PlayerAvatar src={player.headshot_url} name={player.player_name} size={48} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Link to={`/player/${player.player_slug}`} className="text-sm font-semibold hover:text-cyan-400 transition-colors truncate">
              {player.player_name}
            </Link>
            {player.is_star && <span className="text-[9px] bg-yellow-500/20 text-yellow-400 px-1.5 py-0.5 rounded-full font-bold shrink-0">STAR</span>}
            {player.is_starter && !player.is_star && <span className="text-[9px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded-full font-bold shrink-0">STARTER</span>}
          </div>
          <div className="flex items-center gap-2 text-xs text-white/40 mt-0.5">
            <span>{player.position}</span>
            <span>·</span>
            <span>{player.team_name}</span>
            {leagueLabel && (
              <span className="inline-flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ backgroundColor: lColor }} />
                <span>{leagueLabel}</span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-1">
            <StatusBadge status={player.status} />
            {player.injury_type && <span className="text-xs text-white/35">{player.injury_type}</span>}
          </div>
          {/* Pre-injury minutes + games back */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 text-[11px] text-white/30">
            {player.avg10?.minutes != null && (
              <span>Pre-injury: {player.avg10.minutes} min/g</span>
            )}
            {player.gamesBack > 0 && (
              <span>{player.gamesBack} game{player.gamesBack !== 1 ? "s" : ""} back{player.avgSinceReturn?.minutes != null ? ` · ${player.avgSinceReturn.minutes} min/g since return` : ""}</span>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
        {sorted.map((p) => {
          const statKey = MARKET_TO_STAT[p.market];
          const avg5Val = statKey && player.avg5 ? player.avg5[statKey] : null;
          const avg10Val = statKey && player.avg10 ? player.avg10[statKey] : null;
          const hasAvg = avg5Val != null || avg10Val != null;

          const sinceReturnKey = statKey && player.avgSinceReturn ? player.avgSinceReturn[statKey] : null;

          return (
            <div key={p.id} className="bg-white/5 rounded-lg px-2.5 py-2 text-center">
              <p className="text-[10px] text-emerald-400/70 font-medium mb-0.5">
                {MARKET_LABELS[p.market] ?? p.market}
              </p>
              <p className="text-base font-bold text-white">{p.line}</p>
              <div className="flex justify-center gap-2 mt-0.5 text-[11px]">
                {p.over_price && <span className="text-green-400/80">O {p.over_price}</span>}
                {p.under_price && <span className="text-red-400/80">U {p.under_price}</span>}
              </div>
              {sourceFilter === "all" && (
                <p className="text-[9px] text-white/20 mt-0.5">{SOURCE_LABELS[p.source] ?? p.source}</p>
              )}
              {(hasAvg || sinceReturnKey != null) && (
                <div className="mt-1.5 pt-1.5 border-t border-white/5 text-[10px] text-white/35">
                  {avg5Val != null && <p>5G: <span className={p.line != null && avg5Val > p.line ? "text-green-400/70" : p.line != null && avg5Val < p.line ? "text-red-400/70" : "text-white/50"}>{avg5Val}</span></p>}
                  {avg10Val != null && <p>10G: <span className={p.line != null && avg10Val > p.line ? "text-green-400/70" : p.line != null && avg10Val < p.line ? "text-red-400/70" : "text-white/50"}>{avg10Val}</span></p>}
                  {sinceReturnKey != null && player.gamesBack > 0 && (
                    <p className="text-cyan-400/50">Back: <span className={p.line != null && sinceReturnKey > p.line ? "text-green-400/70" : p.line != null && sinceReturnKey < p.line ? "text-red-400/70" : "text-white/50"}>{sinceReturnKey}</span></p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function PropsPage() {
  const { data: players = [], isLoading } = usePropsWithPlayers();
  const [leagueFilter, setLeagueFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");

  const filtered = leagueFilter === "all"
    ? players
    : players.filter((p) => p.league_slug === leagueFilter);

  // Get unique leagues that have props today
  const activeLeagues = Array.from(new Set(players.map((p) => p.league_slug))).filter(Boolean);
  const orderedLeagues = LEAGUE_ORDER.filter((l) => activeLeagues.includes(l));

  // Get unique sources
  const activeSources = Array.from(new Set(players.flatMap((p) => p.props.map((pr) => pr.source)))).filter(Boolean);

  const injuredCount = filtered.filter((p) => p.status !== "active" && p.status !== "returned").length;

  return (
    <div className="min-h-screen bg-[#0a0f1a] text-white">
      <SEO
        title="Player Props Today - Injury Return Opportunities | Back In Play"
        description="Today's player prop lines for athletes returning from injury. Find betting value on players coming back from the injury report."
        path="/props"
      />
      <SiteHeader />

      <div className="max-w-3xl mx-auto px-4 py-6">
        <h1 className="text-2xl font-bold mb-2">Player Props</h1>
        <p className="text-sm text-white/50 mb-5 leading-relaxed">
          Today's prop lines for players with injury history. Returning players often have adjusted
          lines that may not reflect their true ability — creating opportunities when a player
          is healthy but the market is still pricing in injury risk.
        </p>

        {/* Best Opportunities */}
        {(() => {
          const opportunities = players.filter(
            (p) => (p.is_star || p.is_starter) && p.status !== "active" && p.status !== "cleared"
          );
          if (opportunities.length === 0) return null;
          return (
            <div className="mb-6">
              <h2 className="text-xs font-bold text-emerald-400/80 uppercase tracking-widest mb-3">Best Opportunities</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
                {opportunities.slice(0, 6).map((p) => {
                  const topProp = p.props[0];
                  return (
                    <Link
                      key={p.player_id}
                      to={`/player/${p.player_slug}`}
                      className="bg-gradient-to-br from-emerald-500/10 to-cyan-500/5 border border-emerald-500/20 rounded-xl p-4 hover:border-emerald-500/40 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <PlayerAvatar src={p.headshot_url} name={p.player_name} size={44} />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold truncate">{p.player_name}</p>
                          <div className="flex items-center gap-1.5 text-xs text-white/40 mt-0.5">
                            <span>{p.team_name}</span>
                            <span>·</span>
                            <StatusBadge status={p.status} />
                          </div>
                          {p.injury_type && <p className="text-[11px] text-white/30 mt-0.5">{p.injury_type}</p>}
                        </div>
                        {topProp && (
                          <div className="text-right shrink-0">
                            <p className="text-[10px] text-emerald-400/70 font-medium">{MARKET_LABELS[topProp.market] ?? topProp.market}</p>
                            <p className="text-lg font-bold">{topProp.line}</p>
                          </div>
                        )}
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })()}

        {/* Source tabs */}
        {activeSources.length > 1 && (
          <div className="flex gap-1 mb-4">
            {["draftkings", "fanduel", ...activeSources.filter((s) => s !== "draftkings" && s !== "fanduel")].filter((s) => activeSources.includes(s)).map((src) => (
              <button
                key={src}
                onClick={() => setSourceFilter(src)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  sourceFilter === src ? "bg-white/15 text-white" : "bg-white/5 text-white/40 hover:text-white/60"
                }`}
              >
                {SOURCE_LABELS[src] ?? src}
              </button>
            ))}
            <button
              onClick={() => setSourceFilter("all")}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                sourceFilter === "all" ? "bg-white/15 text-white" : "bg-white/5 text-white/40 hover:text-white/60"
              }`}
            >
              All
            </button>
          </div>
        )}

        {/* League filter */}
        <div className="flex gap-1.5 mb-5 overflow-x-auto pb-1">
          <button
            onClick={() => setLeagueFilter("all")}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors shrink-0 ${
              leagueFilter === "all" ? "bg-white/15 text-white" : "bg-white/5 text-white/40 hover:text-white/60"
            }`}
          >
            All ({players.length})
          </button>
          {orderedLeagues.map((slug) => {
            const count = players.filter((p) => p.league_slug === slug).length;
            return (
              <button
                key={slug}
                onClick={() => setLeagueFilter(slug)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors shrink-0 ${
                  leagueFilter === slug ? "bg-white/15 text-white" : "bg-white/5 text-white/40 hover:text-white/60"
                }`}
              >
                {LEAGUE_LABELS[slug]} ({count})
              </button>
            );
          })}
        </div>

        {/* Stats bar */}
        {filtered.length > 0 && (
          <div className="flex gap-4 text-xs text-white/40 mb-4">
            <span>{filtered.length} players with props</span>
            <span>{injuredCount} currently injured</span>
          </div>
        )}

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-36 rounded-xl bg-white/5 animate-pulse" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-white/40 text-sm">No props data for today yet.</p>
            <p className="text-white/25 text-xs mt-1">Props are fetched daily before game time.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map((p) => (
              <PlayerPropCard key={p.player_id} player={p} sourceFilter={sourceFilter} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
