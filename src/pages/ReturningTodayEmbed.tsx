/**
 * Lightweight embed of ReturningTodayPage content for the homepage tab.
 * Renders just the player list without header/hero/SEO chrome.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase, dbTable } from "../lib/supabase";
import { InjuryPlayerCard } from "../components/InjuryPlayerCard";
import type { PerformanceCurve } from "../features/performance-curves/lib/types";
import { STAT_LABELS, LEAGUE_STATS } from "../features/performance-curves/lib/types";

const LEAGUE_LABELS: Record<string, string> = {
  all: "All Leagues", nba: "NBA", nfl: "NFL", mlb: "MLB", nhl: "NHL", "premier-league": "EPL",
};

interface ReturningPlayer {
  player_id: string;
  player_name: string;
  player_slug: string;
  position: string;
  team_name: string;
  league_slug: string;
  headshot_url: string | null;
  injury_type: string;
  injury_type_slug: string;
  date_injured: string;
  expected_return: string | null;
  return_date: string | null;
  status: string;
  is_star: boolean;
  is_starter: boolean;
  games_missed: number | null;
  curve: PerformanceCurve | null;
}

function useReturningPlayers(leagueSlug?: string) {
  return useQuery<ReturningPlayer[]>({
    queryKey: ["returning-today", leagueSlug ?? "all"],
    queryFn: async () => {
      const { data: leagues } = await supabase.from(dbTable("leagues")).select("league_id,league_name,slug");
      const leagueMap = new Map<string, { name: string; slug: string }>();
      (leagues ?? []).forEach((l: any) => leagueMap.set(l.league_id, { name: l.league_name, slug: l.slug }));

      const { data: teams } = await supabase.from(dbTable("teams")).select("team_id,team_name,league_id").neq("team_name", "Unknown");
      const teamMap = new Map<string, { name: string; leagueId: string }>();
      (teams ?? []).forEach((t: any) => teamMap.set(t.team_id, { name: t.team_name, leagueId: t.league_id }));

      const cutoff7d = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      const cutoff90d = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);

      const { data: returningInjuries } = await supabase
        .from(dbTable("injuries")).select("*")
        .gte("date_injured", cutoff90d)
        .in("status", ["questionable", "day-to-day", "probable", "game_time_decision"])
        .order("date_injured", { ascending: false }).limit(200);

      const { data: recentlyReturned } = await supabase
        .from(dbTable("injuries")).select("*")
        .gte("return_date", cutoff7d).eq("status", "returned")
        .order("return_date", { ascending: false }).limit(100);

      const allInjs = [...(returningInjuries ?? []), ...(recentlyReturned ?? [])];
      const byPlayer = new Map<string, (typeof allInjs)[0]>();
      for (const inj of allInjs) {
        if (!byPlayer.has(inj.player_id)) byPlayer.set(inj.player_id, inj);
      }

      const playerIds = Array.from(byPlayer.keys());
      if (playerIds.length === 0) return [];

      const players = new Map<string, any>();
      for (let i = 0; i < playerIds.length; i += 100) {
        const chunk = playerIds.slice(i, i + 100);
        const { data } = await supabase.from(dbTable("players")).select("player_id,player_name,slug,position,team_id,headshot_url,is_star,is_starter").in("player_id", chunk);
        (data ?? []).forEach((p: any) => players.set(p.player_id, p));
      }

      const injSlugs = [...new Set(Array.from(byPlayer.values()).map((i) => i.injury_type_slug).filter(Boolean))];
      const curves = new Map<string, PerformanceCurve>();
      if (injSlugs.length > 0) {
        const { data: curveData } = await supabase.from(dbTable("performance_curves")).select("*").in("injury_type_slug", injSlugs).eq("position", "").gte("sample_size", 10);
        (curveData ?? []).forEach((c: any) => curves.set(`${c.injury_type_slug}|${c.league_slug}`, c));
      }

      const result: ReturningPlayer[] = [];
      for (const [pid, inj] of byPlayer) {
        const p = players.get(pid);
        if (!p) continue;
        const team = teamMap.get(p.team_id);
        if (!team) continue;
        const league = leagueMap.get(team.leagueId);
        if (!league) continue;
        if (leagueSlug && league.slug !== leagueSlug) continue;
        const curveKey = `${inj.injury_type_slug}|${league.slug}`;
        result.push({
          player_id: pid, player_name: p.player_name, player_slug: p.slug,
          position: p.position ?? "", team_name: team.name, league_slug: league.slug,
          headshot_url: p.headshot_url, injury_type: inj.injury_type,
          injury_type_slug: inj.injury_type_slug, date_injured: inj.date_injured,
          expected_return: inj.expected_return, return_date: inj.return_date ?? null, status: inj.status,
          is_star: p.is_star ?? false, is_starter: p.is_starter ?? false,
          games_missed: inj.games_missed, curve: curves.get(curveKey) ?? null,
        });
      }
      result.sort((a, b) => (b.is_star ? 1 : 0) - (a.is_star ? 1 : 0) || a.player_name.localeCompare(b.player_name));
      return result;
    },
    staleTime: 5 * 60 * 1000,
  });
}

/** Estimate which game number (1-10) a player is heading into based on return_date and league schedule. */
function estimateNextGame(player: ReturningPlayer): number {
  // If not yet returned, next game is G1
  if (!player.return_date) return 1;
  const returnDate = new Date(player.return_date);
  const daysSinceReturn = Math.max(0, Math.floor((Date.now() - returnDate.getTime()) / 86400000));
  // Average days between games by league
  const avgDaysPerGame: Record<string, number> = { nba: 2.4, nfl: 7, nhl: 2.3, mlb: 1.1, "premier-league": 4 };
  const dpg = avgDaysPerGame[player.league_slug] ?? 3;
  const gamesPlayed = Math.floor(daysSinceReturn / dpg);
  // Next game is gamesPlayed + 1, capped at 10
  return Math.min(Math.max(gamesPlayed + 1, 1), 10);
}

