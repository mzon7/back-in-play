// @refresh reset
import { useState, useEffect, useRef, useMemo, useCallback, lazy, Suspense } from "react";
import { Link, useParams } from "react-router-dom";
import {
  useLeagues,
  useCurrentInjuries,
  useTopPlayerInjuries,
  useStatusChanges,
  type InjuryRow,
  type StatusChangeRow,
} from "../../../hooks/useInjuries";
import { StatusBadge } from "../../../components/StatusBadge";
import { PlayerAvatar } from "../../../components/PlayerAvatar";
import { InjuryPlayerCard } from "../../../components/InjuryPlayerCard";
import { SEO } from "../../../components/seo/SEO";
import { supabase } from "../../../lib/supabase";
import { leagueColor } from "../../../lib/leagueColors";
import { trackHeadlineClick } from "../../../lib/analytics";
import { isTrackedPlayer, toggleTrackedPlayer } from "../../../lib/trackedPlayers";
import { usePerformanceCurves } from "../../performance-curves/lib/queries";
import type { PerformanceCurve } from "../../performance-curves/lib/types";
import { STAT_LABELS, LEAGUE_STATS } from "../../performance-curves/lib/types";
import { isRealInjury } from "../../../lib/injuryFilters";
import { computeEV, formatEV, parseOdds, type EVResult } from "../../../lib/evModel";
import { useQuery } from "@tanstack/react-query";

const LazyReturningToday = lazy(() => import("../../../pages/ReturningTodayEmbed"));
const LazyRecoveryStats = lazy(() => import("../../../pages/RecoveryStatsPageEmbed"));

type HomeSection = "injuries" | "returning" | "recovery";

const LEAGUE_ORDER = ["nba", "nfl", "mlb", "nhl", "premier-league"];
const LEAGUE_LABELS: Record<string, string> = {
  nba: "NBA",
  nfl: "NFL",
  mlb: "MLB",
  nhl: "NHL",
  "premier-league": "EPL",
};

type Section = "out" | "back" | "reduced" | "active";

const SECTIONS: { key: Section; label: string; emoji: string; color: string; desc: string }[] = [
  { key: "out", label: "Injuries", emoji: "\u26A0\uFE0F", color: "text-red-400", desc: "Currently sidelined" },
  { key: "back", label: "Back In Play", emoji: "\u26A1", color: "text-cyan-400", desc: "Back to full usual minutes" },
  { key: "reduced", label: "Reduced Load", emoji: "\uD83D\uDCCA", color: "text-amber-400", desc: "Minutes below 80% pre-injury" },
  { key: "active", label: "Active", emoji: "\u2705", color: "text-green-400", desc: "Cleared from injury report" },
];

const LEAGUE_DOT: Record<string, string> = {
  nba: "bg-orange-400",
  nfl: "bg-green-500",
  mlb: "bg-red-500",
  nhl: "bg-blue-400",
  "premier-league": "bg-purple-400",
};

// Time caps per section: Returned=14d, Reduced Load=10d, Active=7d
const _daysAgoStr = (d: number) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
const FOURTEEN_DAYS_AGO = _daysAgoStr(14);
const TEN_DAYS_AGO = _daysAgoStr(10);
const SEVEN_DAYS_AGO = _daysAgoStr(7);

/** Median of a numeric array */
function arrMedian(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function classifySection(inj: InjuryRow): Section | null {
  const s = (inj.status ?? "").toLowerCase().replace(/-/g, "_");
  const relevantDate = inj.return_date ?? inj.date_injured ?? "";

  // Active (fully back) — show for 7 days then gone
  if (["active", "active_today", "probable"].includes(s)) {
    if (relevantDate < SEVEN_DAYS_AGO) return null;
    return "active";
  }
  // Reduced load — show for 10 days then hidden
  if (s === "reduced_load") {
    if (relevantDate < TEN_DAYS_AGO) return null;
    return "reduced";
  }
  // Returned to play — show for 14 days then hidden
  if (s === "back_in_play" || s === "returned") {
    if (relevantDate < FOURTEEN_DAYS_AGO) return null;
    return "back";
  }
  // Injured (out/day-to-day/questionable/etc) — always show
  return "out";
}

/** Off-season leagues get demoted so in-season injuries rank higher on the "Top Players" tab.
 *  Each league maps to [startMonth, endMonth] (1-indexed). */
const LEAGUE_SEASON: Record<string, [number, number]> = {
  nba: [10, 6],
  nfl: [9, 2],
  mlb: [3, 10],
  nhl: [10, 6],
  "premier-league": [8, 5],
};

function isInSeason(leagueSlug: string | null | undefined): boolean {
  if (!leagueSlug) return true;
  const range = LEAGUE_SEASON[leagueSlug];
  if (!range) return true;
  const month = new Date().getMonth() + 1; // 1-12
  const [start, end] = range;
  return start <= end ? month >= start && month <= end : month >= start || month <= end;
}

/** High-value positions get a boost (NFL QB/RB, NBA PG, etc.) */
const POSITION_BOOST: Record<string, number> = {
  QB: 3, RB: 2, WR: 1.5, TE: 1.2, // NFL
  PG: 1.5, SG: 1.2, SF: 1.2, PF: 1.2, // NBA
  GK: 1.5, ST: 1.5, CAM: 1.3, // Soccer
  G: 1.5, D: 1.1, // NHL
  C: 1.3, LW: 1.3, RW: 1.3, CF: 1.5, // shared (NBA C / NHL C, Soccer wings)
  SP: 1.5, RP: 1, "1B": 1.2, SS: 1.3, // MLB
};

function daysAgo(dateStr: string | null | undefined): number {
  if (!dateStr) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000));
}

/**
 * Importance score = player importance × recency.
 * Stars get 5x, starters 3x, ranked players scale by rank.
 * High-value positions (QB, RB, etc.) get a boost.
 * More recent injuries rank higher.
 */
function importanceScore(inj: InjuryRow): number {
  let importance = 1;
  if (inj.is_star) importance = 10;
  else if (inj.is_starter) importance = 6;
  else {
    const rank = Math.min(inj.preseason_rank ?? 999, inj.league_rank ?? 999, inj.rank_at_injury ?? 999);
    if (rank <= 10) importance = 8;
    else if (rank <= 30) importance = 5;
    else if (rank <= 50) importance = 3;
  }

  const pos = (inj.position ?? "").toUpperCase();
  importance *= (POSITION_BOOST[pos] ?? 1);

  const days = daysAgo(inj.date_injured);
  const recency = days <= 1 ? 1.0 : days <= 7 ? 0.8 : days <= 14 ? 0.6 : days <= 30 ? 0.3 : 0.1;

  // Demote off-season leagues so in-season injuries surface first
  const seasonMultiplier = isInSeason(inj.league_slug) ? 1.0 : 0.15;

  return importance * recency * seasonMultiplier;
}

function sortByImportance(a: InjuryRow, b: InjuryRow): number {
  return importanceScore(b) - importanceScore(a);
}

