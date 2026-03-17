import { useState, useMemo, useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import { SiteHeader } from "../components/SiteHeader";
import { SEO } from "../components/seo/SEO";
import { PlayerAvatar } from "../components/PlayerAvatar";
import { InjuryPlayerCard } from "../components/InjuryPlayerCard";
import { trackLeagueFilter, trackPlayerAnalysisView } from "../lib/analytics";
import { leagueColor } from "../lib/leagueColors";
import { usePerformanceCurves } from "../features/performance-curves/lib/queries";
import type { PerformanceCurve } from "../features/performance-curves/lib/types";
import { computeEV, parseOdds, type EVResult } from "../lib/evModel";
import { BlurredInsight, EarlyAccessCTA } from "../components/PremiumTease";
import { WhyThisSignal } from "../components/WhyThisSignal";
import { PremiumGate } from "../components/PremiumGate";
import { PremiumUnlockCounter } from "../components/PremiumUnlockCounter";

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

/** Normalize an injury_type string to a slug for curve matching */
function injuryToSlug(injuryType: string): string {
  return injuryType.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Primary stat per league for curve impact display */
const PRIMARY_STAT: Record<string, { key: string; label: string }> = {
  nba: { key: "stat_pts", label: "PTS" },
  nfl: { key: "stat_rush_yds", label: "Rush Yds" },
  mlb: { key: "stat_h", label: "Hits" },
  nhl: { key: "stat_goals", label: "Goals" },
  "premier-league": { key: "stat_goals", label: "Goals" },
};

/** Compute stat impact from a curve at game index */
function getCurveImpact(curve: PerformanceCurve, gIdx: number, leagueSlug: string): { label: string; diff: number } | null {
  const baselines = curve.stat_baselines ?? {};
  const medians = curve.stat_median_pct ?? {};
  const ps = PRIMARY_STAT[leagueSlug];
  if (ps) {
    const base = baselines[ps.key];
    const pct = (medians[ps.key] as number[] | undefined)?.[gIdx];
    if (base && base > 0 && pct != null) return { label: ps.label, diff: base * (pct - 1.0) };
  }
  // Fallback: largest % deviation
  let best: { label: string; diff: number; pctDev: number } | null = null;
  for (const [sk, base] of Object.entries(baselines)) {
    if (sk === "composite" || !base || base === 0) continue;
    const pct = (medians[sk] as number[] | undefined)?.[gIdx];
    if (pct == null) continue;
    const pctDev = Math.abs(pct - 1.0);
    if (!best || pctDev > best.pctDev) {
      best = { label: MARKET_LABELS_SHORT[sk] ?? sk.replace("stat_", ""), diff: base * (pct - 1.0), pctDev };
    }
  }
  return best ? { label: best.label, diff: best.diff } : null;
}

const MARKET_LABELS_SHORT: Record<string, string> = {
  stat_pts: "PTS", stat_reb: "REB", stat_ast: "AST",
  stat_rush_yds: "Rush Yds", stat_pass_yds: "Pass Yds", stat_rec_yds: "Rec Yds",
  stat_goals: "Goals", stat_sog: "SOG", stat_assists: "Assists",
  stat_h: "Hits", stat_hr: "HR", stat_rbi: "RBI",
};

const SORT_OPTIONS = [
  { value: "best", label: "Best Opportunities" },
  { value: "gap", label: "Largest Gap vs Expectation" },
  { value: "early", label: "Earliest Return" },
  { value: "drop", label: "Biggest Historical Drop" },
] as const;

type SortMode = typeof SORT_OPTIONS[number]["value"];

const SOURCE_LABELS: Record<string, string> = {
  draftkings: "DraftKings",
  fanduel: "FanDuel",
  betrivers: "BetRivers",
  bovada: "Bovada",
};

// Stat filter options per league
const STAT_FILTERS: { value: string; label: string; markets: string[] }[] = [
  { value: "all", label: "All Stats", markets: [] },
  { value: "pts", label: "PTS", markets: ["player_points"] },
  { value: "reb", label: "REB", markets: ["player_rebounds"] },
  { value: "ast", label: "AST", markets: ["player_assists"] },
  { value: "pra", label: "PRA", markets: ["player_points_rebounds_assists"] },
  { value: "3pt", label: "3PT", markets: ["player_threes"] },
  { value: "pass", label: "Pass Yds", markets: ["player_pass_yds"] },
  { value: "rush", label: "Rush Yds", markets: ["player_rush_yds"] },
  { value: "rec", label: "Rec Yds", markets: ["player_reception_yds", "player_receptions"] },
  { value: "goals", label: "Goals", markets: ["player_goals"] },
  { value: "sog", label: "SOG", markets: ["player_shots_on_goal", "player_shots", "player_shots_on_target"] },
  { value: "hits", label: "Hits", markets: ["batter_hits"] },
  { value: "tb", label: "TB", markets: ["batter_total_bases"] },
];

/** Format game status from commence_time */
function gameStatus(commenceTime: string | null | undefined, gameDate: string | undefined): { label: string; started: boolean; tomorrow: boolean } {
  const today = new Date().toISOString().slice(0, 10);
  const isTomorrow = gameDate != null && gameDate > today;

  if (!commenceTime) {
    return { label: isTomorrow ? "Tomorrow" : "Today", started: false, tomorrow: isTomorrow };
  }
  const ct = new Date(commenceTime);
  const now = new Date();
  if (now >= ct) {
    return { label: "Live", started: true, tomorrow: false };
  }
  // Format time in user's locale
  const timeStr = ct.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return { label: isTomorrow ? `Tomorrow ${timeStr}` : timeStr, started: false, tomorrow: isTomorrow };
}

function GameTimeBadge({ commenceTime, gameDate }: { commenceTime?: string | null; gameDate?: string }) {
  const { label, started, tomorrow } = gameStatus(commenceTime, gameDate);
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold ${
      started ? "bg-green-500/20 text-green-400" :
      tomorrow ? "bg-blue-500/10 text-blue-400/60" :
      "bg-white/5 text-white/40"
    }`}>
      {started && <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />}
      {label}
    </span>
  );
}

interface PropItem {
  id: string;
  market: string;
  line: number | null;
  over_price: string | null;
  under_price: string | null;
  source: string;
  game_date?: string;
  commence_time?: string | null;
  home_team?: string | null;
  away_team?: string | null;
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
  game_date?: string;
  commence_time?: string | null;
  home_team?: string | null;
  away_team?: string | null;
}

/** Median of a numeric array */
function arrMedian(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Minutes-adjusted stat averages using median of per-minute rates.
 * 1. Filter out games below 25% of the player's median minutes (injury exits)
 * 2. Compute per-minute rate for each game
 * 3. Take median of rates (robust to outliers)
 * 4. Multiply by median minutes -> per-game expected value
 */
function computeAvg(games: any[], n: number): PreInjuryAvg | null {
  // First pass: get all games with any minutes to compute typical minutes
  const withMinutes = games.filter((g: any) => g.minutes != null && g.minutes > 0);
  if (withMinutes.length === 0) return null;

  // Compute median minutes from ALL available games to determine threshold
  const allMinutes = withMinutes.map((g: any) => g.minutes as number);
  const typicalMinutes = arrMedian(allMinutes);
  const minThreshold = typicalMinutes * 0.25; // 25% of typical = injury exit cutoff

  // Filter to real games (above threshold), then take top n
  const realGames = withMinutes.filter((g: any) => g.minutes >= minThreshold);
  const slice = realGames.slice(0, n);
  if (slice.length === 0) return null;

  const statKeys = ["stat_pts", "stat_reb", "stat_ast", "stat_stl", "stat_blk",
    "stat_sog", "stat_rush_yds", "stat_pass_yds", "stat_rec", "stat_rec_yds",
    "stat_goals", "stat_h", "stat_rbi"];
  const result: PreInjuryAvg = { minutes: null };

  // Median minutes of real games
  const minuteVals = slice.map((g: any) => g.minutes as number);
  const medMinutes = arrMedian(minuteVals);
  result.minutes = Math.round(medMinutes * 10) / 10;

  for (const key of statKeys) {
    const rates: number[] = [];
    for (const g of slice) {
      const val = g[key];
      if (val != null) {
        rates.push(val / g.minutes);
      }
    }
    // Median per-minute rate x median minutes = expected per-game stat
    result[key] = rates.length > 0
      ? Math.round(arrMedian(rates) * medMinutes * 10) / 10
      : null;
  }
  return result;
}

function usePropsWithPlayers() {
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  return useQuery<PropsPlayer[]>({
    queryKey: ["bip-props-page", today],
    queryFn: async () => {
      // 1. Get today's + tomorrow's props; fall back to most recent if none
      let { data: props, error: propsErr } = await supabase
        .from("back_in_play_player_props")
        .select("id, player_id, player_name, market, line, over_price, under_price, source, game_date, commence_time, home_team, away_team")
        .in("game_date", [today, tomorrow])
        .order("game_date", { ascending: true });
      if (propsErr) throw propsErr;

      // If no props for today/tomorrow, get the most recent day that has data
      if (!props || props.length === 0) {
        const { data: recent } = await supabase
          .from("back_in_play_player_props")
          .select("id, player_id, player_name, market, line, over_price, under_price, source, game_date, commence_time, home_team, away_team")
          .order("game_date", { ascending: false })
          .limit(1000);
        props = recent ?? [];
      }
      if (!props || props.length === 0) return [];

      // 2. Group props by player_id (skip nulls)
      const propsByPlayer = new Map<string, typeof props>();
      for (const p of props) {
        if (!p.player_id) continue;
        const existing = propsByPlayer.get(p.player_id) ?? [];
        existing.push(p);
        propsByPlayer.set(p.player_id, existing);
      }

      const playerIds = Array.from(propsByPlayer.keys());

      // 3. Parallel: players (with team+league joins), injuries, game logs
      const [playersRes, leaguesRes, ...injuryChunks] = await Promise.all([
        supabase
          .from("back_in_play_players")
          .select("player_id, player_name, slug, position, team_id, league_id, headshot_url, espn_id, is_star, is_starter, team:back_in_play_teams(team_name, league_id), league:back_in_play_leagues!back_in_play_players_league_id_fkey(slug)")
          .in("player_id", playerIds),
        supabase.from("back_in_play_leagues").select("league_id, slug"),
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

      // 4. Game logs — parallel chunks
      const LOG_CHUNK_SIZE = 20;
      const logChunks = await Promise.all(
        Array.from({ length: Math.ceil(playerIds.length / LOG_CHUNK_SIZE) }, (_, i) =>
          supabase
            .from("back_in_play_player_game_logs")
            .select("player_id, game_date, minutes, stat_pts, stat_reb, stat_ast, stat_stl, stat_blk, stat_sog, stat_rush_yds, stat_pass_yds, stat_rec, stat_rec_yds, stat_goals, stat_h, stat_rbi")
            .in("player_id", playerIds.slice(i * LOG_CHUNK_SIZE, (i + 1) * LOG_CHUNK_SIZE))
            .order("game_date", { ascending: false })
            .limit(1000)
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
          preInjuryGames = allGames.filter((g: any) => g.game_date < injuryDate);
        }
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
          props: playerProps.map((p: any) => ({
            id: p.id,
            market: p.market,
            line: p.line,
            over_price: p.over_price,
            under_price: p.under_price,
            source: p.source,
            game_date: p.game_date,
            commence_time: p.commence_time,
            home_team: p.home_team,
            away_team: p.away_team,
          })),
          avg5,
          avg10,
          gamesBack,
          avgSinceReturn,
          game_date: playerProps[0]?.game_date ?? today,
          commence_time: playerProps[0]?.commence_time ?? null,
          home_team: playerProps[0]?.home_team ?? null,
          away_team: playerProps[0]?.away_team ?? null,
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

// ─── Recovery Curve Mini Visualization ───────────────────────────────────────

function RecoveryCurveMini({ curve, leagueSlug, gamesBack }: { curve: PerformanceCurve; leagueSlug: string; gamesBack: number }) {
  const ps = PRIMARY_STAT[leagueSlug];
  if (!ps) return null;
  const baselines = curve.stat_baselines ?? {};
  const medians = curve.stat_median_pct ?? {};
  const base = baselines[ps.key];
  const pcts = medians[ps.key] as number[] | undefined;
  if (!base || !pcts || pcts.length === 0) return null;

  const points = pcts.slice(0, 10);
  const minPct = Math.min(...points, 0.7);
  const maxPct = Math.max(...points, 1.1);
  const range = maxPct - minPct || 0.1;
  const w = 160;
  const h = 40;
  const step = w / (points.length - 1 || 1);

  const pathPoints = points.map((p, i) => {
    const x = i * step;
    const y = h - ((p - minPct) / range) * h;
    return `${x},${y}`;
  });
  const path = `M${pathPoints.join(" L")}`;

  // Baseline line at pct=1.0
  const baselineY = h - ((1.0 - minPct) / range) * h;

  // Current game marker
  const curIdx = Math.min(gamesBack - 1, points.length - 1);
  const curX = curIdx >= 0 ? curIdx * step : 0;
  const curY = curIdx >= 0 ? h - ((points[curIdx] - minPct) / range) * h : h / 2;

  return (
    <svg width={w} height={h + 4} className="overflow-visible">
      {/* Baseline */}
      <line x1={0} y1={baselineY} x2={w} y2={baselineY} stroke="rgba(255,255,255,0.1)" strokeDasharray="3,3" />
      {/* Curve */}
      <path d={path} fill="none" stroke="rgba(59,130,246,0.5)" strokeWidth={1.5} />
      {/* Current position */}
      {curIdx >= 0 && (
        <circle cx={curX} cy={curY} r={3} fill="#3b82f6" stroke="#0a0f1a" strokeWidth={1.5} />
      )}
    </svg>
  );
}

// ─── STEP 3: Edge strength label (cap display, keep actual for sorting) ──────

function edgeLabel(evPct: number): { text: string; color: string } {
  const abs = Math.abs(evPct);
  if (abs >= 15) return { text: "Strong signal", color: evPct > 0 ? "text-green-400" : "text-red-400" };
  if (abs >= 7) return { text: "Moderate signal", color: evPct > 0 ? "text-green-400/80" : "text-red-400/80" };
  return { text: "Weak signal", color: "text-white/40" };
}

// ─── STEP 4: Game return badge ──────────────────────────────────────────────

function GameReturnBadge({ gamesBack }: { gamesBack: number }) {
  if (gamesBack <= 0) return null;
  const color = gamesBack <= 3
    ? "bg-red-500/15 text-red-400/90 border-red-500/25"
    : gamesBack <= 6
    ? "bg-amber-500/15 text-amber-400/90 border-amber-500/25"
    : "bg-green-500/15 text-green-400/90 border-green-500/25";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[10px] font-semibold ${color}`}>
      Game {gamesBack} After Return
    </span>
  );
}