function parseJsonArray(val: unknown): (number | null)[] {
  if (Array.isArray(val)) return val;
  if (typeof val === "string") try { return JSON.parse(val); } catch { return []; }
  return [];
}

function PlayerCard({ player, multiLeague }: { player: ReturningPlayer; multiLeague: boolean }) {
  const curve = player.curve;
  const medianPct = curve ? parseJsonArray(curve.median_pct_recent) : [];
  const nextGame = estimateNextGame(player);
  const gameIdx = nextGame - 1; // 0-indexed
  const gPct = medianPct[gameIdx] != null ? Math.round((medianPct[gameIdx] as number) * 100) : null;
  const stats = curve && curve.league_slug ? (LEAGUE_STATS[curve.league_slug] ?? []) : [];
  const statAvg = curve?.stat_avg_pct as Record<string, (number | null)[]> | null;

  return (
    <InjuryPlayerCard
      player_name={player.player_name} player_slug={player.player_slug}
      position={player.position} team_name={player.team_name}
      league_slug={player.league_slug} headshot_url={player.headshot_url}
      status={player.status} injury_type={player.injury_type}
      date_injured={player.date_injured} expected_return={player.expected_return}
      is_star={player.is_star} is_starter={player.is_starter}
      games_missed={player.games_missed} showLeague={multiLeague}
    >
      {curve && gPct != null && (
        <div className="px-4 pb-3">
          <div className="rounded-lg bg-white/[0.03] border border-white/8 p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] text-white/40 uppercase tracking-wider">
                Expected G{nextGame} Performance
              </span>
              <span className={`text-sm font-bold ${gPct >= 95 ? "text-green-400" : gPct >= 80 ? "text-amber-400" : "text-red-400"}`}>
                {gPct}% of baseline
              </span>
            </div>
            {/* Mini curve: 10 dots showing median % per game, with next game highlighted */}
            <div className="flex items-end gap-1 h-8 mt-1 mb-2">
              {Array.from({ length: 10 }, (_, i) => {
                const val = medianPct[i] != null ? (medianPct[i] as number) : null;
                if (val == null) return <div key={i} className="flex-1 flex flex-col items-center justify-end"><div className="w-1.5 h-1.5 rounded-full bg-white/10" /></div>;
                const h = Math.max(val * 100, 10); // scale height
                const isNext = i === gameIdx;
                return (
                  <div key={i} className="flex-1 flex flex-col items-center justify-end gap-0.5">
                    {isNext && <span className="text-[8px] text-[#1C7CFF] font-bold">G{nextGame}</span>}
                    <div
                      className={`w-full max-w-[6px] rounded-full transition-all ${isNext ? "bg-[#1C7CFF] shadow-[0_0_6px_rgba(28,124,255,0.5)]" : "bg-white/20"}`}
                      style={{ height: `${h * 0.28}px` }}
                    />
                  </div>
                );
              })}
            </div>
            {stats.length > 0 && statAvg && (
              <div className="flex flex-wrap gap-2 mt-1">
                {stats.slice(0, 4).map((s) => {
                  const arr = parseJsonArray(statAvg[s]);
                  const v = arr[gameIdx] != null ? Math.round((arr[gameIdx] as number) * 100) : null;
                  if (v == null) return null;
                  return (
                    <span key={s} className="text-[10px] text-white/30">
                      {STAT_LABELS[s] ?? s}: <span className={v >= 95 ? "text-green-400/70" : v >= 80 ? "text-amber-400/70" : "text-red-400/70"}>{v}%</span>
                    </span>
                  );
                })}
              </div>
            )}
            <p className="text-[9px] text-white/20 mt-1.5">
              Based on {curve.sample_size} historical {player.injury_type.toLowerCase()} returns
            </p>
          </div>
        </div>
      )}
    </InjuryPlayerCard>
  );
}

export default function ReturningTodayEmbed({ leagueSlug }: { leagueSlug?: string }) {
  const { data: players = [], isLoading } = useReturningPlayers(leagueSlug);
  const returning = useMemo(() => players.filter((p) => p.status !== "returned"), [players]);
  const recentlyBack = useMemo(() => players.filter((p) => p.status === "returned"), [players]);

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3, 4].map((i) => <div key={i} className="h-28 rounded-xl bg-white/10 animate-pulse" />)}
      </div>
    );
  }

  if (returning.length === 0 && recentlyBack.length === 0) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 p-8 text-center">
        <p className="text-white/50">No players currently nearing return{leagueSlug ? ` in the ${LEAGUE_LABELS[leagueSlug]}` : ""}.</p>
        <p className="text-xs text-white/30 mt-2">Check back during the season for daily return updates.</p>
      </div>
    );
  }

  return (
    <>
      {returning.length > 0 && (
        <section className="mb-8">
          <h2 className="text-lg font-bold mb-3 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-amber-400" />
            Nearing Return ({returning.length})
          </h2>
          <div className="space-y-3">
            {returning.map((p) => <PlayerCard key={p.player_id} player={p} multiLeague={!leagueSlug} />)}
          </div>
        </section>
      )}
      {recentlyBack.length > 0 && (
        <section className="mb-8">
          <h2 className="text-lg font-bold mb-3 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-400" />
            Recently Returned ({recentlyBack.length})
          </h2>
          <div className="space-y-3">
            {recentlyBack.map((p) => <PlayerCard key={p.player_id} player={p} multiLeague={!leagueSlug} />)}
          </div>
        </section>
      )}
    </>
  );
}