function StatusTimeline({ playerId }: { playerId: string }) {
  const [changes, setChanges] = useState<StatusChangeRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase
      .from("back_in_play_status_changes")
      .select("*")
      .eq("player_id", playerId)
      .neq("change_type", "updated")
      .order("changed_at", { ascending: true })
      .limit(20)
      .then(({ data }) => {
        setChanges(data ?? []);
        setLoading(false);
      });
  }, [playerId]);

  if (loading) return <div className="h-8 bg-white/5 rounded animate-pulse mt-2" />;
  if (changes.length === 0) return <p className="text-xs text-white/25 mt-2">No status history</p>;

  return (
    <div className="mt-3 pt-3 border-t border-white/10">
      <p className="text-[11px] text-white/40 mb-2 font-semibold uppercase tracking-wide">Status Timeline</p>
      <div className="flex items-start gap-0 overflow-x-auto pb-1">
        {changes.map((c, i) => (
          <div key={c.id} className="flex items-center shrink-0">
            <div className="flex flex-col items-center gap-1">
              <StatusBadge status={c.new_status} />
              <span className="text-[10px] text-white/30 whitespace-nowrap">
                {new Date(c.changed_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </span>
              <span className="text-[9px] text-white/20 max-w-[80px] text-center truncate">{c.summary}</span>
            </div>
            {i < changes.length - 1 && (
              <div className="w-6 h-px bg-white/10 mx-1 mt-[-12px]" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function InjuryCard({ inj, showLeague }: { inj: InjuryRow; showLeague?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const rank = inj.preseason_rank ?? inj.league_rank ?? inj.rank_at_injury;

  return (
    <InjuryPlayerCard
      player_name={inj.player_name ?? ""}
      player_slug={inj.player_slug}
      position={inj.position}
      team_name={inj.team_name}
      league_slug={inj.league_slug}
      league_name={inj.league_name}
      headshot_url={inj.headshot_url}
      status={inj.status}
      injury_type={inj.injury_type}
      injury_description={inj.injury_description}
      date_injured={inj.date_injured}
      expected_return={inj.expected_return}
      return_date={inj.return_date}
      is_star={inj.is_star}
      is_starter={inj.is_starter}
      side={inj.side}
      long_comment={inj.long_comment}
      source={inj.source}
      games_missed={inj.games_missed}
      game_minutes={inj.game_minutes}
      pre_injury_avg_minutes={inj.pre_injury_avg_minutes}
      rank={rank}
      showLeague={showLeague}
    >
      {/* Timeline toggle — separate from the navigable card */}
      <div className="px-4 pb-3">
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-white/25 hover:text-white/50 transition-colors"
        >
          {expanded ? "hide timeline" : "show timeline"}
        </button>
        {expanded && <StatusTimeline playerId={inj.player_id} />}
      </div>
    </InjuryPlayerCard>
  );
}

const INITIAL_SECTION_LIMIT = 10;

function SectionBlock({
  section,
  injuries,
  showLeague,
  defaultCollapsed = false,
}: {
  section: (typeof SECTIONS)[number];
  injuries: InjuryRow[];
  showLeague?: boolean;
  defaultCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [showAll, setShowAll] = useState(false);

  if (injuries.length === 0) return null;
  const sortedAll = [...injuries].sort(sortByImportance);
  // Deduplicate by player — keep only the most recent (first after sort) injury per player
  const seenPids = new Set<string>();
  const sorted = sortedAll.filter((inj) => {
    if (seenPids.has(inj.player_id)) return false;
    seenPids.add(inj.player_id);
    return true;
  });
  const visible = showAll ? sorted : sorted.slice(0, INITIAL_SECTION_LIMIT);
  const hasMore = sorted.length > INITIAL_SECTION_LIMIT;

  return (
    <div id={`section-${section.key}`} className="scroll-mt-32 rounded-2xl border border-white/8 bg-white/[0.02]">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center gap-2.5 px-5 py-4 text-left"
      >
        <span className="text-xl">{section.emoji}</span>
        <h3 className={`text-base font-bold uppercase tracking-wide ${section.color}`}>
          {section.label}
        </h3>
        <span className="text-sm text-white/40">({sorted.length})</span>
        <span className="text-xs text-white/30 ml-1 hidden sm:inline">{section.desc}</span>
        <span className="ml-auto text-white/30 text-sm transition-transform" style={{ transform: collapsed ? "rotate(-90deg)" : "rotate(0)" }}>&#9660;</span>
      </button>

      {!collapsed && (
        <div className="px-5 pb-5 space-y-2.5">
          {visible.map((inj) => (
            <InjuryCard key={inj.injury_id} inj={inj} showLeague={showLeague} />
          ))}
          {hasMore && !showAll && (
            <button
              onClick={() => setShowAll(true)}
              className="w-full py-2.5 rounded-lg border border-white/10 text-sm text-white/50 hover:bg-white/5 hover:text-white/70 transition-colors"
            >
              Show all {sorted.length} players
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function JumpNav({ grouped }: { grouped: Record<Section, InjuryRow[]> }) {
  const items: { id: string; label: string; count?: number }[] = [
    { id: "section-headlines", label: "Headlines" },
    { id: "section-updates", label: "Updates" },
  ];
  for (const sec of SECTIONS) {
    if (grouped[sec.key].length > 0) {
      items.push({ id: `section-${sec.key}`, label: sec.label, count: grouped[sec.key].length });
    }
  }

  return (
    <nav className="flex flex-wrap gap-1.5 py-3 border-b border-white/8 mb-2">
      {items.map((item) => (
        <button
          key={item.id}
          onClick={() => document.getElementById(item.id)?.scrollIntoView({ behavior: "smooth", block: "start" })}
          className="px-3 py-1.5 rounded-full text-xs font-medium text-white/50 border border-white/10 hover:bg-white/10 hover:text-white/70 transition-colors"
        >
          {item.label}{item.count != null ? ` (${item.count})` : ""}
        </button>
      ))}
    </nav>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="h-28 rounded-xl bg-white/10 animate-pulse" />
      ))}
    </div>
  );
}

function EmptyBox({ message, hint }: { message: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center">
      <p className="text-sm text-white/50">{message}</p>
      {hint && <p className="mt-1 text-xs text-white/35">{hint}</p>}
    </div>
  );
}

/** Micro trend indicator: improvement ↑, worsening ↓, neutral → */
const STATUS_SEVERITY: Record<string, number> = {
  out: 0, ir: 0, surgery: 0,
  doubtful: 1,
  questionable: 2,
  day_to_day: 3, dtd: 3,
  probable: 4,
  reduced_load: 5,
  back_in_play: 6,
  active: 7, active_today: 7, returned: 7, cleared: 7,
};

function trendIndicator(oldStatus: string | null, newStatus: string): { icon: string; color: string } {
  if (!oldStatus) return { icon: "", color: "" };
  const oldSev = STATUS_SEVERITY[oldStatus.toLowerCase().replace(/-/g, "_")] ?? 3;
  const newSev = STATUS_SEVERITY[newStatus.toLowerCase().replace(/-/g, "_")] ?? 3;
  if (newSev > oldSev) return { icon: "\u2191", color: "text-green-400" }; // improvement
  if (newSev < oldSev) return { icon: "\u2193", color: "text-red-400" }; // worsening
  return { icon: "\u2192", color: "text-white/40" }; // neutral
}

const CHANGE_TYPE_STYLE: Record<string, string> = {
  status_change: "text-amber-400",
  new_injury: "text-red-400",
  activated: "text-green-400",
  updated: "text-white/50",
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function StatusUpdatesBlock({ statusChanges, isLoadingChanges, showLeague, leagueSlug, teamFilter }: { statusChanges: StatusChangeRow[]; isLoadingChanges: boolean; showLeague?: boolean; leagueSlug?: string; teamFilter?: string | null }) {
  const isLoading = isLoadingChanges;

  // Filter by league and team, exclude "active" status transitions, then deduplicate
  const seen = new Set<string>();
  const changes = (statusChanges ?? [])
    .filter((c) => !leagueSlug || c.league_slug === leagueSlug)
    .filter((c) => !teamFilter || c.team_name === teamFilter)
    .filter((c) => c.new_status !== "active")
    .filter((c) => {
      if (seen.has(c.player_id)) return false;
      seen.add(c.player_id);
      return true;
    }).slice(0, 20);

  if (isLoading) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-xl">{"\uD83D\uDCE2"}</span>
          <h3 className="text-base font-bold uppercase tracking-wide text-[#1C7CFF]">Player Status Updates</h3>
        </div>
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-14 rounded-xl bg-white/10 animate-pulse" />
        ))}
      </div>
    );
  }

  if (changes.length === 0) return null;

  return (
    <div id="section-updates" className="scroll-mt-32 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-xl">{"\uD83D\uDCE2"}</span>
        <h3 className="text-base font-bold uppercase tracking-wide text-[#1C7CFF]">
          Player Status Updates
        </h3>
        <span className="text-sm text-white/40">({changes.length})</span>
        <span className="text-xs text-white/30 ml-1 hidden sm:inline">Last 24 hours</span>
      </div>
      <div className="space-y-1.5">
        {changes.map((c) => (
          <Link
            key={c.id}
            to={`/player/${c.player_slug || (c.player_name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`}
            className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/5 px-4 py-3 hover:bg-white/[0.07] transition-colors"
          >
            <PlayerAvatar src={c.headshot_url} name={c.player_name ?? "?"} size={36} className="rounded-full" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[15px] font-semibold text-white truncate">{c.player_name}</span>
                <span className={`text-xs font-semibold ${CHANGE_TYPE_STYLE[c.change_type] ?? "text-white/50"}`}>
                  — {c.summary}
                </span>
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs text-white/40">{c.team_name}</span>
                {showLeague && c.league_slug && (
                  <span className="flex items-center gap-1 text-xs text-white/35">
                    <span className={`h-1.5 w-1.5 rounded-full ${LEAGUE_DOT[c.league_slug] ?? "bg-white/30"}`} />
                    {LEAGUE_LABELS[c.league_slug] ?? ""}
                  </span>
                )}
                <span className="text-xs text-white/30">{timeAgo(c.changed_at)}</span>
              </div>
            </div>
            {c.old_status && c.new_status && c.old_status !== c.new_status && (() => {
              const trend = trendIndicator(c.old_status, c.new_status);
              return (
                <div className="flex items-center gap-1.5 shrink-0">
                  <StatusBadge status={c.old_status} />
                  <span className="text-white/40 text-xs">{"\u2192"}</span>
                  <StatusBadge status={c.new_status} />
                  {trend.icon && (
                    <span className={`text-sm font-bold ${trend.color}`}>{trend.icon}</span>
                  )}
                </div>
              );
            })()}
          </Link>
        ))}
      </div>
    </div>
  );
}

/* -- Headline Stories: square cards for high-impact events -- */

const HEADLINE_TYPE_LABEL: Record<string, { text: string; color: string; cardBorder: string; cardBorderHover: string; cardTint: string; cta: string }> = {
  injury:        { text: "NEW INJURY",     color: "text-red-400 bg-red-500/15 border border-red-500/25",       cardBorder: "rgba(239,68,68,0.22)",  cardBorderHover: "rgba(239,68,68,0.38)",  cardTint: "rgba(239,68,68,0.04)",  cta: "See injury outlook \u2192" },
  return:        { text: "RETURNED",       color: "text-green-400 bg-green-500/15 border border-green-500/25", cardBorder: "rgba(34,197,94,0.22)",  cardBorderHover: "rgba(34,197,94,0.38)",  cardTint: "rgba(34,197,94,0.04)",  cta: "See return analysis \u2192" },
  status_change: { text: "STATUS CHANGE",  color: "text-amber-400 bg-amber-500/15 border border-amber-500/25", cardBorder: "rgba(245,158,11,0.18)", cardBorderHover: "rgba(245,158,11,0.32)", cardTint: "rgba(245,158,11,0.03)", cta: "See details \u2192" },
};

type HeadlineCard = {
  key: string;
  player_name: string;
  player_slug: string;
  headshot_url: string | null;
  team_name: string;
  league_slug: string;
  status: string;
  summary: string;
  impact: "Critical" | "High" | "Medium";
  impactColor: string;
  timeAgo: string;
  type: "injury" | "return" | "status_change";
};

/** Star rating: 10 for is_star, 8 for top-10 rank, 6 for starter, scale by rank, 1 for unranked */
function starRating(inj: InjuryRow): number {
  if (inj.is_star) return 10;
  const rank = Math.min(inj.preseason_rank ?? 999, inj.league_rank ?? 999, inj.rank_at_injury ?? 999);
  if (rank <= 10) return 9;
  if (rank <= 20) return 7;
  if (rank <= 30) return 6;
  if (inj.is_starter) return 5;
  if (rank <= 50) return 4;
  return 1;
}

/** Recency factor: today=1.0, yesterday=0.9, last week=0.7, older decays */
function recencyFactor(dateStr: string | null | undefined): number {
  const days = daysAgo(dateStr);
  if (days <= 0) return 1.0;
  if (days <= 1) return 0.9;
  if (days <= 3) return 0.8;
  if (days <= 7) return 0.7;
  if (days <= 14) return 0.5;
  return 0.3;
}


function impactFromScore(score: number): HeadlineCard["impact"] {
  if (score >= 7) return "Critical";
  if (score >= 4) return "High";
  return "Medium";
}

const IMPACT_COLORS: Record<string, string> = {
  Critical: "text-red-400 bg-red-400/10 border-red-400/30",
  High: "text-amber-400 bg-amber-400/10 border-amber-400/30",
  Medium: "text-cyan-400 bg-cyan-400/10 border-cyan-400/30",
};

function buildHeadlineCards(injuries: InjuryRow[], changes: StatusChangeRow[], maxCards = 8): HeadlineCard[] {
  const minScore = maxCards <= 5 ? 0 : 3;

  // Build scored candidates from BOTH injuries and status changes
  type Candidate = { card: HeadlineCard; score: number; playerId: string };
  const candidates: Candidate[] = [];

  // Candidates from injuries
  for (const inj of injuries) {
    const status = (inj.status ?? "out").toLowerCase().replace(/-/g, "_");
    // Skip "active" — player is healthy, not newsworthy as an injury
    if (status === "active") continue;
    const isReturning = ["active_today", "back_in_play", "returned"].includes(status);

    // For returns, use return_date for recency; skip if older than 14 days
    const relevantDate = isReturning ? (inj.return_date ?? inj.date_injured) : inj.date_injured;
    if (isReturning && daysAgo(relevantDate) > 14) continue;

    const seasonMult = isInSeason(inj.league_slug) ? 1.0 : 0.15;
    const score = starRating(inj) * recencyFactor(relevantDate) * seasonMult;
    if (score < minScore) continue;

    const impact = impactFromScore(score);
    const days = daysAgo(relevantDate);

    candidates.push({
      playerId: inj.player_id,
      score,
      card: {
        key: `inj-${inj.injury_id}`,
        player_name: inj.player_name ?? "Unknown",
        player_slug: inj.player_slug ?? "",
        headshot_url: inj.headshot_url ?? null,
        team_name: (inj.team_name && inj.team_name !== "Unknown") ? inj.team_name : "",
        league_slug: inj.league_slug ?? "",
        status: inj.status ?? "out",
        summary: isReturning ? "Returning to action" : `${(inj.injury_type?.toLowerCase() === "other" ? "Unspecified" : inj.injury_type) ?? "Injury"} — ${inj.status}`,
        impact,
        impactColor: IMPACT_COLORS[impact],
        timeAgo: days === 0 ? "Today" : days === 1 ? "Yesterday" : `${days}d ago`,
        type: isReturning ? "return" : "injury",
      },
    });
  }

  // Candidates from status changes (scored equally with injuries)
  for (const c of changes) {
    if (c.change_type === "updated") continue;
    // Skip any change where the player ends up "active" — they're healthy, not news
    if (c.new_status === "active") continue;
    const isDowngrade = c.summary?.toLowerCase().includes("downgraded");
    const isActivation = c.change_type === "activated";
    if (!isActivation && !isDowngrade && c.change_type !== "new_injury") continue;

    // Score: higher = more newsworthy, scaled by recency and season
    const recency = recencyFactor(c.changed_at);
    const eventWeight = c.change_type === "new_injury" ? 9 : isActivation ? 8 : isDowngrade ? 7 : 6;
    const seasonMult = isInSeason(c.league_slug) ? 1.0 : 0.15;
    const score = eventWeight * recency * seasonMult;
    if (score < minScore) continue;

    const impact = impactFromScore(score);
    const type: HeadlineCard["type"] = c.change_type === "new_injury" ? "injury"
      : isActivation ? "return" : "status_change";
    candidates.push({
      playerId: c.player_id,
      score,
      card: {
        key: `sc-${c.id}`,
        player_name: c.player_name ?? "Unknown",
        player_slug: c.player_slug ?? "",
        headshot_url: c.headshot_url ?? null,
        team_name: c.team_name ?? "",
        league_slug: c.league_slug ?? "",
        status: c.new_status,
        summary: c.summary,
        impact,
        impactColor: IMPACT_COLORS[impact],
        timeAgo: timeAgo(c.changed_at),
        type,
      },
    });
  }

  // Sort all candidates by score, deduplicate by player, take top N
  candidates.sort((a, b) => b.score - a.score);
  const seenPlayers = new Set<string>();
  const cards: HeadlineCard[] = [];
  for (const { card, playerId } of candidates) {
    if (seenPlayers.has(playerId)) continue;
    seenPlayers.add(playerId);
    cards.push(card);
    if (cards.length >= maxCards) break;
  }

  return cards;
}

/** Higher-contrast status badge for headline cards only */
const HEADLINE_BADGE: Record<string, { label: string; classes: string }> = {
  out:          { label: "OUT",          classes: "bg-red-500/25 text-red-300 border-red-400/40" },
  ir:           { label: "IR",           classes: "bg-red-500/25 text-red-300 border-red-400/40" },
  "il-10":      { label: "IL-10",        classes: "bg-red-500/25 text-red-300 border-red-400/40" },
  "il-15":      { label: "IL-15",        classes: "bg-red-500/25 text-red-300 border-red-400/40" },
  "il-60":      { label: "IL-60",        classes: "bg-red-500/25 text-red-300 border-red-400/40" },
  doubtful:     { label: "DOUBTFUL",     classes: "bg-orange-500/25 text-orange-300 border-orange-400/40" },
  questionable: { label: "QUESTIONABLE", classes: "bg-yellow-500/25 text-yellow-300 border-yellow-400/40" },
  "day-to-day": { label: "DAY-TO-DAY",  classes: "bg-amber-500/25 text-amber-300 border-amber-400/40" },
  probable:     { label: "PROBABLE",     classes: "bg-blue-500/25 text-blue-300 border-blue-400/40" },
  active:       { label: "ACTIVE",       classes: "bg-green-500/25 text-green-300 border-green-400/40" },
  returned:     { label: "RETURNED",     classes: "bg-green-500/25 text-green-300 border-green-400/40" },
  active_today: { label: "PLAYING NOW",  classes: "bg-orange-500/25 text-orange-300 border-orange-400/40 animate-pulse" },
  reduced_load: { label: "REDUCED LOAD", classes: "bg-amber-500/25 text-amber-300 border-amber-400/40" },
  back_in_play: { label: "BACK IN PLAY", classes: "bg-cyan-500/25 text-cyan-300 border-cyan-400/40" },
  suspended:    { label: "SUSPENDED",    classes: "bg-purple-500/25 text-purple-300 border-purple-400/40" },
};

function HeadlineStatusBadge({ status }: { status: string }) {
  const cfg = HEADLINE_BADGE[status] ?? HEADLINE_BADGE.out;
  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-bold tracking-wide border ${cfg.classes}`}>
      {cfg.label}
    </span>
  );
}

function HeadlineTrackStar({ slug, name }: { slug: string; name: string }) {
  const [tracked, setTracked] = useState(() => isTrackedPlayer(slug));
  const [toast, setToast] = useState<string | null>(null);
  return (
    <>
      <button
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const nowTracked = toggleTrackedPlayer(slug);
          setTracked(nowTracked);
          setToast(nowTracked ? `Tracking ${name}` : `Removed ${name} from tracked players`);
          setTimeout(() => setToast(null), 2000);
        }}
        title={tracked ? "Tracking player" : "Track player"}
        className="absolute top-2 right-2 z-10 p-1 rounded-full transition-colors hover:bg-white/10"
      >
        {tracked
          ? <span className="text-amber-400 text-xs">&#9733;</span>
          : <span className="text-white/20 text-xs hover:text-white/50">&#9734;</span>
        }
      </button>
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-white/10 backdrop-blur-md border border-white/20 text-white text-sm px-4 py-2.5 rounded-xl shadow-lg animate-[fadeIn_0.2s_ease-out]" onClick={e => e.preventDefault()}>
          {toast}
        </div>
      )}
    </>
  );
}

function HeadlineStories({ injuries, statusChanges, showLeague, leagueSlug, teamFilter }: { injuries: InjuryRow[]; statusChanges: StatusChangeRow[]; showLeague?: boolean; leagueSlug?: string; teamFilter?: string | null }) {
  const [headlineFilter, setHeadlineFilter] = useState<"all" | "injured" | "returned">("all");
  const filteredChanges = (statusChanges ?? [])
    .filter((c) => !leagueSlug || c.league_slug === leagueSlug)
    .filter((c) => !teamFilter || c.team_name === teamFilter);
  const allCards = buildHeadlineCards(injuries, filteredChanges, teamFilter ? 5 : 8);

  // Sort: injuries first, then returns, then status changes
  const TYPE_ORDER: Record<string, number> = { injury: 0, status_change: 1, return: 2 };
  const sortedCards = [...allCards].sort((a, b) => (TYPE_ORDER[a.type] ?? 1) - (TYPE_ORDER[b.type] ?? 1));

  // Apply headline filter
  const cards = headlineFilter === "all" ? sortedCards
    : headlineFilter === "injured" ? sortedCards.filter((c) => c.type === "injury" || c.type === "status_change")
    : sortedCards.filter((c) => c.type === "return");

  if (allCards.length === 0) return null;

  return (
    <div id="section-headlines" className="scroll-mt-32 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-xl">{"\uD83D\uDD25"}</span>
        <h3 className="text-base font-bold uppercase tracking-wide text-white/80">
          Headline Stories
        </h3>
        <span className="text-xs text-white/40">({cards.length})</span>
        <span className="ml-auto text-white/25 text-xs animate-pulse">scroll &rarr;</span>
      </div>
      {/* Headline filter buttons */}
      <div className="flex items-center gap-1.5">
        {([["all", "All"], ["injured", "Injured"], ["returned", "Returned"]] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setHeadlineFilter(key)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
              headlineFilter === key
                ? "bg-cyan-500/15 text-cyan-400 border border-cyan-500/30"
                : "bg-white/5 text-white/40 hover:text-white/60 border border-transparent"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {cards.length === 0 ? (
        <p className="text-xs text-white/30 py-4 text-center">No {headlineFilter} headlines right now</p>
      ) : (
      <div className="relative">
        {/* Left/right edge fades */}
        <div className="pointer-events-none absolute left-0 top-0 bottom-0 w-6 z-10 bg-gradient-to-r from-[#0A0E1A] to-transparent" />
        <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-6 z-10 bg-gradient-to-l from-[#0A0E1A] to-transparent" />
      <div className="flex gap-3 overflow-x-auto pb-2 px-1 snap-x snap-mandatory headline-carousel">
        {cards.map((card) => {
          const typeLabel = HEADLINE_TYPE_LABEL[card.type];
          return (
            <Link
              key={card.key}
              to={`/player/${card.player_slug || card.player_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`}
              onClick={() => trackHeadlineClick(card.player_slug || card.player_name, card.league_slug ?? "", card.status ?? "")}
              className="shrink-0 w-[170px] sm:w-[190px] rounded-xl p-3.5 snap-start transition-all duration-[180ms] ease-out block headline-card relative"
              style={{
                border: `1px solid ${typeLabel.cardBorder}`,
                backgroundColor: typeLabel.cardTint,
                boxShadow: "0 6px 18px rgba(0,0,0,0.35)",
                ["--hover-border" as string]: typeLabel.cardBorderHover,
              }}
            >
              {/* Track star */}
              <HeadlineTrackStar
                slug={card.player_slug || card.player_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}
                name={card.player_name}
              />
              {/* Type label */}
              <div className="mb-2">
                <span className={`text-[10px] font-bold px-2.5 py-1 rounded ${typeLabel.color}`}>
                  {typeLabel.text}
                </span>
              </div>

              {/* Headshot */}
              <div className="flex justify-center mb-2">
                <PlayerAvatar src={card.headshot_url} name={card.player_name} size={64} className="rounded-full" />
              </div>

              {/* Name */}
              <p className="text-[15px] font-semibold text-white text-center truncate">{card.player_name}</p>

              {/* Team / League */}
              <div className="flex items-center justify-center gap-1.5 mt-1">
                {card.team_name && (
                  <span className="text-xs text-white/45 truncate max-w-[100px]">{card.team_name}</span>
                )}
                {showLeague && card.league_slug && (
                  <span className="flex items-center gap-1 text-xs text-white/35">
                    <span className={`h-1.5 w-1.5 rounded-full ${LEAGUE_DOT[card.league_slug] ?? "bg-white/30"}`} />
                    {LEAGUE_LABELS[card.league_slug] ?? ""}
                  </span>
                )}
              </div>

              {/* Summary */}
              <p className="text-xs text-white/55 text-center mt-2 line-clamp-2 leading-relaxed">{card.summary}</p>

              {/* Impact badge */}
              <div className="flex justify-center mt-2.5">
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${card.impactColor}`}>
                  {card.impact}
                </span>
              </div>

              {/* Status + Time */}
              <div className="flex items-center justify-between mt-2.5">
                <HeadlineStatusBadge status={card.status} />
                <span className="text-[10px] text-white/30">{card.timeAgo}</span>
              </div>

              {/* CTA */}
              <p className="headline-cta text-[10px] text-white/30 text-right mt-2 transition-colors duration-[180ms]">
                {typeLabel.cta}
              </p>
            </Link>
          );
        })}
      </div>
      </div>
      )}
    </div>
  );
}

/* -- Team filter dropdown -- */
function TeamDropdown({
  teams, counts, teamFilter, setTeamFilter, totalLabel = "All Teams",
}: {
  teams: string[];
  counts: InjuryRow[];
  teamFilter: string | null;
  setTeamFilter: (t: string | null) => void;
  totalLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  if (teams.length <= 1) return null;

  const selectedLabel = teamFilter ?? totalLabel;
  const selectedCount = teamFilter
    ? counts.filter((i) => i.team_name === teamFilter).length
    : counts.length;

  return (
    <div ref={ref} className="relative inline-block">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-4 py-2 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 transition-colors text-sm font-medium"
      >
        <span className="text-white/50">Team:</span>
        <span className="text-white font-semibold">{selectedLabel}</span>
        <span className="text-white/40">({selectedCount})</span>
        <svg className={`w-4 h-4 text-white/40 transition-transform ${open ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute z-40 mt-1 w-64 max-h-72 overflow-y-auto rounded-lg border border-white/15 bg-[#0F1320] shadow-xl">
          <button
            onClick={() => { setTeamFilter(null); setOpen(false); }}
            className={`w-full text-left px-4 py-2.5 text-sm hover:bg-white/10 transition-colors flex justify-between items-center ${
              teamFilter === null ? "text-[#1C7CFF] font-semibold bg-white/5" : "text-white/70"
            }`}
          >
            <span>{totalLabel}</span>
            <span className="text-white/40 text-xs">{counts.length}</span>
          </button>
          {teams.map((team) => {
            const count = counts.filter((i) => i.team_name === team).length;
            return (
              <button
                key={team}
                onClick={() => { setTeamFilter(team); setOpen(false); }}
                className={`w-full text-left px-4 py-2.5 text-sm hover:bg-white/10 transition-colors flex justify-between items-center ${
                  teamFilter === team ? "text-[#1C7CFF] font-semibold bg-white/5" : "text-white/70"
                }`}
              >
                <span>{team}</span>
                <span className="text-white/40 text-xs">{count}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* -- Unified injuries view: always calls the same hooks regardless of active tab.
 * Merges TopPlayersView (was 1 hook) and LeagueInjuries (was 3 hooks) so React
 * never sees a different hook count at this position in the tree. -- */
function InjuriesView({ activeTab }: { activeTab: string }) {
  // All hooks called unconditionally every render — React rules of hooks.
  const { data: topInjuries = [], isLoading: topLoading } = useTopPlayerInjuries();
  const { data: leagueInjuries = [], isLoading: leagueLoading } = useCurrentInjuries(
    activeTab === "top" ? "" : activeTab,
  );
  const { data: statusChanges = [], isLoading: changesLoading } = useStatusChanges(50);
  const [teamFilter, setTeamFilter] = useState<string | null>(null);
  useEffect(() => { setTeamFilter(null); }, [activeTab]);

  const isTop = activeTab === "top";
  const injuries = isTop ? topInjuries : leagueInjuries;
  const isLoading = isTop ? topLoading : leagueLoading;

  if (isLoading) return <LoadingSkeleton />;
  if (injuries.length === 0) {
    return (
      <EmptyBox
        message={
          isTop
            ? "No top player injury data yet."
            : `No injury data for ${LEAGUE_LABELS[activeTab] ?? activeTab.toUpperCase()}.`
        }
      />
    );
  }

  const filtered = !isTop && teamFilter
    ? injuries.filter((i) => i.team_name === teamFilter)
    : injuries;

  const grouped: Record<Section, InjuryRow[]> = { out: [], active: [], reduced: [], back: [] };
  for (const inj of filtered) {
    const section = classifySection(inj);
    if (section) grouped[section].push(inj);
  }

  if (isTop) {
    return (
      <div className="space-y-6">
        <HeadlineStories injuries={injuries} statusChanges={statusChanges} showLeague />
        <RecoveryInsights />
        <ReturningPlayerPropOpportunities />
        <RecoveryCurvePreview />
        <StatusUpdatesBlock statusChanges={statusChanges} isLoadingChanges={changesLoading} showLeague />
        {SECTIONS.map((sec) => (
          <SectionBlock key={sec.key} section={sec} injuries={grouped[sec.key]} showLeague />
        ))}
      </div>
    );
  }

  // Per-league view
  const teams = Array.from(
    new Set(injuries.map((i) => i.team_name ?? "").filter((t) => t && t !== "Unknown")),
  ).sort();

  return (
    <div className="space-y-10">
      <TeamDropdown teams={teams} counts={injuries} teamFilter={teamFilter} setTeamFilter={setTeamFilter} />
      <JumpNav grouped={grouped} />
      <HeadlineStories injuries={filtered} statusChanges={statusChanges} leagueSlug={activeTab} teamFilter={teamFilter} />
      <RecoveryInsights />
      <ReturningPlayerPropOpportunities />
      <RecoveryCurvePreview />
      <StatusUpdatesBlock statusChanges={statusChanges} isLoadingChanges={changesLoading} leagueSlug={activeTab} teamFilter={teamFilter} />
      {SECTIONS.map((sec) => (
        <SectionBlock key={sec.key} section={sec} injuries={grouped[sec.key]} defaultCollapsed={sec.key === "reduced" || sec.key === "active"} />
      ))}
    </div>
  );
}

/* -- Recovery Insights teaser -- */
const STAT_UNITS: Record<string, string> = {
  stat_pts: "PTS", stat_reb: "REB", stat_ast: "AST",
  stat_pass_yds: "Pass Yds", stat_rush_yds: "Rush Yds", stat_rec_yds: "Rec Yds",
  stat_goals: "Goals", stat_assists: "Assists", stat_sog: "SOG",
  stat_h: "Hits", stat_hr: "HR", stat_rbi: "RBI",
  stat_sv: "Saves", stat_ga: "GA",
};

function RecoveryInsights() {
  const { data: curves = [], isLoading } = usePerformanceCurves();

  const insights = useMemo(() => {
    if (curves.length === 0) return [];

    const reliable = curves.filter(
      (c) => isRealInjury(c.injury_type_slug, c.injury_type)
        && c.sample_size >= 30
        && (c.median_pct_recent[0] == null || c.median_pct_recent[0] > 0)
        && !c.position // all-position curves only
    );

    // Compute biggest stat impact at G3 (index 2) per curve
    type Insight = {
      curve: PerformanceCurve;
      statLabel: string;
      diff: number;
      gameLabel: string;
    };

    // Primary stat per league — most representative for discovery
    const PRIMARY: Record<string, { key: string; label: string }> = {
      nba: { key: "stat_pts", label: "PTS" },
      nfl: { key: "stat_rush_yds", label: "Rush Yds" },
      mlb: { key: "stat_h", label: "Hits" },
      nhl: { key: "stat_goals", label: "Goals" },
      "premier-league": { key: "stat_goals", label: "Goals" },
    };

    const all: Insight[] = [];
    for (const c of reliable) {
      const baselines = c.stat_baselines ?? {};
      const medians = c.stat_median_pct ?? {};

      // Try primary stat first
      const ps = PRIMARY[c.league_slug];
      if (ps) {
        const base = baselines[ps.key];
        const pct = (medians[ps.key] as number[] | undefined)?.[2];
        if (base && base > 0 && pct != null) {
          all.push({ curve: c, statLabel: ps.label, diff: base * (pct - 1.0), gameLabel: "G3" });
          continue;
        }
      }

      // Fallback: pick stat with largest % deviation (not raw absolute)
      let best: Insight & { pctDev: number } | null = null;
      for (const [sk, base] of Object.entries(baselines)) {
        if (sk === "composite" || !base || base === 0) continue;
        const pct = (medians[sk] as number[] | undefined)?.[2];
        if (pct == null) continue;
        const pctDev = Math.abs(pct - 1.0);
        const diff = base * (pct - 1.0);
        if (!best || pctDev > best.pctDev) {
          best = {
            curve: c,
            statLabel: STAT_UNITS[sk] ?? STAT_LABELS[sk] ?? sk.replace("stat_", ""),
            diff,
            gameLabel: "G3",
            pctDev,
          };
        }
      }
      if (best) all.push({ curve: best.curve, statLabel: best.statLabel, diff: best.diff, gameLabel: best.gameLabel });
    }

    // Boost well-known injury types so they surface first
    const BOOSTED = ["acl", "achilles", "tommy-john", "ucl", "knee", "hamstring", "calf", "shoulder", "concussion", "ankle", "mcl", "meniscus", "hip", "elbow", "groin", "quad"];
    const boostScore = (slug: string) => BOOSTED.some((b) => slug.includes(b)) ? 1.5 : 1.0;

    // Sort by boosted absolute impact, take top per league (max 6)
    all.sort((a, b) => (Math.abs(b.diff) * boostScore(b.curve.injury_type_slug)) - (Math.abs(a.diff) * boostScore(a.curve.injury_type_slug)));
    const seen = new Set<string>();
    const final: Insight[] = [];
    for (const ins of all) {
      if (final.length >= 6) break;
      const lk = ins.curve.league_slug;
      // Allow max 2 per league
      const count = final.filter((f) => f.curve.league_slug === lk).length;
      if (count >= 2) continue;
      const key = `${ins.curve.injury_type_slug}|${lk}`;
      if (seen.has(key)) continue;
      seen.add(key);
      final.push(ins);
    }
    return final;
  }, [curves]);

  if (isLoading || insights.length === 0) return null;

  return (
    <section>
      <div className="rounded-xl border border-white/8 bg-gradient-to-br from-white/[0.02] to-transparent p-4 sm:p-5">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-[#1C7CFF]/70">Recovery Insights</span>
          <Link
            to="/performance-curves"
            className="text-[11px] text-white/30 hover:text-white/50 transition-colors"
          >
            Explore all curves &rarr;
          </Link>
        </div>
        <p className="text-[11px] text-white/25 mb-3">Interesting injury recovery trends from historical data</p>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {insights.map((ins) => {
            const lc = leagueColor(ins.curve.league_slug);
            const isNeg = ins.diff < 0;
            return (
              <Link
                key={`${ins.curve.injury_type_slug}-${ins.curve.league_slug}`}
                to={`/performance-curves?league=${ins.curve.league_slug}&injury=${ins.curve.injury_type_slug}`}
                className="group relative rounded-lg bg-white/[0.03] border border-white/6 px-3 py-2.5 hover:bg-white/[0.06] hover:border-white/12 transition-all overflow-hidden"
              >
                {/* Subtle left accent */}
                <div className="absolute left-0 top-0 bottom-0 w-[2px] rounded-l-lg" style={{ backgroundColor: `${lc}55` }} />

                <div className="flex items-center gap-1.5 mb-1">
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded" style={{ color: lc, backgroundColor: `${lc}15` }}>
                    {LEAGUE_LABELS[ins.curve.league_slug]}
                  </span>
                </div>
                <p className="text-xs font-medium text-white/80 truncate leading-tight">{ins.curve.injury_type}</p>
                <div className="flex items-baseline gap-1 mt-1">
                  <span className={`text-sm font-bold tabular-nums ${isNeg ? "text-red-400" : "text-green-400"}`}>
                    {isNeg ? "" : "+"}{ins.diff.toFixed(1)}
                  </span>
                  <span className="text-[10px] text-white/30">{ins.statLabel} by {ins.gameLabel}</span>
                </div>
              </Link>
            );
          })}
        </div>

        <div className="flex items-center gap-4 mt-3 pt-2.5 border-t border-white/5">
          <Link to="/recovery-stats" className="text-[11px] text-white/30 hover:text-white/50 transition-colors">
            Recovery Stats &rarr;
          </Link>
          <Link to="/performance-curves" className="text-[11px] text-white/30 hover:text-white/50 transition-colors">
            Performance Curves &rarr;
          </Link>
        </div>
      </div>
    </section>
  );
}

/* -- Recovery Curve Preview -- */
const PREVIEW_PRIMARY: Record<string, { key: string; label: string }> = {
  nba: { key: "stat_pts", label: "PTS" },
  nfl: { key: "stat_rush_yds", label: "Rush Yds" },
  mlb: { key: "stat_h", label: "Hits" },
  nhl: { key: "stat_goals", label: "Goals" },
  "premier-league": { key: "stat_goals", label: "Goals" },
};

function CurveSparkline({ data, color = "#1C7CFF", animate = false }: { data: (number | null)[]; color?: string; animate?: boolean }) {
  const pts = data.slice(0, 10).map((v, i) => ({ x: i, y: v ?? 0 }));
  if (pts.length < 2) return null;
  const w = 200, h = 72, padX = 8, padY = 6;
  const minY = Math.min(...pts.map((p) => p.y), 0.5);
  const maxY = Math.max(...pts.map((p) => p.y), 1.1);
  const sx = (i: number) => padX + (i / (pts.length - 1)) * (w - padX * 2);
  const sy = (v: number) => h - padY - ((v - minY) / (maxY - minY)) * (h - padY * 2);
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");
  const baseY = sy(1.0);
  // Area fill path
  const areaPath = `${line} L${sx(pts[pts.length - 1].x).toFixed(1)},${(h - padY).toFixed(1)} L${sx(0).toFixed(1)},${(h - padY).toFixed(1)} Z`;
  // Rough path length for animation
  const pathLen = pts.reduce((sum, p, i) => {
    if (i === 0) return 0;
    const dx = sx(p.x) - sx(pts[i - 1].x);
    const dy = sy(p.y) - sy(pts[i - 1].y);
    return sum + Math.sqrt(dx * dx + dy * dy);
  }, 0);

  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet" className="block">
      {/* baseline */}
      <line x1={padX} y1={baseY} x2={w - padX} y2={baseY} stroke="rgba(255,255,255,0.06)" strokeDasharray="4 4" />
      <text x={w - padX} y={baseY - 3} fill="rgba(255,255,255,0.12)" fontSize="7" textAnchor="end">100%</text>
      {/* game labels */}
      <text x={sx(0)} y={h - 0} fill="rgba(255,255,255,0.15)" fontSize="6.5" textAnchor="middle">G1</text>
      <text x={sx(4)} y={h - 0} fill="rgba(255,255,255,0.15)" fontSize="6.5" textAnchor="middle">G5</text>
      <text x={sx(9)} y={h - 0} fill="rgba(255,255,255,0.15)" fontSize="6.5" textAnchor="middle">G10</text>
      {/* area fill */}
      <path d={areaPath} fill={`${color}08`} />
      {/* curve line */}
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={animate ? {
          strokeDasharray: pathLen,
          strokeDashoffset: pathLen,
          animation: "curve-draw 0.8s ease-out forwards",
        } : undefined}
      />
      {/* endpoint dot */}
      <circle cx={sx(pts[pts.length - 1].x)} cy={sy(pts[pts.length - 1].y)} r={2.5} fill={color} opacity={animate ? 0 : 1} style={animate ? { animation: "curve-dot 0.3s ease-out 0.7s forwards" } : undefined} />
      {/* start dot */}
      <circle cx={sx(0)} cy={sy(pts[0].y)} r={1.5} fill={color} opacity={0.5} />
    </svg>
  );
}

function RecoveryCurvePreview() {
  const { data: curves = [], isLoading } = usePerformanceCurves();

  const previewCards = useMemo(() => {
    if (curves.length === 0) return [];

    const reliable = curves.filter(
      (c) => isRealInjury(c.injury_type_slug, c.injury_type)
        && c.sample_size >= 30
        && !c.position
        && c.median_pct_recent[0] != null
        && c.median_pct_recent[0] > 0
    );

    // Pick well-known injuries across different leagues
    const PREFERRED = [
      { slug: "knee", league: "nfl" },
      { slug: "acl", league: "nba" },
      { slug: "hamstring", league: "premier-league" },
      { slug: "concussion", league: "nhl" },
      { slug: "achilles", league: "nba" },
      { slug: "shoulder", league: "mlb" },
      { slug: "ankle", league: "nfl" },
      { slug: "calf", league: "nba" },
    ];

    const picked: PerformanceCurve[] = [];
    const usedLeagues = new Set<string>();

    for (const pref of PREFERRED) {
      if (picked.length >= 4) break;
      if (usedLeagues.has(pref.league)) continue;
      const match = reliable.find(
        (c) => c.injury_type_slug.includes(pref.slug) && c.league_slug === pref.league
      );
      if (match) {
        picked.push(match);
        usedLeagues.add(pref.league);
      }
    }

    // Fill remaining slots if needed
    if (picked.length < 4) {
      for (const c of reliable) {
        if (picked.length >= 4) break;
        if (picked.some((p) => p.curve_id === c.curve_id)) continue;
        if (usedLeagues.has(c.league_slug)) continue;
        picked.push(c);
        usedLeagues.add(c.league_slug);
      }
    }

    return picked;
  }, [curves]);

  // Compute stat impact for a curve at a game index
  const getStatImpact = useCallback((c: PerformanceCurve, gIdx: number): { label: string; diff: number } | null => {
    const baselines = c.stat_baselines ?? {};
    const medians = c.stat_median_pct ?? {};
    const ps = PREVIEW_PRIMARY[c.league_slug];
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
      const diff = base * (pct - 1.0);
      if (!best || pctDev > best.pctDev) {
        best = { label: STAT_UNITS[sk] ?? STAT_LABELS[sk] ?? sk.replace("stat_", ""), diff, pctDev };
      }
    }
    return best ? { label: best.label, diff: best.diff } : null;
  }, []);

  if (isLoading || previewCards.length === 0) return null;

  return (
    <section>
      {/* CSS keyframes for curve draw animation */}
      <style>{`
        @keyframes curve-draw { to { stroke-dashoffset: 0; } }
        @keyframes curve-dot { to { opacity: 1; } }
      `}</style>
      <div className="rounded-xl border border-white/8 bg-gradient-to-br from-[#1C7CFF]/[0.03] to-transparent p-4 sm:p-5">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-[#3DFF8F]/70">Recovery Curve Preview</span>
          <Link
            to="/performance-curves"
            className="text-[11px] text-white/30 hover:text-white/50 transition-colors"
          >
            View all curves &rarr;
          </Link>
        </div>
        <p className="text-[11px] text-white/25 mb-3">Explore how player performance changes after returning from injury</p>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          {previewCards.map((c) => {
            const lc = leagueColor(c.league_slug);
            const g10 = c.median_pct_recent[9] != null ? Math.round(c.median_pct_recent[9] * 100) : null;
            const recovered = g10 != null && g10 >= 95;

            // Stat impacts at G1, G3, G5
            const impactG1 = getStatImpact(c, 0);
            const impactG3 = getStatImpact(c, 2);
            const impactG5 = getStatImpact(c, 4);
            // Headline: G3 impact (middle ground between return and recovery)
            const headline = impactG3 ?? impactG1;
            const fmtDiff = (d: number) => `${d >= 0 ? "+" : ""}${d.toFixed(1)}`;

            return (
              <Link
                key={c.curve_id}
                to={`/performance-curves?league=${c.league_slug}&injury=${c.injury_type_slug}`}
                className="group relative rounded-lg bg-white/[0.03] border border-white/6 px-3 py-3 hover:bg-white/[0.07] hover:border-white/15 hover:-translate-y-1 hover:shadow-lg hover:shadow-black/25 transition-all duration-200 overflow-hidden"
              >
                {/* Left accent */}
                <div className="absolute left-0 top-0 bottom-0 w-[2px] rounded-l-lg transition-all group-hover:w-[3px]" style={{ backgroundColor: `${lc}55` }} />

                {/* Header: league + name */}
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded" style={{ color: lc, backgroundColor: `${lc}15` }}>
                    {LEAGUE_LABELS[c.league_slug]}
                  </span>
                </div>
                <p className="text-xs font-semibold text-white/85 truncate mb-1.5">{c.injury_type}</p>

                {/* Stat impact headline */}
                {headline && (
                  <div className="mb-2">
                    <div className="flex items-baseline gap-1">
                      <span className={`text-lg font-bold tabular-nums ${headline.diff >= 0 ? "text-green-400" : "text-red-400"}`}>
                        {fmtDiff(headline.diff)}
                      </span>
                      <span className="text-[10px] text-white/35">{headline.label}</span>
                    </div>
                    <p className="text-[9px] text-white/20">at Game 3</p>
                  </div>
                )}

                {/* Large curve — visual centerpiece */}
                <div className="mb-2 -mx-1 group-hover:opacity-100 opacity-80 transition-opacity">
                  <div className="hidden group-hover:block">
                    <CurveSparkline data={c.median_pct_recent} color={lc} animate />
                  </div>
                  <div className="block group-hover:hidden">
                    <CurveSparkline data={c.median_pct_recent} color={lc} />
                  </div>
                </div>

                {/* Mini stat breakdown */}
                <div className="grid grid-cols-3 gap-1 mb-2">
                  {([["G1", impactG1], ["G3", impactG3], ["G5", impactG5]] as [string, { label: string; diff: number } | null][]).map(([label, imp]) => (
                    <div key={label} className="text-center">
                      <p className="text-[9px] text-white/20">{label}</p>
                      <p className={`text-[11px] font-bold tabular-nums ${imp == null ? "text-white/20" : imp.diff >= 0 ? "text-green-400/80" : "text-red-400/80"}`}>
                        {imp != null ? fmtDiff(imp.diff) : "—"}
                      </p>
                    </div>
                  ))}
                </div>

                {/* Bottom: baseline % + explore link */}
                <div className="flex items-center justify-between pt-1.5 border-t border-white/5">
                  <span className={`text-[10px] ${recovered ? "text-green-400/60" : "text-amber-400/60"}`}>
                    {g10 != null ? `${g10}% of baseline by G10` : "—"}
                  </span>
                  <span className="text-[10px] text-white/20 group-hover:text-[#1C7CFF]/70 transition-colors">
                    Explore &rarr;
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* -- Returning Player Prop Opportunities -- */
const PROP_MARKET_LABELS: Record<string, string> = {
  player_points: "PTS", player_rebounds: "REB", player_assists: "AST",
  player_threes: "3PT", player_pass_yds: "Pass Yds", player_rush_yds: "Rush Yds",
  player_reception_yds: "Rec Yds", player_goals: "Goals", player_shots_on_goal: "SOG",
  player_shots: "Shots", batter_hits: "Hits", batter_total_bases: "TB", batter_rbis: "RBI",
};

const PROP_PRIMARY: Record<string, { key: string; label: string }> = {
  nba: { key: "stat_pts", label: "PTS" },
  nfl: { key: "stat_rush_yds", label: "Rush Yds" },
  mlb: { key: "stat_h", label: "Hits" },
  nhl: { key: "stat_goals", label: "Goals" },
  "premier-league": { key: "stat_goals", label: "Goals" },
};

interface PropOpportunity {
  playerId: string;
  playerName: string;
  playerSlug: string;
  teamName: string;
  leagueSlug: string;
  headshotUrl: string | null;
  injuryType: string;
  gamesBack: number;
  propMarket: string;
  propLine: number | null;
  overOdds: string | null;
  underOdds: string | null;
  baseline: number | null;
  recentAvg: number | null;
  preInjuryMinutes: number | null;
  currentMinutes: number | null;
  curveImpactG3: { label: string; diff: number } | null;
}

function useReturningPlayerProps() {
  const today = new Date().toISOString().slice(0, 10);
  return useQuery<PropOpportunity[]>({
    queryKey: ["bip-home-prop-opps", today],
    queryFn: async () => {
      // 1. Today's props (include odds for EV model)
      const { data: props } = await supabase
        .from("back_in_play_player_props")
        .select("player_id, player_name, market, line, over_price, under_price, source")
        .eq("game_date", today);
      if (!props?.length) return [];

      // Group by player, keep first prop per player (priority market)
      const byPlayer = new Map<string, typeof props[0]>();
      const priority = ["player_points", "player_goals", "batter_hits", "player_pass_yds", "player_rush_yds"];
      for (const p of props) {
        if (!p.player_id) continue;
        const existing = byPlayer.get(p.player_id);
        if (!existing || priority.indexOf(p.market) < priority.indexOf(existing.market)) {
          byPlayer.set(p.player_id, p);
        }
      }

      const playerIds = Array.from(byPlayer.keys());
      if (playerIds.length === 0) return [];

      // 2. Players + injuries in parallel
      const [playersRes, ...injChunks] = await Promise.all([
        supabase
          .from("back_in_play_players")
          .select("player_id, player_name, slug, position, headshot_url, espn_id, is_star, is_starter, team:back_in_play_teams(team_name), league:back_in_play_leagues!back_in_play_players_league_id_fkey(slug)")
          .in("player_id", playerIds.slice(0, 500)),
        ...Array.from({ length: Math.ceil(playerIds.length / 200) }, (_, i) =>
          supabase
            .from("back_in_play_injuries")
            .select("player_id, status, injury_type, date_injured")
            .in("player_id", playerIds.slice(i * 200, (i + 1) * 200))
            .order("date_injured", { ascending: false })
        ),
      ]);

      const playerMap = new Map<string, any>();
      for (const p of playersRes.data ?? []) playerMap.set(p.player_id, p);

      const injuryMap = new Map<string, any>();
      for (const chunk of injChunks) {
        for (const inj of chunk.data ?? []) {
          if (!injuryMap.has(inj.player_id)) injuryMap.set(inj.player_id, inj);
        }
      }

      // 3. Game log counts for recently returned
      const returned: { pid: string; injDate: string }[] = [];
      for (const [pid] of byPlayer) {
        const inj = injuryMap.get(pid);
        if (inj?.date_injured) returned.push({ pid, injDate: inj.date_injured });
      }
      if (returned.length === 0) return [];

      // Fetch game logs with stats for EV model (baseline + recent)
      const STAT_COLS = "player_id, game_date, minutes, stat_pts, stat_reb, stat_ast, stat_rush_yds, stat_pass_yds, stat_rec_yds, stat_goals, stat_sog, stat_h, stat_rbi";
      const returnedPids = returned.map((r) => r.pid);
      const LOG_CHUNK = 20;
      const logChunks = await Promise.all(
        Array.from({ length: Math.ceil(Math.min(returnedPids.length, 300) / LOG_CHUNK) }, (_, i) =>
          supabase
            .from("back_in_play_player_game_logs")
            .select(STAT_COLS)
            .in("player_id", returnedPids.slice(i * LOG_CHUNK, (i + 1) * LOG_CHUNK))
            .gte("game_date", new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10))
            .order("game_date", { ascending: false })
            .limit(1000)
        )
      );
      const logRes = { data: logChunks.flatMap((c) => c.data ?? []) };

      // Map for game log stat key by market
      const MARKET_STAT: Record<string, string> = {
        player_points: "stat_pts", player_rebounds: "stat_reb", player_assists: "stat_ast",
        player_pass_yds: "stat_pass_yds", player_rush_yds: "stat_rush_yds",
        player_reception_yds: "stat_rec_yds", player_goals: "stat_goals",
        player_shots_on_goal: "stat_sog", batter_hits: "stat_h", batter_rbis: "stat_rbi",
      };

      const gamesBackMap = new Map<string, number>();
      const baselineMap = new Map<string, { stat: number; minutes: number }>();
      const recentMap = new Map<string, { stat: number; minutes: number }>();

      for (const r of returned) {
        const allGames = (logRes.data ?? []).filter((g: any) => g.player_id === r.pid);
        const postGames = allGames.filter((g: any) => g.game_date > r.injDate);
        const preGames = allGames.filter((g: any) => g.game_date <= r.injDate);
        const count = postGames.length;
        if (count > 0 && count <= 10) {
          gamesBackMap.set(r.pid, count);

          // Get the prop market for this player to know which stat to average
          const prop = byPlayer.get(r.pid);
          const statKey = prop ? MARKET_STAT[prop.market] : null;
          if (statKey) {
            // Median per-minute rate × median minutes (robust to outliers)
            // Dynamic threshold: 25% of median minutes filters injury exits
            const allWithMin = [...preGames, ...postGames].filter((g: any) => g.minutes > 0);
            const typicalMin = allWithMin.length > 0 ? arrMedian(allWithMin.map((g: any) => g.minutes)) : 0;
            const minThresh = typicalMin * 0.25;

            const preReal = preGames.filter((g: any) => g.minutes >= minThresh).slice(0, 10);
            if (preReal.length > 0) {
              const rates: number[] = [];
              const mins: number[] = [];
              for (const g of preReal) {
                if (g[statKey] != null) rates.push(g[statKey] / g.minutes);
                mins.push(g.minutes);
              }
              if (rates.length > 0) {
                const medRate = arrMedian(rates);
                const medMin = arrMedian(mins);
                baselineMap.set(r.pid, { stat: medRate * medMin, minutes: medMin });
              }
            }
            // Recent avg since return (same median approach)
            const postReal = postGames.filter((g: any) => g.minutes >= minThresh);
            if (postReal.length > 0) {
              const rates: number[] = [];
              const mins: number[] = [];
              for (const g of postReal) {
                if (g[statKey] != null) rates.push(g[statKey] / g.minutes);
                mins.push(g.minutes);
              }
              if (rates.length > 0) {
                const medRate = arrMedian(rates);
                const medMin = arrMedian(mins);
                recentMap.set(r.pid, { stat: medRate * medMin, minutes: medMin });
              }
            }
          }
        }
      }

      // 4. Build results
      const result: PropOpportunity[] = [];
      for (const [pid, prop] of byPlayer) {
        const gamesBack = gamesBackMap.get(pid);
        if (!gamesBack) continue; // only recently returned
        const player = playerMap.get(pid);
        if (!player) continue;
        const inj = injuryMap.get(pid);
        if (!inj?.injury_type) continue;

        const bl = baselineMap.get(pid);
        const rc = recentMap.get(pid);
        result.push({
          playerId: pid,
          playerName: player.player_name,
          playerSlug: player.slug ?? "",
          teamName: (player as any).team?.team_name ?? "",
          leagueSlug: (player as any).league?.slug ?? "",
          headshotUrl: player.headshot_url ?? (player.espn_id ? `https://a.espncdn.com/i/headshots/nba/players/full/${player.espn_id}.png` : null),
          injuryType: inj.injury_type,
          gamesBack,
          propMarket: prop.market,
          propLine: prop.line,
          overOdds: prop.over_price ?? null,
          underOdds: prop.under_price ?? null,
          baseline: bl?.stat ?? null,
          recentAvg: rc?.stat ?? null,
          preInjuryMinutes: bl?.minutes ?? null,
          currentMinutes: rc?.minutes ?? null,
          curveImpactG3: null, // filled later from curve data
        });
      }

      // Sort: stars/starters first, then fewest games back
      result.sort((a, b) => {
        const pA = playerMap.get(a.playerId);
        const pB = playerMap.get(b.playerId);
        const starA = pA?.is_star ? 2 : pA?.is_starter ? 1 : 0;
        const starB = pB?.is_star ? 2 : pB?.is_starter ? 1 : 0;
        if (starA !== starB) return starB - starA;
        return a.gamesBack - b.gamesBack;
      });

      return result.slice(0, 8); // keep top 8 candidates
    },
    staleTime: 5 * 60 * 1000,
  });
}