// ─── STEP 2: Auto-generate "why this edge" explanation per prop ──────────────

function generatePropExplanation(
  market: string,
  line: number | null,
  preVal: number | null,
  returnVal: number | null,
  gamesBack: number,
  impDiff: number | null,
): string | null {
  const reasons: string[] = [];
  const statLabel = MARKET_LABELS[market] ?? market;

  // Pre vs post stat difference
  if (preVal != null && returnVal != null && line != null) {
    const diff = returnVal - preVal;
    if (Math.abs(diff) > 0.3) {
      const dir = diff < 0 ? "lower" : "higher";
      reasons.push(`${dir} post-injury ${statLabel.toLowerCase()} (${returnVal.toFixed(1)} vs ${preVal.toFixed(1)} pre-injury)`);
    }
  }

  // Historical trend
  if (impDiff != null && impDiff < -0.3) {
    reasons.push("historical return trend suppression");
  }

  // Early return
  if (gamesBack <= 3) {
    reasons.push("early return window uncertainty");
  }

  if (reasons.length === 0) return null;
  return reasons.join(" + ");
}

// ─── PlayerPropCard (Redesigned with Signal → Explanation → Context) ─────────

function PlayerPropCard({ player, sourceFilter, curve, highlighted, statFilter }: {
  player: PropsPlayer;
  sourceFilter: string;
  curve?: PerformanceCurve | null;
  highlighted?: boolean;
  statFilter?: string;
}) {
  const priority = ["player_points", "player_goals", "batter_hits", "player_pass_yds", "player_rush_yds",
    "player_rebounds", "player_assists", "player_threes", "player_shots_on_goal", "batter_total_bases"];

  // Filter by source, then dedupe by market (prefer draftkings when showing all)
  let sourceProps = sourceFilter === "all"
    ? player.props
    : player.props.filter((p) => p.source === sourceFilter);

  // Apply stat filter
  if (statFilter && statFilter !== "all") {
    const sf = STAT_FILTERS.find((f) => f.value === statFilter);
    if (sf && sf.markets.length > 0) {
      sourceProps = sourceProps.filter((p) => sf.markets.includes(p.market));
    }
  }

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

  const injurySlug = player.injury_type ? injuryToSlug(player.injury_type) : "";

  // Curve impacts at G1, G3, G5
  const impG1 = curve ? getCurveImpact(curve, 0, player.league_slug) : null;
  const impG3 = curve ? getCurveImpact(curve, 2, player.league_slug) : null;
  const impG5 = curve ? getCurveImpact(curve, 4, player.league_slug) : null;
  const fmtDiff = (d: number) => `${d >= 0 ? "+" : ""}${d.toFixed(1)}`;

  return (
    <div
      id={`prop-player-${player.player_id}`}
      className={`scroll-mt-24 rounded-xl transition-shadow duration-[2500ms] ${highlighted ? "ring-2 ring-[#1C7CFF]/50 shadow-[0_0_20px_rgba(28,124,255,0.15)]" : ""}`}
    >
    <InjuryPlayerCard
      player_name={player.player_name}
      player_slug={player.player_slug}
      position={player.position}
      team_name={player.team_name}
      league_slug={player.league_slug}
      headshot_url={player.headshot_url}
      status={player.status}
      injury_type={player.injury_type}
      is_star={player.is_star}
      is_starter={player.is_starter}
      expected_return={player.expected_return}
      date_injured={player.injury_date}
      showLeague
      avatarSize={48}
      linkToPlayer={false}
    >
      {/* RETURN SUMMARY — the most important context box */}
      {player.gamesBack > 0 && (
        <div className="px-4 pb-2">
          <div className="rounded-lg bg-gradient-to-r from-blue-500/[0.06] to-purple-500/[0.04] border border-blue-500/15 px-3.5 py-3">
            <div className="flex items-center gap-2 mb-1.5">
              <p className="text-[10px] font-bold text-blue-400/90 uppercase tracking-wider">Return Summary</p>
              <GameReturnBadge gamesBack={player.gamesBack} />
            </div>
            {(() => {
              // Build the summary lines
              const lines: string[] = [];
              if (impG3 && impG3.diff < 0) {
                lines.push(`Players returning from ${player.injury_type?.toLowerCase() ?? "this injury"} typically underperform in the first 3–5 games.`);
              } else if (impG3 && impG3.diff >= 0) {
                lines.push(`${player.injury_type ?? "This injury"} returns historically show near-baseline performance.`);
              }
              // Find the biggest gap stat
              const bestGap = sorted.reduce<{ market: string; pct: number } | null>((best, p) => {
                const sk = MARKET_TO_STAT[p.market];
                const base = sk && player.avg10 ? player.avg10[sk] : null;
                if (!curve || !sk || base == null || base <= 0 || p.line == null || player.gamesBack <= 0) return best;
                const ev = computeEV({ baseline: base, propLine: p.line, overOdds: parseOdds(p.over_price), underOdds: parseOdds(p.under_price), gamesSinceReturn: player.gamesBack, recentAvg: sk && player.avgSinceReturn ? player.avgSinceReturn[sk] : null, curve, leagueSlug: player.league_slug, statKey: sk, preInjuryMinutes: player.avg10?.minutes, currentMinutes: player.avgSinceReturn?.minutes });
                if (!ev || ev.expectedCombined == null || p.line === 0) return best;
                const pct = Math.abs(((ev.expectedCombined - p.line) / p.line) * 100);
                if (!best || pct > best.pct) return { market: p.market, pct };
                return best;
              }, null);
              if (bestGap && bestGap.pct > 5) {
                lines.push(`This player is currently projected ${Math.round(bestGap.pct)}% ${bestGap.pct > 0 ? "away from" : "from"} market expectations on ${MARKET_LABELS[bestGap.market] ?? bestGap.market}.`);
              }
              if (player.avg10?.minutes && player.avgSinceReturn?.minutes && player.gamesBack > 0) {
                const pct = player.avgSinceReturn.minutes / player.avg10.minutes;
                if (pct < 0.8) lines.push(`Minutes still below pre-injury levels (${Math.round(pct * 100)}% of usual).`);
              }
              if (lines.length === 0 && player.gamesBack <= 3) {
                lines.push(`Game ${player.gamesBack} after return — early return window with highest performance uncertainty.`);
              }
              return lines.length > 0 ? (
                <p className="text-[11px] text-white/50 leading-relaxed">{lines.join(" ")}</p>
              ) : null;
            })()}
          </div>
        </div>
      )}

      {/* WHY THIS SIGNAL — free summary + locked premium breakdown */}
      {player.gamesBack > 0 && (() => {
        // Find the primary stat's EV and data for the signal explanation
        const primaryProp = sorted[0];
        const primaryStatKey = primaryProp ? MARKET_TO_STAT[primaryProp.market] : null;
        const primaryBaseline = primaryStatKey && player.avg10 ? player.avg10[primaryStatKey] as number | undefined : null;
        const primaryReturn = primaryStatKey && player.avgSinceReturn ? player.avgSinceReturn[primaryStatKey] as number | undefined : null;
        let primaryEv: EVResult | null = null;
        if (curve && primaryStatKey && primaryBaseline != null && primaryBaseline > 0 && primaryProp?.line != null) {
          primaryEv = computeEV({
            baseline: primaryBaseline,
            propLine: primaryProp.line,
            overOdds: parseOdds(primaryProp.over_price),
            underOdds: parseOdds(primaryProp.under_price),
            gamesSinceReturn: player.gamesBack,
            recentAvg: primaryReturn ?? null,
            curve,
            leagueSlug: player.league_slug,
            statKey: primaryStatKey,
            preInjuryMinutes: player.avg10?.minutes,
            currentMinutes: player.avgSinceReturn?.minutes,
          });
        }
        return (
          <div className="px-4 pb-2">
            <WhyThisSignal
              playerName={player.player_name}
              injuryType={player.injury_type}
              gamesBack={player.gamesBack}
              ev={primaryEv}
              curve={curve ?? null}
              preBaseline={primaryBaseline ?? null}
              returnAvg={primaryReturn ?? null}
              preMinutes={player.avg10?.minutes ?? null}
              currentMinutes={player.avgSinceReturn?.minutes ?? null}
              marketLabel={MARKET_LABELS[primaryProp?.market ?? ""] ?? primaryProp?.market ?? "stat"}
              propLine={primaryProp?.line ?? null}
              leagueSlug={player.league_slug}
              statKey={primaryStatKey}
              isPremium={false}
            />
          </div>
        );
      })()}

      {/* PROP PROJECTIONS — primary stat highlighted */}
      <div className="px-4 pb-2">
        {(() => {
          // Compute EV for all props and find primary (largest gap)
          const propData = sorted.map((p) => {
            const statKey = MARKET_TO_STAT[p.market];
            const avg10Val = statKey && player.avg10 ? player.avg10[statKey] : null;
            const sinceReturnVal = statKey && player.avgSinceReturn ? player.avgSinceReturn[statKey] : null;
            let ev: EVResult | null = null;
            if (curve && statKey && avg10Val != null && p.line != null && player.gamesBack > 0) {
              ev = computeEV({ baseline: avg10Val, propLine: p.line, overOdds: parseOdds(p.over_price), underOdds: parseOdds(p.under_price), gamesSinceReturn: player.gamesBack, recentAvg: sinceReturnVal, curve, leagueSlug: player.league_slug, statKey, preInjuryMinutes: player.avg10?.minutes, currentMinutes: player.avgSinceReturn?.minutes });
            }
            const hasEdge = ev?.recommendation && ev?.bestEv != null && ev.bestEv > 0;
            const projDiffPct = ev && p.line != null && p.line > 0 ? Math.round(((ev.expectedCombined - p.line) / p.line) * 100) : null;
            return { prop: p, ev, hasEdge, projDiffPct, avg10Val, sinceReturnVal, statKey };
          });

          // Find primary stat (largest absolute gap)
          let primaryIdx = 0;
          let bestGap = 0;
          propData.forEach((d, i) => {
            const gap = Math.abs(d.projDiffPct ?? 0);
            if (gap > bestGap) { bestGap = gap; primaryIdx = i; }
          });

          function confidenceLabel(conf: string | undefined): { text: string; color: string } {
            if (conf === "high") return { text: "High confidence", color: "text-green-400/70" };
            if (conf === "medium") return { text: "Medium confidence", color: "text-amber-400/70" };
            return { text: "Low confidence", color: "text-white/35" };
          }

          return (
            <div className="space-y-1.5">
              {propData.map((d, idx) => {
                const { prop: p, ev, hasEdge, projDiffPct, avg10Val, sinceReturnVal } = d;
                const isPrimary = idx === primaryIdx && hasEdge;
                const isOver = ev?.recommendation === "OVER";
                const edge = hasEdge && ev?.bestEv != null ? edgeLabel(ev.bestEv) : null;
                const conf = confidenceLabel(ev?.confidence);
                const propExplanation = hasEdge ? generatePropExplanation(p.market, p.line, avg10Val, sinceReturnVal, player.gamesBack, impG3?.diff ?? null) : null;

                return (
                  <div
                    key={p.id}
                    className={`rounded-lg ${isPrimary ? "px-3.5 py-3" : "px-2.5 py-2"} ${
                      hasEdge
                        ? isOver
                          ? isPrimary ? "bg-green-500/[0.1] border-2 border-green-500/30" : "bg-green-500/[0.06] border border-green-500/15"
                          : isPrimary ? "bg-red-500/[0.1] border-2 border-red-500/30" : "bg-red-500/[0.06] border border-red-500/15"
                        : "bg-white/[0.03] border border-white/5"
                    }`}
                  >
                    {/* Header: stat + confidence + direction */}
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <p className={`${isPrimary ? "text-[11px]" : "text-[10px]"} text-emerald-400/70 font-semibold`}>
                          {MARKET_LABELS[p.market] ?? p.market}
                        </p>
                        {isPrimary && <span className="text-[8px] text-blue-400/60 font-bold uppercase tracking-wider bg-blue-400/10 px-1.5 py-0.5 rounded">Primary</span>}
                      </div>
                      {hasEdge && edge && (
                        <PremiumGate
                          contentId={`${p.id}-direction`}
                          playerName={player.player_name}
                          section="prop_direction"
                          inline
                          placeholder={
                            <span className={`${isPrimary ? "text-[11px]" : "text-[10px]"} font-bold text-white/40`}>OVER</span>
                          }
                        >
                          <span className={`${isPrimary ? "text-[11px]" : "text-[10px]"} font-bold ${edge.color}`}>
                            {ev!.recommendation}
                          </span>
                        </PremiumGate>
                      )}
                    </div>

                    {/* Market vs Model */}
                    <div className="flex items-baseline justify-between gap-3">
                      <div>
                        <p className="text-[9px] text-white/30">Market</p>
                        <p className={`${isPrimary ? "text-xl" : "text-base"} font-bold text-white tabular-nums`}>{p.line}</p>
                      </div>
                      {ev && (
                        <PremiumGate
                          contentId={`${p.id}-model`}
                          playerName={player.player_name}
                          section="prop_model"
                          placeholder={
                            <div className="text-right">
                              <p className="text-[9px] text-white/30">Model</p>
                              <p className={`${isPrimary ? "text-xl" : "text-base"} font-bold text-white/70 tabular-nums`}>24.5</p>
                            </div>
                          }
                        >
                          <div className="text-right">
                            <p className="text-[9px] text-white/30">Model</p>
                            <p className={`${isPrimary ? "text-xl" : "text-base"} font-bold text-white/70 tabular-nums`}>{ev.expectedCombined.toFixed(1)}</p>
                          </div>
                        </PremiumGate>
                      )}
                      {projDiffPct != null && projDiffPct !== 0 && (
                        <PremiumGate
                          contentId={`${p.id}-gap`}
                          playerName={player.player_name}
                          section="prop_gap"
                          placeholder={
                            <div className="text-right">
                              <p className="text-[9px] text-white/30">Gap</p>
                              <p className={`${isPrimary ? "text-lg" : "text-sm"} font-bold tabular-nums text-green-400/80`}>+8%</p>
                            </div>
                          }
                        >
                          <div className="text-right">
                            <p className="text-[9px] text-white/30">Gap</p>
                            <p className={`${isPrimary ? "text-lg" : "text-sm"} font-bold tabular-nums ${projDiffPct < 0 ? "text-red-400/80" : "text-green-400/80"}`}>
                              {projDiffPct > 0 ? "+" : ""}{projDiffPct}%
                            </p>
                          </div>
                        </PremiumGate>
                      )}
                    </div>

                    {/* Confidence + sample context */}
                    {ev && (
                      <div className="flex items-center gap-2 mt-1.5">
                        <span className={`text-[9px] font-medium ${conf.color}`}>{conf.text}</span>
                        {curve && (
                          <span className="text-[9px] text-white/20">· Based on {curve.sample_size.toLocaleString()} similar cases</span>
                        )}
                      </div>
                    )}

                    {/* Why explanation — blurred premium tease */}
                    {propExplanation && (
                      <p className="text-[9px] text-white/25 mt-1.5 pt-1 border-t border-white/5 leading-snug italic">
                        <BlurredInsight text={propExplanation} section="prop_explanation" page="props" playerName={player.player_name} statType={MARKET_LABELS[p.market]} gamesBack={player.gamesBack} />
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })()}
      </div>

      {/* INJURY CURVE — typical performance after this injury */}
      {curve && (impG1 || impG3 || impG5) && (
        <div className="px-4 pb-2">
          <div className="rounded-lg bg-blue-500/[0.04] border border-blue-500/10 p-3">
            <p className="text-[11px] font-semibold text-blue-400/80 mb-0.5">
              Typical Performance After {player.injury_type ?? "This Injury"}
            </p>
            <p className="text-[10px] text-white/30 mb-2">
              Historical return trend for {player.injury_type?.toLowerCase() ?? "this injury"} in {LEAGUE_LABELS[player.league_slug]}
            </p>

            <div className="flex items-center gap-4">
              {/* Impact numbers — G1–G5 highlighted */}
              <div className="grid grid-cols-3 gap-3 flex-1">
                {([["G1", impG1, true], ["G3", impG3, true], ["G5", impG5, false]] as [string, { label: string; diff: number } | null, boolean][]).map(([label, imp, isEarly]) => (
                  <div key={label} className={`text-center rounded-lg py-1.5 ${isEarly ? "bg-white/[0.03]" : ""}`}>
                    <p className={`text-[9px] mb-0.5 ${isEarly ? "text-red-400/50 font-medium" : "text-white/25"}`}>{label}{isEarly ? " ⚠" : ""}</p>
                    <p className={`text-xs font-bold tabular-nums ${imp == null ? "text-white/20" : imp.diff >= 0 ? "text-green-400" : "text-red-400"}`}>
                      {imp != null ? `${fmtDiff(imp.diff)} ${imp.label}` : "—"}
                    </p>
                  </div>
                ))}
              </div>

              {/* Mini recovery curve */}
              <div className="shrink-0">
                <RecoveryCurveMini curve={curve} leagueSlug={player.league_slug} gamesBack={player.gamesBack} />
              </div>
            </div>

            {/* Interpretation line */}
            <p className="text-[10px] text-white/30 mt-2 leading-snug">
              {impG3 && impG3.diff < 0
                ? "Performance typically lags baseline in the first few games after return — the early window (G1–G5) carries the highest uncertainty."
                : "Historical data suggests near-baseline performance for this injury type after return."
              }
            </p>

            <p className="text-[9px] text-white/20 mt-1.5">
              Based on {curve.sample_size.toLocaleString()} similar injury return cases
            </p>
          </div>
        </div>
      )}

      {/* EXPECTED ROLE (minutes context + interpretation) */}
      {(player.avg10?.minutes != null || player.avgSinceReturn?.minutes != null) && (
        <div className="px-4 pb-2">
          <div className="rounded-lg bg-white/[0.03] border border-white/5 p-3">
            <p className="text-[11px] font-semibold text-white/50 mb-2">Expected Role</p>
            <div className="flex items-center gap-4">
              {player.avg10?.minutes != null && (
                <div className="text-center">
                  <p className="text-[9px] text-white/25">Pre-injury</p>
                  <p className="text-sm font-bold text-white/70 tabular-nums">{player.avg10.minutes} min</p>
                </div>
              )}
              {player.avgSinceReturn?.minutes != null && player.gamesBack > 0 && (
                <div className="text-center">
                  <p className="text-[9px] text-white/25">Since return</p>
                  <p className="text-sm font-bold text-white/70 tabular-nums">{player.avgSinceReturn.minutes} min</p>
                </div>
              )}
              {/* Minutes bar */}
              {player.avg10?.minutes != null && player.avg10.minutes > 0 && player.avgSinceReturn?.minutes != null && player.gamesBack > 0 && (() => {
                const pct = player.avgSinceReturn!.minutes! / player.avg10!.minutes!;
                const pctRound = Math.round(pct * 100);
                return (
                  <div className="flex-1 min-w-[80px]">
                    <div className="h-2 rounded-full bg-white/10 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${pct >= 0.8 ? "bg-cyan-400" : "bg-amber-400"}`}
                        style={{ width: `${Math.min(100, pctRound)}%` }}
                      />
                    </div>
                    <p className="text-[9px] text-white/25 mt-0.5 text-right tabular-nums">
                      {pctRound}% of usual
                    </p>
                  </div>
                );
              })()}
            </div>
            {/* Interpretation */}
            {player.avg10?.minutes != null && player.avg10.minutes > 0 && player.avgSinceReturn?.minutes != null && player.gamesBack > 0 && (() => {
              const pct = player.avgSinceReturn!.minutes! / player.avg10!.minutes!;
              if (pct < 0.7) return <p className="text-[10px] text-amber-400/50 mt-2">Still ramping up — significantly reduced minutes suggest a cautious return</p>;
              if (pct < 0.85) return <p className="text-[10px] text-amber-400/40 mt-2">Not yet at full workload — minutes still below pre-injury levels</p>;
              if (pct < 0.95) return <p className="text-[10px] text-white/30 mt-2">Approaching full workload — minutes nearly restored to pre-injury levels</p>;
              return <p className="text-[10px] text-green-400/40 mt-2">Full workload restored — playing at or above pre-injury minutes</p>;
            })()}
          </div>
        </div>
      )}

      {/* Analytics links */}
      {injurySlug && (
        <div className="flex items-center gap-3 px-4 pb-4 text-[10px]">
          <Link
            to={`/performance-curves?league=${player.league_slug}&injury=${injurySlug}`}
            className="text-white/25 hover:text-[#1C7CFF]/70 transition-colors"
          >
            View recovery curve &rarr;
          </Link>
          <Link
            to={`/injuries/${injurySlug}?league=${player.league_slug}`}
            className="text-white/25 hover:text-[#1C7CFF]/70 transition-colors"
          >
            View recovery stats &rarr;
          </Link>
        </div>
      )}
    </InjuryPlayerCard>
    </div>
  );
}

// ─── Daily Opportunities Table ───────────────────────────────────────────────

function DailyOpportunitiesTable({ players, findCurve }: {
  players: PropsPlayer[];
  findCurve: (p: PropsPlayer) => PerformanceCurve | null;
}) {
  // Build rows: returning players with their best prop edge
  const rows = players
    .filter((p) => p.gamesBack > 0 && p.gamesBack <= 10)
    .map((p) => {
      const curve = findCurve(p);
      let bestEv: EVResult | null = null;
      let bestProp: PropItem | null = null;

      for (const prop of p.props) {
        const statKey = MARKET_TO_STAT[prop.market];
        const baseline = statKey && p.avg10 ? p.avg10[statKey] : null;
        const recent = statKey && p.avgSinceReturn ? p.avgSinceReturn[statKey] : null;
        if (!curve || !statKey || baseline == null || baseline <= 0 || prop.line == null || p.gamesBack <= 0) continue;

        const ev = computeEV({
          baseline, propLine: prop.line,
          overOdds: parseOdds(prop.over_price), underOdds: parseOdds(prop.under_price),
          gamesSinceReturn: p.gamesBack, recentAvg: recent, curve,
          leagueSlug: p.league_slug, statKey,
          preInjuryMinutes: p.avg10?.minutes, currentMinutes: p.avgSinceReturn?.minutes,
        });

        if (ev && ev.bestEv != null && ev.recommendation && (!bestEv || (ev.bestEv > (bestEv.bestEv ?? 0)))) {
          bestEv = ev;
          bestProp = prop;
        }
      }

      return { player: p, curve, bestEv, bestProp };
    })
    .filter((r) => r.bestEv?.recommendation)
    .sort((a, b) => (b.bestEv?.bestEv ?? 0) - (a.bestEv?.bestEv ?? 0))
    .slice(0, 10);

  if (rows.length === 0) return null;

  // Strength label from gap %
  function gapStrength(evPct: number): { text: string; color: string } {
    const abs = Math.abs(evPct);
    if (abs >= 15) return { text: "Elite", color: "text-amber-400" };
    if (abs >= 8) return { text: "Strong", color: "text-green-400/80" };
    return { text: "Moderate", color: "text-white/50" };
  }

  // Why tag
  function whyTag(p: PropsPlayer, curve: PerformanceCurve | null): string {
    if (p.gamesBack <= 3) {
      if (p.avg10?.minutes && p.avgSinceReturn?.minutes && p.avgSinceReturn.minutes / p.avg10.minutes < 0.8)
        return "Minutes restriction";
      return "Early return suppression";
    }
    if (p.avg10?.minutes && p.avgSinceReturn?.minutes && p.avgSinceReturn.minutes / p.avg10.minutes < 0.8)
      return "Minutes restriction";
    if (curve) {
      const impG3 = getCurveImpact(curve, 2, p.league_slug);
      if (impG3 && impG3.diff < -0.3) return "Historical underperformance";
    }
    return "Return window impact";
  }

  return (
    <section className="mb-6">
      <h2 className="text-xs font-bold text-blue-400/80 uppercase tracking-widest mb-1">Biggest Return vs Market Gaps Today</h2>
      <p className="text-[11px] text-white/30 mb-3">Players where post-injury performance differs most from current lines</p>
      <div className="rounded-xl border border-white/8 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="text-[9px] text-white/25 uppercase tracking-wider border-b border-white/5 bg-white/[0.02]">
                <th className="px-3 py-2.5 font-medium w-8">#</th>
                <th className="px-3 py-2.5 font-medium">Player</th>
                <th className="px-3 py-2.5 font-medium">Return</th>
                <th className="px-3 py-2.5 font-medium">Stat</th>
                <th className="px-3 py-2.5 font-medium text-right">Market</th>
                <th className="px-3 py-2.5 font-medium text-right">Model ✦</th>
                <th className="px-3 py-2.5 font-medium text-right">Gap ✦</th>
                <th className="px-3 py-2.5 font-medium">Strength ✦</th>
                <th className="px-3 py-2.5 font-medium">Why</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ player: p, bestEv, bestProp, curve }, idx) => {
                const isOver = bestEv?.recommendation === "OVER";
                const lc = leagueColor(p.league_slug);
                const isTop3 = idx < 3;
                const strength = bestEv?.bestEv != null ? gapStrength(bestEv.bestEv) : null;
                const gbColor = p.gamesBack <= 3
                  ? "bg-red-500/15 text-red-400/90 border-red-500/25"
                  : p.gamesBack <= 6
                  ? "bg-amber-500/15 text-amber-400/90 border-amber-500/25"
                  : "bg-green-500/15 text-green-400/90 border-green-500/25";
                const gapPct = bestEv && bestProp?.line != null && bestProp.line > 0
                  ? ((bestEv.expectedCombined - bestProp.line) / bestProp.line * 100)
                  : null;
                return (
                  <tr
                    key={p.player_id}
                    className={`border-b border-white/5 transition-colors cursor-pointer group ${
                      isTop3
                        ? "bg-blue-500/[0.04] hover:bg-blue-500/[0.08]"
                        : "hover:bg-white/[0.03]"
                    }`}
                    onClick={() => {
                      trackPlayerAnalysisView({
                        player_name: p.player_name,
                        injury_type: p.injury_type ?? "unknown",
                        games_since_return: p.gamesBack,
                        stat_type: bestProp ? (MARKET_LABELS[bestProp.market] ?? bestProp.market) : undefined,
                        edge_percent: bestEv?.bestEv ?? undefined,
                        page_origin: "props_page_table",
                      });
                      const el = document.getElementById(`prop-player-${p.player_id}`);
                      el?.scrollIntoView({ behavior: "smooth", block: "center" });
                    }}
                  >
                    <td className="px-3 py-2.5">
                      <span className={`text-[11px] font-bold tabular-nums ${isTop3 ? "text-blue-400" : "text-white/25"}`}>
                        #{idx + 1}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <PlayerAvatar src={p.headshot_url} name={p.player_name} size={24} />
                        <div>
                          <p className="text-xs font-medium text-white truncate max-w-[120px] group-hover:text-blue-400 transition-colors">{p.player_name}</p>
                          <div className="flex items-center gap-1.5">
                            <span className="text-[9px]" style={{ color: `${lc}99` }}>{LEAGUE_LABELS[p.league_slug]}</span>
                            <span className="text-[9px] text-white/20">·</span>
                            <span className="text-[9px] text-white/30 truncate max-w-[80px]">{p.injury_type}</span>
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`inline-flex items-center px-1.5 py-0.5 rounded-md border text-[9px] font-semibold whitespace-nowrap ${gbColor}`}>
                        G{p.gamesBack}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-[11px] text-white/50">{bestProp ? (MARKET_LABELS[bestProp.market] ?? bestProp.market) : "—"}</td>
                    <td className="px-3 py-2.5 text-[11px] text-white/70 text-right tabular-nums font-medium">{bestProp?.line ?? "—"}</td>
                    <td className="px-3 py-2.5 text-right">
                      <PremiumGate
                        contentId={`table-${p.player_id}-model`}
                        playerName={p.player_name}
                        section="table_model"
                        placeholder={
                          <>
                            <span className="text-[11px] text-white/50 tabular-nums">24.5</span>
                            <p className="text-[9px] text-white/25 tabular-nums">+8%</p>
                          </>
                        }
                      >
                        <span className="text-[11px] text-white/50 tabular-nums">{bestEv?.expectedCombined.toFixed(1) ?? "—"}</span>
                        {gapPct != null && (
                          <p className="text-[9px] text-white/25 tabular-nums">{gapPct > 0 ? "+" : ""}{gapPct.toFixed(0)}%</p>
                        )}
                      </PremiumGate>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <PremiumGate
                        contentId={`table-${p.player_id}-dir`}
                        playerName={p.player_name}
                        section="table_direction"
                        inline
                        placeholder={
                          <span className="text-[11px] font-bold text-white/40">OVER</span>
                        }
                      >
                        <span className={`text-[11px] font-bold ${isOver ? "text-green-400" : "text-red-400"}`}>
                          {bestEv!.recommendation}
                        </span>
                      </PremiumGate>
                    </td>
                    <td className="px-3 py-2.5">
                      <PremiumGate
                        contentId={`table-${p.player_id}-strength`}
                        playerName={p.player_name}
                        section="table_strength"
                        inline
                        placeholder={
                          <span className="text-[10px] font-semibold text-white/40">Strong</span>
                        }
                      >
                        {strength && (
                          <span className={`text-[10px] font-semibold ${strength.color}`}>{strength.text}</span>
                        )}
                      </PremiumGate>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="text-[9px] text-white/35 italic">{whyTag(p, curve)}</span>
                      <span className="text-[9px] text-blue-400/50 ml-1 opacity-0 group-hover:opacity-100 transition-opacity">→</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

// ─── EV Info Modal ───────────────────────────────────────────────────────────

function EVInfoModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div
        className="relative bg-[#111827] border border-white/10 rounded-2xl max-w-lg w-full max-h-[85vh] overflow-y-auto p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button onClick={onClose} className="absolute top-4 right-4 text-white/30 hover:text-white/60 transition-colors text-lg">&#x2715;</button>

        <h2 className="text-lg font-bold text-white mb-1">How EV Works</h2>
        <p className="text-xs text-white/40 mb-5">Injury-adjusted expected value</p>

        <div className="space-y-5 text-[13px] text-white/70 leading-relaxed">
          <div>
            <p>
              Expected value compares the model's estimated probability
              of a player going over or under the prop line to the
              sportsbook's implied probability based on the odds.
            </p>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-white/90 mb-2">Our model uses</h3>
            <ul className="space-y-2 text-white/60">
              <li className="flex items-start gap-2.5">
                <span className="shrink-0 mt-1.5 w-1.5 h-1.5 rounded-full bg-[#1C7CFF]/60" />
                <span><span className="text-white/80">Historical injury recovery trends</span> — how players have performed after the same injury type, at each game since return</span>
              </li>
              <li className="flex items-start gap-2.5">
                <span className="shrink-0 mt-1.5 w-1.5 h-1.5 rounded-full bg-[#3DFF8F]/60" />
                <span><span className="text-white/80">Player performance since returning</span> — actual stats in games played after the injury</span>
              </li>
              <li className="flex items-start gap-2.5">
                <span className="shrink-0 mt-1.5 w-1.5 h-1.5 rounded-full bg-orange-400/60" />
                <span><span className="text-white/80">Minutes and usage changes</span> — load management and minutes restrictions</span>
              </li>
            </ul>
          </div>

          <div className="rounded-lg bg-[#1C7CFF]/5 border border-[#1C7CFF]/15 p-3.5">
            <p className="text-[13px] text-white/70 leading-relaxed">
              <span className="text-white/90 font-medium">Positive EV</span> indicates the model probability exceeds the
              sportsbook's breakeven probability — a potential long-term edge.
            </p>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-white/90 mb-2">Confidence levels</h3>
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-lg bg-green-500/10 border border-green-500/15 p-2.5 text-center">
                <p className="text-xs font-bold text-green-400 mb-0.5">High</p>
                <p className="text-[10px] text-white/40">500+ historical cases</p>
              </div>
              <div className="rounded-lg bg-amber-500/10 border border-amber-500/15 p-2.5 text-center">
                <p className="text-xs font-bold text-amber-400 mb-0.5">Medium</p>
                <p className="text-[10px] text-white/40">100-500 cases</p>
              </div>
              <div className="rounded-lg bg-red-500/10 border border-red-500/15 p-2.5 text-center">
                <p className="text-xs font-bold text-red-400 mb-0.5">Low</p>
                <p className="text-[10px] text-white/40">Under 100 cases</p>
              </div>
            </div>
          </div>

          <div className="rounded-lg bg-white/5 border border-white/8 p-3 text-[11px] text-white/40 leading-relaxed">
            <p className="font-semibold text-white/60 mb-1">Important</p>
            <p>
              This model provides statistical estimates, not guarantees. Positive EV does not mean a bet will win —
              it means the odds may be in your favor over a large number of similar situations. Always bet responsibly.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main PropsPage ──────────────────────────────────────────────────────────

export default function PropsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const qLeague = searchParams.get("league")?.toLowerCase();
  const qInjury = searchParams.get("injury")?.toLowerCase();
  const qPlayer = searchParams.get("player");
  const qSort = searchParams.get("sort");

  const { data: players = [], isLoading } = usePropsWithPlayers();
  const { data: curves = [], isLoading: curvesIsLoading } = usePerformanceCurves();

  const [leagueFilter, setLeagueFilter] = useState<string>(
    qLeague && LEAGUE_ORDER.includes(qLeague) ? qLeague : "all"
  );
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [statFilter, setStatFilter] = useState<string>("all");
  const [sortMode, setSortMode] = useState<SortMode>(
    qSort && ["best", "gap", "early", "drop"].includes(qSort) ? qSort as SortMode : "best"
  );
  const [showEVInfo, setShowEVInfo] = useState(false);
  const [highlightedPlayerId, setHighlightedPlayerId] = useState<string | null>(null);

  // Build curve lookup: injury_type_slug|league_slug -> PerformanceCurve
  const curveMap = useMemo(() => {
    const m = new Map<string, PerformanceCurve>();
    for (const c of curves) {
      if (c.position) continue; // only all-position curves
      const key = `${c.injury_type_slug}|${c.league_slug}`;
      const existing = m.get(key);
      if (!existing || c.sample_size > existing.sample_size) m.set(key, c);
    }
    return m;
  }, [curves]);

  /** Find matching curve for a player */
  const findCurve = (p: PropsPlayer): PerformanceCurve | null => {
    if (!p.injury_type) return null;
    const slug = injuryToSlug(p.injury_type);
    // Exact match first
    const exact = curveMap.get(`${slug}|${p.league_slug}`);
    if (exact) return exact;
    // Partial match
    for (const [key, curve] of curveMap) {
      const [cSlug, cLeague] = key.split("|");
      if (cLeague === p.league_slug && (cSlug.includes(slug) || slug.includes(cSlug))) return curve;
    }
    return null;
  };

  // Scroll to matched player and highlight
  useEffect(() => {
    if (!qPlayer || players.length === 0 || isLoading || curvesIsLoading) return;
    const q = qPlayer.toLowerCase();
    const match = players.find((p) => p.player_name.toLowerCase().includes(q));
    if (!match) return;

    setHighlightedPlayerId(match.player_id);

    let attempts = 0;
    let lastTop = -1;
    let rafId: number;

    function scrollToTarget() {
      const el = document.getElementById(`prop-player-${match!.player_id}`);
      if (!el) {
        if (attempts < 10) { attempts++; rafId = requestAnimationFrame(scrollToTarget); }
        return;
      }
      const rect = el.getBoundingClientRect();
      const currentTop = rect.top + window.scrollY;

      if (lastTop < 0 || Math.abs(currentTop - lastTop) > 20) {
        lastTop = currentTop;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }

      attempts++;
      if (attempts < 20) {
        setTimeout(() => { rafId = requestAnimationFrame(scrollToTarget); }, 150);
      }
    }

    const timer = setTimeout(() => { rafId = requestAnimationFrame(scrollToTarget); }, 100);
    const fadeTimer = setTimeout(() => setHighlightedPlayerId(null), 4000);

    return () => { clearTimeout(timer); clearTimeout(fadeTimer); cancelAnimationFrame(rafId); };
  }, [qPlayer, players, isLoading, curvesIsLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear query params after initial use
  useEffect(() => {
    if (qLeague || qInjury || qPlayer) {
      const timer = setTimeout(() => {
        setSearchParams({}, { replace: true });
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    let list = leagueFilter === "all"
      ? players
      : players.filter((p) => p.league_slug === leagueFilter);
    if (qInjury) {
      list = [...list].sort((a, b) => {
        const aMatch = a.injury_type && injuryToSlug(a.injury_type).includes(qInjury) ? 1 : 0;
        const bMatch = b.injury_type && injuryToSlug(b.injury_type).includes(qInjury) ? 1 : 0;
        return bMatch - aMatch;
      });
    }
    if (qPlayer) {
      const q = qPlayer.toLowerCase();
      list = [...list].sort((a, b) => {
        const aMatch = a.player_name.toLowerCase().includes(q) ? 1 : 0;
        const bMatch = b.player_name.toLowerCase().includes(q) ? 1 : 0;
        return bMatch - aMatch;
      });
    }
    return list;
  }, [players, leagueFilter, qInjury, qPlayer]);

  // Get unique leagues that have props today
  const activeLeagues = Array.from(new Set(players.map((p) => p.league_slug))).filter(Boolean);
  const orderedLeagues = LEAGUE_ORDER.filter((l) => activeLeagues.includes(l));

  // Get unique sources
  const activeSources = Array.from(new Set(players.flatMap((p) => p.props.map((pr) => pr.source)))).filter(Boolean);

  // Get active stat markets for filter pills
  const activeMarkets = new Set(players.flatMap((p) => p.props.map((pr) => pr.market)));
  const activeStatFilters = STAT_FILTERS.filter(
    (f) => f.value === "all" || f.markets.some((m) => activeMarkets.has(m))
  );

  // Split: recently returned (10 games or fewer since injury) vs rest
  const recentlyReturned = useMemo(() => {
    const list = filtered.filter(
      (p) => p.injury_date && p.gamesBack > 0 && p.gamesBack <= 10
    );
    // Sort by sortMode
    if (sortMode === "early") {
      list.sort((a, b) => a.gamesBack - b.gamesBack);
    } else if (sortMode === "gap") {
      list.sort((a, b) => {
        const gapA = getMaxGap(a);
        const gapB = getMaxGap(b);
        return gapB - gapA;
      });
    } else if (sortMode === "drop") {
      list.sort((a, b) => {
        const cA = findCurve(a);
        const cB = findCurve(b);
        const dropA = cA ? getCurveImpact(cA, 0, a.league_slug)?.diff ?? 0 : 0;
        const dropB = cB ? getCurveImpact(cB, 0, b.league_slug)?.diff ?? 0 : 0;
        return dropA - dropB; // most negative first
      });
    }
    return list;
  }, [filtered, sortMode, curveMap]);

  const otherPlayers = filtered.filter(
    (p) => !p.injury_date || p.gamesBack === 0 || p.gamesBack > 10
  );

  // Compute max gap between any prop line and return avg
  function getMaxGap(p: PropsPlayer): number {
    let maxGap = 0;
    for (const prop of p.props) {
      if (prop.line == null) continue;
      const statKey = MARKET_TO_STAT[prop.market];
      const returnVal = statKey && p.avgSinceReturn ? p.avgSinceReturn[statKey] : null;
      if (returnVal != null) maxGap = Math.max(maxGap, Math.abs(returnVal - prop.line));
    }
    return maxGap;
  }

  // Top edges for highlight cards
  const topEdges = useMemo(() => {
    return recentlyReturned
      .filter((p) => findCurve(p) != null)
      .map((p) => {
        const curve = findCurve(p)!;
        // Find the BEST prop (highest positive EV), not just the first
        let bestEv: EVResult | null = null;
        let bestProp: PropItem | null = null;

        for (const prop of p.props) {
          const statKey = MARKET_TO_STAT[prop.market];
          const baseline = statKey && p.avg10 ? p.avg10[statKey] : null;
          const recent = statKey && p.avgSinceReturn ? p.avgSinceReturn[statKey] : null;
          if (!statKey || baseline == null || baseline <= 0 || prop.line == null || p.gamesBack <= 0) continue;

          const ev = computeEV({
            baseline, propLine: prop.line,
            overOdds: parseOdds(prop.over_price), underOdds: parseOdds(prop.under_price),
            gamesSinceReturn: p.gamesBack, recentAvg: recent, curve,
            leagueSlug: p.league_slug, statKey,
            preInjuryMinutes: p.avg10?.minutes, currentMinutes: p.avgSinceReturn?.minutes,
          });

          if (ev && ev.bestEv != null && ev.recommendation && (!bestEv || ev.bestEv > (bestEv.bestEv ?? 0))) {
            bestEv = ev;
            bestProp = prop;
          }
        }

        return { player: p, ev: bestEv, prop: bestProp, evVal: bestEv?.bestEv != null && bestEv.bestEv > 0 ? bestEv.bestEv : 0 };
      })
      .filter((e) => e.ev?.recommendation && e.evVal > 0)
      .sort((a, b) => b.evVal - a.evVal)
      .slice(0, 4);
  }, [recentlyReturned, curveMap]);

  // STEP 6: Daily hook counts
  const returningToday = recentlyReturned.filter((p) => p.gamesBack <= 1).length;
  const earlyReturn = recentlyReturned.filter((p) => p.gamesBack <= 3).length;

  return (
    <div className="min-h-screen bg-[#0a0f1a] text-white">
      <SEO
        title="Player Props Today - Injury Return Analysis | Back In Play"
        description="Today's player prop lines analyzed through injury return data. Historical performance trends, return context, and market comparison for returning players."
        path="/props"
      />
      <SiteHeader />

      <EVInfoModal open={showEVInfo} onClose={() => setShowEVInfo(false)} />

      <div className="max-w-3xl mx-auto px-4 py-6">
        {/* STEP 6: Daily hook banner */}
        {(returningToday > 0 || earlyReturn > 0) && !isLoading && (
          <div className="rounded-xl bg-gradient-to-r from-blue-500/10 to-purple-500/10 border border-blue-500/20 px-4 py-3 mb-5">
            <p className="text-sm font-semibold text-white/90">Injury Return Monitor</p>
            <div className="flex items-center gap-4 mt-1 text-[12px] text-white/50">
              {returningToday > 0 && (
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                  {returningToday} player{returningToday !== 1 ? "s" : ""} returning today
                </span>
              )}
              {earlyReturn > 0 && (
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-red-400/80" />
                  <span className="font-medium text-red-400/80">{earlyReturn} in first 3 games</span>
                  <span className="text-white/30">— historically highest impact window</span>
                </span>
              )}
            </div>
          </div>
        )}

        <div className="flex items-center gap-3 mb-2">
          <h1 className="text-2xl font-bold">Player Props</h1>
          <button
            onClick={() => setShowEVInfo(true)}
            className="shrink-0 w-6 h-6 rounded-full border border-white/15 text-white/35 hover:text-white/70 hover:border-white/30 transition-colors text-xs font-semibold flex items-center justify-center"
            title="How the EV model works"
          >
            ?
          </button>
        </div>
        <p className="text-sm text-white/50 mb-5 leading-relaxed">
          Injury return analytics: model projections vs. market lines based on historical recovery data.
          Identify where the market may still reflect injury uncertainty.
        </p>

        {/* Date context */}
        {players.length > 0 && (() => {
          const dates = [...new Set(players.flatMap((p) => p.props.map((pr) => pr.game_date).filter(Boolean)))].sort();
          const todayStr = new Date().toISOString().slice(0, 10);
          const hasTomorrow = dates.some((d) => d && d > todayStr);
          const mostRecent = dates[dates.length - 1];
          const isStale = mostRecent != null && mostRecent < todayStr;
          return (
            <div className={`rounded-lg px-3 py-2 mb-4 text-[11px] ${isStale ? "bg-amber-500/10 text-amber-400/70 border border-amber-500/20" : "bg-white/[0.03] text-white/40 border border-white/5"}`}>
              {isStale ? (
                <span>Showing props from {new Date(mostRecent + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} — today's lines aren't available yet</span>
              ) : (
                <span>
                  {dates.filter((d) => d === todayStr).length > 0 ? "Today's games" : ""}
                  {hasTomorrow ? (dates.filter((d) => d === todayStr).length > 0 ? " + tomorrow's games" : "Tomorrow's games") : ""}
                </span>
              )}
            </div>
          );
        })()}

        {/* STEP 5: League filters */}
        <div className="flex gap-1.5 mb-3 overflow-x-auto pb-1">
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
                onClick={() => { setLeagueFilter(slug); trackLeagueFilter(slug, "props"); }}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors shrink-0 ${
                  leagueFilter === slug ? "bg-white/15 text-white" : "bg-white/5 text-white/40 hover:text-white/60"
                }`}
              >
                {LEAGUE_LABELS[slug]} ({count})
              </button>
            );
          })}
        </div>

        {/* STEP 5: Stat filters */}
        {activeStatFilters.length > 2 && (
          <div className="flex gap-1 mb-3 overflow-x-auto pb-1">
            {activeStatFilters.map((f) => (
              <button
                key={f.value}
                onClick={() => setStatFilter(f.value)}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors shrink-0 ${
                  statFilter === f.value
                    ? "bg-emerald-500/20 text-emerald-400"
                    : "bg-white/5 text-white/35 hover:text-white/55"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        )}

        {/* Source tabs */}
        {activeSources.length > 1 && (
          <div className="flex gap-1 mb-3">
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

        {/* Sort controls */}
        <div className="flex items-center gap-2 mb-4">
          <span className="text-[10px] text-white/25 shrink-0">Sort by</span>
          {SORT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setSortMode(opt.value)}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors ${
                sortMode === opt.value
                  ? "bg-white/12 text-white"
                  : "bg-white/5 text-white/35 hover:text-white/55"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Stats bar */}
        {filtered.length > 0 && (
          <div className="flex gap-4 text-xs text-white/40 mb-4">
            <span>{filtered.length} players with props</span>
            {recentlyReturned.length > 0 && (
              <span>{recentlyReturned.length} recently returned</span>
            )}
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
          <>
            {/* STEP 1: Top signal cards — analytics-first design */}
            {topEdges.length > 0 && (
              <section className="mb-6">
                <h2 className="text-xs font-bold text-[#1C7CFF]/80 uppercase tracking-widest mb-3">Strongest Return Signals</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {topEdges.map(({ player: p, ev: topEv, prop: topProp }) => {
                    const lc = leagueColor(p.league_slug);
                    const side = topEv!.recommendation!;
                    const isOver = side === "OVER";
                    const curve = findCurve(p);
                    const impG3 = curve ? getCurveImpact(curve, 2, p.league_slug) : null;
                    const edge = edgeLabel(topEv!.bestEv!);
                    const statKey = MARKET_TO_STAT[topProp?.market ?? ""];
                    const preVal = statKey && p.avg10 ? (p.avg10 as Record<string, number | undefined>)[statKey.replace("stat_", "")] ?? null : null;
                    const returnVal = statKey && p.avgSinceReturn ? (p.avgSinceReturn as Record<string, number | undefined>)[statKey.replace("stat_", "")] ?? null : null;
                    const propExplanation = topProp ? generatePropExplanation(
                      topProp.market, topProp.line, preVal, returnVal, p.gamesBack, impG3?.diff ?? null
                    ) : null;
                    const modelDiffPct = topProp && topProp.line && topEv!.expectedCombined > 0
                      ? ((topEv!.expectedCombined - topProp.line) / topProp.line * 100)
                      : null;
                    return (
                      <div
                        key={p.player_id}
                        className={`relative rounded-xl border p-4 transition-all overflow-hidden cursor-pointer ${
                          isOver
                            ? "bg-green-500/[0.06] border-green-500/20 hover:border-green-500/40"
                            : "bg-red-500/[0.06] border-red-500/20 hover:border-red-500/40"
                        }`}
                        onClick={() => {
                          trackPlayerAnalysisView({
                            player_name: p.player_name,
                            injury_type: p.injury_type ?? "unknown",
                            games_since_return: p.gamesBack,
                            stat_type: topProp ? (MARKET_LABELS[topProp.market] ?? topProp.market) : undefined,
                            edge_percent: topEv?.bestEv ?? undefined,
                            page_origin: "props_page",
                          });
                          const el = document.getElementById(`prop-player-${p.player_id}`);
                          el?.scrollIntoView({ behavior: "smooth", block: "center" });
                        }}
                      >
                        {/* Player Header + Game Return Badge */}
                        <div className="flex items-center gap-3 mb-2">
                          <PlayerAvatar src={p.headshot_url} name={p.player_name} size={40} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-semibold truncate">{p.player_name}</p>
                              <GameReturnBadge gamesBack={p.gamesBack} />
                            </div>
                            <div className="flex items-center gap-1.5 text-[10px] text-white/35">
                              <span style={{ color: `${lc}aa` }}>{LEAGUE_LABELS[p.league_slug]}</span>
                              <span>·</span>
                              <span>{p.injury_type}</span>
                              <GameTimeBadge commenceTime={p.commence_time} gameDate={p.game_date} />
                            </div>
                          </div>
                        </div>

                        {/* Signal box — market vs model comparison */}
                        {topProp && (
                          <div className={`rounded-lg px-3 py-2.5 mb-2 ${isOver ? "bg-green-500/10" : "bg-red-500/10"}`}>
                            <div className="flex items-center justify-between mb-1.5">
                              <p className="text-[10px] text-white/40">{MARKET_LABELS[topProp.market] ?? topProp.market}</p>
                              <span className={`text-[11px] font-semibold ${edge.color}`}>{edge.text}</span>
                            </div>
                            <div className="flex items-center justify-between">
                              <div className="flex items-baseline gap-4">
                                <div>
                                  <p className="text-[9px] text-white/30">Market</p>
                                  <p className="text-lg font-bold text-white tabular-nums">{topProp.line}</p>
                                </div>
                                <div>
                                  <p className="text-[9px] text-white/30">Model</p>
                                  <p className="text-lg font-bold text-white/60 tabular-nums">{topEv!.expectedCombined.toFixed(1)}</p>
                                </div>
                              </div>
                              <div className="text-right">
                                <p className={`text-xs font-bold ${isOver ? "text-green-400/80" : "text-red-400/80"}`}>
                                  {side}
                                </p>
                                {modelDiffPct != null && (
                                  <p className="text-[10px] text-white/45 mt-0.5">
                                    Model {modelDiffPct > 0 ? "+" : ""}{modelDiffPct.toFixed(1)}% vs market
                                  </p>
                                )}
                              </div>
                            </div>
                          </div>
                        )}

                        {/* Why this signal — 1-line explanation */}
                        {propExplanation && (
                          <p className="text-[10px] text-white/40 italic mb-2 leading-snug">Signal: {propExplanation}</p>
                        )}

                        {/* Metadata row */}
                        <div className="flex items-center gap-3 text-[10px] text-white/35">
                          <span>P({side.toLowerCase()}) <span className="text-white/60 font-medium tabular-nums">{Math.round((isOver ? topEv!.probOver : topEv!.probUnder) * 100)}%</span></span>
                          <span className="text-white/20">|</span>
                          <span>{topEv!.confidence} conf.</span>
                          {impG3 && impG3.diff < 0 && (
                            <>
                              <span className="text-white/20">|</span>
                              <span className="text-red-400/60">{impG3.diff.toFixed(1)} {impG3.label} hist. avg</span>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Premium unlock counter */}
            <div className="flex items-center justify-between mb-3">
              <PremiumUnlockCounter />
              <span className="text-[9px] text-white/15">Free during beta</span>
            </div>

            {/* STEP 2: Daily Opportunities Table */}
            <DailyOpportunitiesTable players={filtered} findCurve={findCurve} />

            {/* Recently Returned from Injury */}
            {recentlyReturned.length > 0 && (
              <section className="mb-8">
                <div className="flex items-center gap-3 mb-3">
                  <h2 className="text-xs font-bold text-[#3DFF8F]/80 uppercase tracking-widest">Recently Returned</h2>
                  <span className="text-[10px] text-white/30">{recentlyReturned.length} players within 10 games of return</span>
                </div>
                <div className="space-y-3">
                  {recentlyReturned.map((p) => (
                    <PlayerPropCard key={p.player_id} player={p} sourceFilter={sourceFilter} curve={findCurve(p)} highlighted={highlightedPlayerId === p.player_id} statFilter={statFilter} />
                  ))}
                </div>
              </section>
            )}

            {/* Other Player Props */}
            {otherPlayers.length > 0 && (
              <section>
                <div className="flex items-center gap-3 mb-3">
                  <h2 className="text-xs font-bold text-white/50 uppercase tracking-widest">Other Player Props</h2>
                  <span className="text-[10px] text-white/30">{otherPlayers.length} players</span>
                </div>
                <div className="space-y-3">
                  {otherPlayers.map((p) => (
                    <PlayerPropCard key={p.player_id} player={p} sourceFilter={sourceFilter} curve={findCurve(p)} highlighted={highlightedPlayerId === p.player_id} statFilter={statFilter} />
                  ))}
                </div>
              </section>
            )}
            {/* Early access CTA */}
            <EarlyAccessCTA className="mt-6 border-t border-white/5" page="props" location="page_footer" />
          </>
        )}
      </div>
    </div>
  );
}