function ReturningPlayerPropOpportunities() {
  const { data: opps = [], isLoading: oppsLoading } = useReturningPlayerProps();
  const { data: curves = [], isLoading: curvesLoading } = usePerformanceCurves();

  // Build curve lookup and enrich opportunities with curve data
  const enriched = useMemo(() => {
    if (opps.length === 0 || curves.length === 0) return [];

    const curveMap = new Map<string, PerformanceCurve>();
    for (const c of curves) {
      if (c.position) continue;
      const key = `${c.injury_type_slug}|${c.league_slug}`;
      const ex = curveMap.get(key);
      if (!ex || c.sample_size > ex.sample_size) curveMap.set(key, c);
    }

    const findCurve = (injuryType: string, leagueSlug: string): PerformanceCurve | null => {
      const slug = injuryType.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const exact = curveMap.get(`${slug}|${leagueSlug}`);
      if (exact) return exact;
      for (const [key, curve] of curveMap) {
        const [cSlug, cLeague] = key.split("|");
        if (cLeague === leagueSlug && (cSlug.includes(slug) || slug.includes(cSlug))) return curve;
      }
      return null;
    };

    const getImpact = (curve: PerformanceCurve, gIdx: number, leagueSlug: string): { label: string; diff: number; baseline: number; pctOfBaseline: number } | null => {
      const baselines = curve.stat_baselines ?? {};
      const medians = curve.stat_median_pct ?? {};
      const ps = PROP_PRIMARY[leagueSlug];
      if (ps) {
        const base = baselines[ps.key];
        const pct = (medians[ps.key] as number[] | undefined)?.[gIdx];
        if (base && base > 0 && pct != null) return { label: ps.label, diff: base * (pct - 1.0), baseline: base, pctOfBaseline: pct };
      }
      let best: { label: string; diff: number; baseline: number; pctOfBaseline: number; pctDev: number } | null = null;
      for (const [sk, base] of Object.entries(baselines)) {
        if (sk === "composite" || !base || base === 0) continue;
        const pct = (medians[sk] as number[] | undefined)?.[gIdx];
        if (pct == null) continue;
        const pctDev = Math.abs(pct - 1.0);
        if (!best || pctDev > best.pctDev) {
          best = { label: STAT_UNITS[sk] ?? STAT_LABELS[sk] ?? sk.replace("stat_", ""), diff: base * (pct - 1.0), baseline: base, pctOfBaseline: pct, pctDev };
        }
      }
      return best ? { label: best.label, diff: best.diff, baseline: best.baseline, pctOfBaseline: best.pctOfBaseline } : null;
    };

    // Market key → stat column for EV model
    const MKT_STAT: Record<string, string> = {
      player_points: "stat_pts", player_rebounds: "stat_reb", player_assists: "stat_ast",
      player_pass_yds: "stat_pass_yds", player_rush_yds: "stat_rush_yds",
      player_reception_yds: "stat_rec_yds", player_goals: "stat_goals",
      player_shots_on_goal: "stat_sog", batter_hits: "stat_h", batter_rbis: "stat_rbi",
    };

    return opps
      .map((opp) => {
        const curve = findCurve(opp.injuryType, opp.leagueSlug);
        const impact = curve ? getImpact(curve, 2, opp.leagueSlug) : null;
        const expected = impact ? impact.baseline * impact.pctOfBaseline : null;
        const edge = expected != null && opp.propLine != null ? expected - opp.propLine : null;

        // Compute EV if we have the data
        const statKey = MKT_STAT[opp.propMarket];
        let ev: EVResult | null = null;
        if (curve && statKey && opp.baseline != null && opp.baseline > 0 && opp.propLine != null && opp.gamesBack > 0) {
          ev = computeEV({
            baseline: opp.baseline,
            propLine: opp.propLine,
            overOdds: parseOdds(opp.overOdds),
            underOdds: parseOdds(opp.underOdds),
            gamesSinceReturn: opp.gamesBack,
            recentAvg: opp.recentAvg,
            curve,
            leagueSlug: opp.leagueSlug,
            statKey,
            preInjuryMinutes: opp.preInjuryMinutes,
            currentMinutes: opp.currentMinutes,
          });
        }

        return {
          ...opp,
          curveImpactG3: impact,
          curveN: curve?.sample_size ?? 0,
          expected,
          edge,
          ev,
        };
      })
      .filter((o) => o.curveImpactG3 != null)
      .sort((a, b) => {
        // Sort by best EV first, then by edge size
        const evA = a.ev?.bestEv ?? 0;
        const evB = b.ev?.bestEv ?? 0;
        if (evA !== 0 || evB !== 0) return evB - evA;
        return Math.abs(b.edge ?? 0) - Math.abs(a.edge ?? 0);
      })
      .slice(0, 4);
  }, [opps, curves]);

  if (oppsLoading || curvesLoading || enriched.length === 0) return null;

  return (
    <section>
      <div className="rounded-xl border border-white/8 bg-gradient-to-br from-orange-500/[0.03] to-transparent p-4 sm:p-5">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-orange-400/80">Returning Player Prop Opportunities</span>
            <Link
              to="/props"
              className="shrink-0 w-4 h-4 rounded-full border border-white/12 text-white/25 hover:text-white/50 hover:border-white/25 transition-colors text-[9px] font-semibold flex items-center justify-center"
              title="How the EV model works"
            >
              ?
            </Link>
          </div>
          <Link
            to="/props?sort=gap"
            className="text-[11px] text-white/30 hover:text-white/50 transition-colors"
          >
            See all edges &rarr;
          </Link>
        </div>
        <p className="text-[11px] text-white/25 mb-3">Injury-adjusted EV model estimates for returning players</p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {enriched.map((opp) => {
            const lc = leagueColor(opp.leagueSlug);
            const fmtD = (d: number) => `${d >= 0 ? "+" : ""}${d.toFixed(1)}`;
            const confidence = opp.curveN >= 500 ? "High" : opp.curveN >= 100 ? "Medium" : "Low";
            const confColor = opp.curveN >= 500 ? "text-green-400/60" : opp.curveN >= 100 ? "text-amber-400/60" : "text-red-400/60";
            const edgeDir = opp.edge != null && opp.edge !== 0 ? (opp.edge < 0 ? "UNDER" : "OVER") : null;
            const edgeColor = edgeDir === "UNDER" ? "text-red-400" : "text-green-400";
            const edgeBg = edgeDir === "UNDER" ? "bg-red-500/15 border-red-500/20" : "bg-green-500/15 border-green-500/20";

            return (
              <Link
                key={opp.playerId}
                to={`/props?player=${encodeURIComponent(opp.playerName)}`}
                className="group relative rounded-lg bg-white/[0.03] border border-white/6 px-3 py-3 hover:bg-white/[0.07] hover:border-white/15 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/20 transition-all duration-200 overflow-hidden"
              >
                {/* Left accent */}
                <div className="absolute left-0 top-0 bottom-0 w-[2px] rounded-l-lg" style={{ backgroundColor: `${lc}55` }} />

                {/* Player info + sample size */}
                <div className="flex items-center gap-2.5 mb-1.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-white/85 truncate">{opp.playerName}</p>
                    <div className="flex items-center gap-1 text-[10px] text-white/30 mt-0.5">
                      <span style={{ color: `${lc}aa` }}>{LEAGUE_LABELS[opp.leagueSlug]}</span>
                      <span>·</span>
                      <span>{opp.injuryType}</span>
                      <span>·</span>
                      <span>{opp.gamesBack} game{opp.gamesBack !== 1 ? "s" : ""} back</span>
                    </div>
                  </div>
                </div>

                {/* EV Model output */}
                {opp.ev && opp.ev.recommendation && opp.ev.bestEv != null ? (
                  <div className={`rounded-lg px-2.5 py-2 mb-2 border ${opp.ev.recommendation === "OVER" ? "bg-green-500/10 border-green-500/20" : "bg-red-500/10 border-red-500/20"}`}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[10px] text-white/40">
                        Model: <span className="text-white/60 font-medium tabular-nums">{opp.ev.expectedCombined.toFixed(1)}</span>
                      </span>
                      <span className={`text-xs font-bold tabular-nums ${opp.ev.recommendation === "OVER" ? "text-green-400" : "text-red-400"}`}>
                        EV {formatEV(opp.ev.bestEv)} · {opp.ev.recommendation}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-[9px] text-white/30">
                      <span>Line: <span className="text-white/50 font-medium">{opp.propLine} {PROP_MARKET_LABELS[opp.propMarket] ?? opp.propMarket}</span></span>
                      <span>P({opp.ev.recommendation.toLowerCase()}): <span className="text-white/50 font-medium tabular-nums">{Math.round((opp.ev.recommendation === "OVER" ? opp.ev.probOver : opp.ev.probUnder) * 100)}%</span></span>
                    </div>
                  </div>
                ) : opp.propLine != null ? (
                  <div className="flex items-center gap-2 mb-2">
                    <div className="flex-1 rounded bg-white/[0.03] border border-white/5 px-2.5 py-1.5 text-center">
                      <p className="text-[9px] text-white/25">Line</p>
                      <p className="text-sm font-bold text-white tabular-nums">{opp.propLine} <span className="text-[9px] text-white/30 font-normal">{PROP_MARKET_LABELS[opp.propMarket] ?? opp.propMarket}</span></p>
                    </div>
                    {opp.expected != null && (
                      <div className="flex-1 rounded bg-white/[0.03] border border-white/5 px-2.5 py-1.5 text-center">
                        <p className="text-[9px] text-white/25">Expected</p>
                        <p className="text-sm font-bold text-white/70 tabular-nums">{opp.expected.toFixed(1)}</p>
                      </div>
                    )}
                    {opp.edge != null && edgeDir && (
                      <div className={`flex-1 rounded border px-2.5 py-1.5 text-center ${edgeBg}`}>
                        <p className="text-[9px] text-white/30">Edge</p>
                        <p className={`text-sm font-bold tabular-nums ${edgeColor}`}>{fmtD(opp.edge)}</p>
                        <p className={`text-[9px] font-semibold ${edgeColor}`}>{edgeDir}</p>
                      </div>
                    )}
                  </div>
                ) : null}

                {/* Credibility + confidence */}
                <div className="flex items-center gap-2 mb-1.5 text-[9px]">
                  <span className="text-white/20">Based on {opp.curveN.toLocaleString()} historical injuries</span>
                  <span className={opp.ev ? (opp.ev.confidence === "High" ? "text-green-400/60" : opp.ev.confidence === "Medium" ? "text-amber-400/60" : "text-red-400/60") : confColor}>
                    {opp.ev ? opp.ev.confidence : confidence}
                  </span>
                </div>

                {/* Footer */}
                <div className="flex items-center justify-end">
                  <span className="text-[10px] text-white/20 group-hover:text-orange-400/60 transition-colors">
                    View props analysis &rarr;
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* -- Tab type: "top" landing or per-league -- */
type Tab = "top" | string;

export default function HomePage({ initialLeague }: { initialLeague?: string }) {
  const { leagueSlug: routeLeague } = useParams<{ leagueSlug: string }>();
  const { data: leagues = [] } = useLeagues();
  const [activeTab, setActiveTab] = useState<Tab>(routeLeague ?? initialLeague ?? "top");
  const [section, setSection] = useState<HomeSection>("injuries");

  const orderedSlugs = LEAGUE_ORDER.filter(
    (s) => leagues.length === 0 || leagues.some((l) => l.slug === s),
  );

  const year = new Date().getFullYear();
  const seoTitle = activeTab === "top"
    ? `Sports Injury Tracker (${year}) - Live Updates & Return Dates`
    : `${LEAGUE_LABELS[activeTab] ?? activeTab.toUpperCase()} Injuries (${year}) - Status & Return Dates`;
  const seoDesc = activeTab === "top"
    ? `Live injury updates for NBA, NFL, MLB, NHL, and EPL. Track player injuries, expected return dates, and status changes.`
    : `${LEAGUE_LABELS[activeTab] ?? activeTab.toUpperCase()} injury report - latest player injuries, return dates, and status updates.`;

  return (
    <div className="min-h-screen bg-[#0A0E1A] text-white overflow-x-hidden">
      <SEO title={seoTitle} description={seoDesc} path={activeTab === "top" ? "/" : `/league/${activeTab}`} />
      {/* Top Nav */}
      <nav className="sticky top-0 z-50 border-b border-white/10 bg-[#0A0E1A]/90 backdrop-blur-md">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <Link to="/" className="flex items-center gap-2 shrink-0">
            <span className="text-xl font-black tracking-tight">
              <span className="text-[#1C7CFF]">BACK</span>
              <span className="text-white/50 mx-1">IN</span>
              <span className="text-[#3DFF8F]">PLAY</span>
            </span>
            <span className="text-[9px] font-semibold tracking-wide rounded-full px-2 py-0.5 bg-[#1C7CFF]/10 text-[#1C7CFF]/60 border border-[#1C7CFF]/15">Early Access</span>
          </Link>

          <div className="hidden md:flex items-center gap-1 sm:gap-4 text-[13px] sm:text-[15px] font-medium overflow-x-auto">
            <Link to="/" className="px-2 py-1 text-[#1C7CFF] shrink-0">Home</Link>
            {(typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")) && (<>
              <Link to="/recovery-stats" className="px-2 py-1 text-white/50 hover:text-white transition-colors shrink-0">Recovery Stats</Link>
              <Link to="/returning-today" className="px-2 py-1 text-white/50 hover:text-white transition-colors shrink-0">Returning Today</Link>
            </>)}
            <Link to="/props" className="px-2 py-1 text-white/50 hover:text-white transition-colors shrink-0">Props</Link>
            <Link to="/performance-curves" className="px-2 py-1 text-white/50 hover:text-white transition-colors shrink-0">Performance Curves</Link>
            <Link to="/tracked-players" className="px-2 py-1 text-white/50 hover:text-white transition-colors shrink-0" title="Tracked Players">&#9733; <span className="hidden sm:inline">Tracked</span></Link>
          </div>

        </div>

        {/* League filter — scrollable chips */}
        <div className="relative max-w-5xl mx-auto">
          <div className="flex items-center gap-2 px-4 py-2.5 overflow-x-auto scrollbar-hide" style={{ scrollbarWidth: "none", WebkitOverflowScrolling: "touch" }}>
            {/* "Top Players" — distinct style */}
            <button
              onClick={() => setActiveTab("top")}
              className={`shrink-0 flex items-center gap-1.5 px-4 py-2 rounded-full text-[13px] font-semibold transition-all ${
                activeTab === "top"
                  ? "bg-amber-400/15 text-amber-300 border border-amber-400/40 shadow-[0_0_12px_rgba(251,191,36,0.15)]"
                  : "bg-white/[0.06] text-white/50 border border-white/10 hover:bg-white/[0.1] hover:text-white/70"
              }`}
            >
              <span className="text-sm">{"\uD83D\uDC51"}</span>
              Top Players
            </button>

            {/* Separator */}
            <span className="shrink-0 w-px h-5 bg-white/10" />

            {/* League chips */}
            {orderedSlugs.map((key) => (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className={`shrink-0 flex items-center gap-1.5 px-4 py-2 rounded-full text-[13px] font-semibold transition-all ${
                  activeTab === key
                    ? "border shadow-[0_0_12px_rgba(255,255,255,0.06)]"
                    : "bg-white/[0.06] text-white/50 border border-white/10 hover:bg-white/[0.1] hover:text-white/70"
                }`}
                style={activeTab === key ? {
                  backgroundColor: `${leagueColor(key)}18`,
                  borderColor: `${leagueColor(key)}55`,
                  color: leagueColor(key),
                } : undefined}
              >
                <span className="inline-block h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: leagueColor(key) }} />
                {LEAGUE_LABELS[key] ?? key.toUpperCase()}
              </button>
            ))}
            {/* Right spacer so last chip isn't flush with edge */}
            <span className="shrink-0 w-4" />
          </div>
          {/* Right gradient fade hint */}
          <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-10 bg-gradient-to-l from-[#0A0E1A] to-transparent md:hidden" />
        </div>

        {/* Section tabs — mobile only */}
        <div className="max-w-5xl mx-auto px-4 md:hidden">
          <div className="flex border-t border-white/8">
            {([
              { key: "injuries" as HomeSection, label: "Injuries" },
              { key: "returning" as HomeSection, label: "Returning Today" },
              { key: "recovery" as HomeSection, label: "Recovery Stats" },
            ]).map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setSection(key)}
                className={`flex-1 py-2.5 text-[13px] font-semibold transition-colors relative ${
                  section === key ? "text-white" : "text-white/35 hover:text-white/55"
                }`}
              >
                {label}
                {section === key && (
                  <span className="absolute bottom-0 left-3 right-3 h-[2px] rounded-full bg-[#1C7CFF]" />
                )}
              </button>
            ))}
          </div>
        </div>
      </nav>

      {/* Content */}
      <main className="max-w-5xl mx-auto px-4 py-8 pb-16">
        {/* Desktop always shows injuries; mobile switches via tabs */}
        <div className={section === "injuries" ? "" : "hidden md:block"}>
          <InjuriesView activeTab={activeTab} />
        </div>
        {section === "returning" && (
          <div className="md:hidden">
            <Suspense fallback={<div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-28 rounded-xl bg-white/10 animate-pulse" />)}</div>}>
              <LazyReturningToday leagueSlug={activeTab === "top" ? undefined : activeTab} />
            </Suspense>
          </div>
        )}
        {section === "recovery" && (
          <div className="md:hidden">
            <Suspense fallback={<div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-12 rounded-lg bg-white/10 animate-pulse" />)}</div>}>
              <LazyRecoveryStats leagueSlug={activeTab === "top" ? undefined : activeTab} />
            </Suspense>
          </div>
        )}
      </main>

      {/* SEO intro — homepage injuries tab only */}
      {activeTab === "top" && section === "injuries" && (
        <section className="max-w-5xl mx-auto px-4 pb-8">
          <div className="border-t border-white/5 pt-8">
            <h2 className="text-base font-semibold text-white/60 mb-2">Sports Injury Tracker and Recovery Analysis</h2>
            <p className="text-sm text-white/40 leading-relaxed mb-2">
              Back In Play tracks injuries across the NBA, NFL, MLB, NHL, and EPL, including real-time injury updates, expected return dates, recovery timelines, and performance after returning from injury.
            </p>
            <p className="text-sm text-white/40 leading-relaxed">
              Our database analyzes how injuries impact minutes played, player stats, and performance trends in the games following a return to play.
            </p>
          </div>
        </section>
      )}

      {/* Footer */}
      <footer className="border-t border-white/5 py-8 text-center text-sm text-white/25">
        <p>Back In Play · Sports Injury Intelligence Platform</p>
        <p className="mt-1 text-white/15 text-xs">
          Analyzing 140,000+ injuries across 5 leagues with 3.4M+ game log entries
        </p>
      </footer>
    </div>
  );
}
