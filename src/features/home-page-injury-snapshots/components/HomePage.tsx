import { useState, useEffect } from "react";
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
import { SEO } from "../../../components/seo/SEO";
import { supabase } from "../../../lib/supabase";

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

function classifySection(inj: InjuryRow): Section {
  const s = (inj.status ?? "").toLowerCase().replace(/-/g, "_");
  if (s === "back_in_play") return "back";
  if (s === "reduced_load") return "reduced";
  if (["active", "probable", "returned", "active_today"].includes(s)) return "active";
  return "out";
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
  // Player importance (1-10 scale)
  let importance = 1;
  if (inj.is_star) importance = 10;
  else if (inj.is_starter) importance = 6;
  else {
    const rank = Math.min(inj.preseason_rank ?? 999, inj.league_rank ?? 999, inj.rank_at_injury ?? 999);
    if (rank <= 10) importance = 8;
    else if (rank <= 30) importance = 5;
    else if (rank <= 50) importance = 3;
  }

  // Position boost
  const pos = (inj.position ?? "").toUpperCase();
  importance *= (POSITION_BOOST[pos] ?? 1);

  // Recency: injuries from today = 1.0, 30 days ago = 0.3, older = 0.1
  const days = daysAgo(inj.date_injured);
  const recency = days <= 1 ? 1.0 : days <= 7 ? 0.8 : days <= 14 ? 0.6 : days <= 30 ? 0.3 : 0.1;

  return importance * recency;
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
  if (changes.length === 0) return <p className="text-[10px] text-white/20 mt-2">No status history</p>;

  return (
    <div className="mt-3 pt-3 border-t border-white/10">
      <p className="text-[10px] text-white/30 mb-2 font-semibold uppercase tracking-wide">Status Timeline</p>
      <div className="flex items-start gap-0 overflow-x-auto pb-1">
        {changes.map((c, i) => (
          <div key={c.id} className="flex items-center shrink-0">
            <div className="flex flex-col items-center gap-1">
              <StatusBadge status={c.new_status} />
              <span className="text-[9px] text-white/25 whitespace-nowrap">
                {new Date(c.changed_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </span>
              <span className="text-[8px] text-white/15 max-w-[80px] text-center truncate">{c.summary}</span>
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
  const rank = inj.preseason_rank ?? inj.league_rank ?? inj.rank_at_injury;
  const [expanded, setExpanded] = useState(false);
  const days = daysAgo(inj.date_injured);

  return (
    <div
      className="rounded-xl border border-white/10 bg-white/5 p-3 cursor-pointer transition-colors hover:bg-white/[0.07]"
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-start gap-3">
        {/* Headshot or rank badge */}
        {inj.headshot_url ? (
          <img
            src={inj.headshot_url}
            alt={inj.player_name}
            className="h-10 w-10 rounded-full bg-white/10 object-cover shrink-0"
          />
        ) : rank ? (
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 shrink-0">
            <span className="text-xs font-bold text-white/60">#{rank}</span>
          </div>
        ) : null}

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Link
                to={`/player/${(inj.player_name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`}
                className="text-sm font-medium text-white truncate hover:text-cyan-400 transition-colors"
                onClick={(e) => e.stopPropagation()}
              >{inj.player_name}</Link>
              {inj.is_star && (
                <span className="shrink-0 text-[11px]" title="Star player">{"\u2B50"}</span>
              )}
              {inj.is_starter && !inj.is_star && (
                <span className="shrink-0 text-[9px] font-bold text-emerald-400 border border-emerald-400/40 rounded px-1" title="Starter">S</span>
              )}
              {inj.position && (
                <span className="text-[10px] text-white/40 shrink-0">{inj.position}</span>
              )}
              {rank && rank <= 50 && (
                <span className="text-[10px] text-amber-400/70 shrink-0">#{rank}</span>
              )}
            </div>
            <StatusBadge status={inj.status ?? "out"} />
          </div>

          <div className="flex items-center gap-2 mt-0.5">
            {inj.team_name && inj.team_name !== "Unknown" && (
              <p className="text-xs text-white/40 truncate">{inj.team_name}</p>
            )}
            {showLeague && inj.league_slug && (
              <span className="flex items-center gap-1 text-[10px] text-white/30">
                <span className={`h-1.5 w-1.5 rounded-full ${LEAGUE_DOT[inj.league_slug] ?? "bg-white/30"}`} />
                {LEAGUE_LABELS[inj.league_slug] ?? inj.league_name}
              </span>
            )}
          </div>

          {/* Games missed & days since injury */}
          <div className="flex items-center gap-3 mt-1 text-[10px]">
            {days > 0 && (
              <span className="text-white/35">
                {days === 1 ? "1 day" : `${days} days`} since injury
              </span>
            )}
            {inj.games_missed != null && inj.games_missed > 0 && (
              <span className="text-red-400/60 font-medium">
                {inj.games_missed} game{inj.games_missed !== 1 ? "s" : ""} missed
              </span>
            )}
          </div>

          {/* Minutes bar (for reduced_load / back_in_play / active_today) */}
          {inj.game_minutes != null && inj.game_minutes > 0 && (
            <div className="mt-1.5">
              <div className="flex items-center gap-2 text-xs">
                <span className="text-white/60 font-medium">{inj.game_minutes} min</span>
                {inj.pre_injury_avg_minutes != null && inj.pre_injury_avg_minutes > 0 && (
                  <>
                    <span className="text-white/30">/ {inj.pre_injury_avg_minutes} usual</span>
                    <span className={`text-[10px] font-bold ${
                      (inj.game_minutes / inj.pre_injury_avg_minutes) >= 0.8
                        ? "text-cyan-400"
                        : "text-amber-400"
                    }`}>
                      {Math.round((inj.game_minutes / inj.pre_injury_avg_minutes) * 100)}%
                    </span>
                  </>
                )}
              </div>
              {inj.pre_injury_avg_minutes != null && inj.pre_injury_avg_minutes > 0 && (
                <div className="mt-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      (inj.game_minutes / inj.pre_injury_avg_minutes) >= 0.8
                        ? "bg-cyan-400"
                        : "bg-amber-400"
                    }`}
                    style={{ width: `${Math.min(100, (inj.game_minutes / inj.pre_injury_avg_minutes) * 100)}%` }}
                  />
                </div>
              )}
            </div>
          )}

          {/* Injury details */}
          <div className="mt-1.5 space-y-0.5">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-white/60 font-medium">{inj.injury_type}</span>
              {inj.side && <span className="text-white/30">({inj.side})</span>}
            </div>
            {inj.injury_description && (
              <p className="text-[11px] text-white/35 line-clamp-2">{inj.injury_description}</p>
            )}
            {inj.expected_return && (
              <p className="text-[11px] text-cyan-300/60">Est. return: {inj.expected_return}</p>
            )}
            {inj.long_comment && (
              <p className="text-[11px] text-white/30 line-clamp-2 italic">{inj.long_comment}</p>
            )}
          </div>

          {/* Meta */}
          <div className="mt-1.5 flex items-center gap-3 text-[10px] text-white/25">
            <span>{inj.date_injured}</span>
            {inj.source && <span>{inj.source}</span>}
            <span className="ml-auto text-white/15">{expanded ? "tap to collapse" : "tap for timeline"}</span>
          </div>

          {/* Status Timeline (expanded) */}
          {expanded && <StatusTimeline playerId={inj.player_id} />}
        </div>
      </div>
    </div>
  );
}

function SectionBlock({
  section,
  injuries,
  showLeague,
}: {
  section: (typeof SECTIONS)[number];
  injuries: InjuryRow[];
  showLeague?: boolean;
}) {
  if (injuries.length === 0) return null;
  const sorted = [...injuries].sort(sortByImportance);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span>{section.emoji}</span>
        <h3 className={`text-xs font-semibold uppercase tracking-wide ${section.color}`}>
          {section.label}
        </h3>
        <span className="text-[10px] text-white/30">({sorted.length})</span>
        <span className="text-[10px] text-white/20 ml-1 hidden sm:inline">{section.desc}</span>
      </div>
      <div className="space-y-2">
        {sorted.map((inj) => (
          <InjuryCard key={inj.injury_id} inj={inj} showLeague={showLeague} />
        ))}
      </div>
    </div>
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
      {hint && <p className="mt-1 text-[11px] text-white/30">{hint}</p>}
    </div>
  );
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

function StatusUpdatesBlock({ showLeague }: { showLeague?: boolean }) {
  const { data: rawChanges = [], isLoading } = useStatusChanges(50);

  // Deduplicate: keep only the latest change per player
  const seen = new Set<string>();
  const changes = rawChanges.filter((c) => {
    if (seen.has(c.player_id)) return false;
    seen.add(c.player_id);
    return true;
  }).slice(0, 20);

  if (isLoading) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span>{"\uD83D\uDCE2"}</span>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[#1C7CFF]">Player Status Updates</h3>
        </div>
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-12 rounded-xl bg-white/10 animate-pulse" />
        ))}
      </div>
    );
  }

  if (changes.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span>{"\uD83D\uDCE2"}</span>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[#1C7CFF]">
          Player Status Updates
        </h3>
        <span className="text-[10px] text-white/30">({changes.length})</span>
        <span className="text-[10px] text-white/20 ml-1 hidden sm:inline">Last 24 hours</span>
      </div>
      <div className="space-y-1">
        {changes.map((c) => (
          <div
            key={c.id}
            className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/5 px-3 py-2"
          >
            {c.headshot_url ? (
              <img
                src={c.headshot_url}
                alt={c.player_name}
                className="h-8 w-8 rounded-full bg-white/10 object-cover shrink-0"
              />
            ) : (
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 shrink-0">
                <span className="text-[10px] text-white/40">{(c.player_name ?? "?")[0]}</span>
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-white truncate">{c.player_name}</span>
                <span className={`text-xs font-semibold ${CHANGE_TYPE_STYLE[c.change_type] ?? "text-white/50"}`}>
                  — {c.summary}
                </span>
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-[10px] text-white/30">{c.team_name}</span>
                {showLeague && c.league_slug && (
                  <span className="flex items-center gap-1 text-[10px] text-white/25">
                    <span className={`h-1.5 w-1.5 rounded-full ${LEAGUE_DOT[c.league_slug] ?? "bg-white/30"}`} />
                    {LEAGUE_LABELS[c.league_slug] ?? ""}
                  </span>
                )}
                <span className="text-[10px] text-white/20">{timeAgo(c.changed_at)}</span>
              </div>
            </div>
            {c.old_status && c.new_status && c.old_status !== c.new_status && (
              <div className="flex items-center gap-1 shrink-0">
                <StatusBadge status={c.old_status} />
                <span className="text-white/30 text-xs">{"\u2192"}</span>
                <StatusBadge status={c.new_status} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* -- Headline Stories: square cards for high-impact events -- */

type HeadlineCard = {
  key: string;
  player_name: string;
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

function headlineScore(inj: InjuryRow): number {
  return starRating(inj) * recencyFactor(inj.date_injured);
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

function buildHeadlineCards(injuries: InjuryRow[], changes: StatusChangeRow[]): HeadlineCard[] {
  const cards: HeadlineCard[] = [];
  const seenPlayers = new Set<string>();

  // Score all injuries and pick top ones
  const scored = injuries
    .map((inj) => ({ inj, score: headlineScore(inj) }))
    .filter(({ score }) => score >= 3) // threshold: only notable players
    .sort((a, b) => b.score - a.score);

  for (const { inj, score } of scored) {
    if (seenPlayers.has(inj.player_id)) continue;
    seenPlayers.add(inj.player_id);

    const status = (inj.status ?? "out").toLowerCase().replace(/-/g, "_");
    const isReturning = ["active", "active_today", "back_in_play", "probable"].includes(status);

    const impact = impactFromScore(score);
    const summary = isReturning
      ? "Returning to action"
      : `${inj.injury_type ?? "Injury"} — ${inj.status}`;

    cards.push({
      key: `inj-${inj.injury_id}`,
      player_name: inj.player_name ?? "Unknown",
      headshot_url: inj.headshot_url ?? null,
      team_name: (inj.team_name && inj.team_name !== "Unknown") ? inj.team_name : "",
      league_slug: inj.league_slug ?? "",
      status: inj.status ?? "out",
      summary,
      impact,
      impactColor: IMPACT_COLORS[impact],
      timeAgo: daysAgo(inj.date_injured) === 0 ? "Today"
        : daysAgo(inj.date_injured) === 1 ? "Yesterday"
        : `${daysAgo(inj.date_injured)}d ago`,
      type: isReturning ? "return" : "injury",
    });

    if (cards.length >= 8) break;
  }

  // Fill remaining slots with notable status changes
  for (const c of changes) {
    if (cards.length >= 8) break;
    if (seenPlayers.has(c.player_id)) continue;
    if (c.change_type === "updated") continue;
    const isDowngrade = c.summary?.toLowerCase().includes("downgraded");
    const isActivation = c.change_type === "activated" || c.new_status === "active";
    if (!isActivation && !isDowngrade && c.change_type !== "new_injury") continue;

    seenPlayers.add(c.player_id);
    cards.push({
      key: `sc-${c.id}`,
      player_name: c.player_name ?? "Unknown",
      headshot_url: c.headshot_url ?? null,
      team_name: c.team_name ?? "",
      league_slug: c.league_slug ?? "",
      status: c.new_status,
      summary: c.summary,
      impact: isDowngrade ? "High" : "Medium",
      impactColor: IMPACT_COLORS[isDowngrade ? "High" : "Medium"],
      timeAgo: timeAgo(c.changed_at),
      type: "status_change",
    });
  }

  return cards;
}

function HeadlineStories({ injuries, showLeague }: { injuries: InjuryRow[]; showLeague?: boolean }) {
  const { data: rawChanges = [] } = useStatusChanges(30);
  const cards = buildHeadlineCards(injuries, rawChanges);

  if (cards.length === 0) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span>{"\uD83D\uDD25"}</span>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-white/70">
          Headline Stories
        </h3>
        <span className="text-[10px] text-white/30">({cards.length})</span>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 snap-x snap-mandatory">
        {cards.map((card) => (
          <div
            key={card.key}
            className="shrink-0 w-[160px] sm:w-[180px] rounded-xl border border-white/10 bg-white/5 p-3 snap-start hover:bg-white/[0.07] transition-colors"
          >
            {/* Headshot */}
            <div className="flex justify-center mb-2">
              {card.headshot_url ? (
                <img
                  src={card.headshot_url}
                  alt={card.player_name}
                  className="h-16 w-16 rounded-full bg-white/10 object-cover"
                />
              ) : (
                <div className="h-16 w-16 rounded-full bg-white/10 flex items-center justify-center">
                  <span className="text-lg text-white/30">{card.player_name[0]}</span>
                </div>
              )}
            </div>

            {/* Name */}
            <p className="text-sm font-semibold text-white text-center truncate">{card.player_name}</p>

            {/* Team / League */}
            <div className="flex items-center justify-center gap-1.5 mt-0.5">
              {card.team_name && (
                <span className="text-[10px] text-white/35 truncate max-w-[90px]">{card.team_name}</span>
              )}
              {showLeague && card.league_slug && (
                <span className="flex items-center gap-1 text-[10px] text-white/25">
                  <span className={`h-1.5 w-1.5 rounded-full ${LEAGUE_DOT[card.league_slug] ?? "bg-white/30"}`} />
                  {LEAGUE_LABELS[card.league_slug] ?? ""}
                </span>
              )}
            </div>

            {/* Status change */}
            <p className="text-[11px] text-white/50 text-center mt-1.5 line-clamp-2">{card.summary}</p>

            {/* Impact badge */}
            <div className="flex justify-center mt-2">
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${card.impactColor}`}>
                {card.impact}
              </span>
            </div>

            {/* Status + Time */}
            <div className="flex items-center justify-between mt-2">
              <StatusBadge status={card.status} />
              <span className="text-[9px] text-white/25">{card.timeAgo}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* -- Landing: Top 50 players across all leagues -- */
function TopPlayersView() {
  const { data: injuries = [], isLoading } = useTopPlayerInjuries();

  if (isLoading) return <LoadingSkeleton />;
  if (injuries.length === 0) {
    return <EmptyBox message="No top player injury data yet." />;
  }

  const grouped: Record<Section, InjuryRow[]> = { out: [], active: [], reduced: [], back: [] };
  for (const inj of injuries) {
    grouped[classifySection(inj)].push(inj);
  }

  return (
    <div className="space-y-6">
      <HeadlineStories injuries={injuries} showLeague />
      <StatusUpdatesBlock showLeague />
      {SECTIONS.map((sec) => (
        <SectionBlock key={sec.key} section={sec} injuries={grouped[sec.key]} showLeague />
      ))}
    </div>
  );
}

/* -- Per-league injuries view -- */
function LeagueInjuries({ slug }: { slug: string }) {
  const { data: injuries = [], isLoading } = useCurrentInjuries(slug);
  const [teamFilter, setTeamFilter] = useState<string | null>(null);

  // Reset team filter when league changes
  useEffect(() => { setTeamFilter(null); }, [slug]);

  if (isLoading) return <LoadingSkeleton />;
  if (injuries.length === 0) {
    return <EmptyBox message={`No injury data for ${LEAGUE_LABELS[slug] ?? slug.toUpperCase()}.`} />;
  }

  // Extract unique teams sorted alphabetically
  const teams = Array.from(new Set(injuries.map((i) => i.team_name ?? "").filter((t) => t && t !== "Unknown"))).sort();

  const filtered = teamFilter
    ? injuries.filter((i) => i.team_name === teamFilter)
    : injuries;

  const grouped: Record<Section, InjuryRow[]> = { out: [], active: [], reduced: [], back: [] };
  for (const inj of filtered) {
    grouped[classifySection(inj)].push(inj);
  }

  return (
    <div className="space-y-6">
      <HeadlineStories injuries={injuries} />
      <StatusUpdatesBlock />
      {/* Team filter */}
      {teams.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
          <button
            onClick={() => setTeamFilter(null)}
            className={`shrink-0 px-3 py-1 rounded-full text-[11px] font-semibold border transition-colors ${
              teamFilter === null
                ? "border-white/30 bg-white/10 text-white"
                : "border-white/10 text-white/40 hover:text-white/60"
            }`}
          >
            All Teams ({injuries.length})
          </button>
          {teams.map((team) => {
            const count = injuries.filter((i) => i.team_name === team).length;
            return (
              <button
                key={team}
                onClick={() => setTeamFilter(teamFilter === team ? null : team)}
                className={`shrink-0 px-3 py-1 rounded-full text-[11px] font-semibold border transition-colors ${
                  teamFilter === team
                    ? "border-[#1C7CFF]/50 bg-[#1C7CFF]/15 text-[#1C7CFF]"
                    : "border-white/10 text-white/40 hover:text-white/60"
                }`}
              >
                {team} ({count})
              </button>
            );
          })}
        </div>
      )}

      {SECTIONS.map((sec) => (
        <SectionBlock key={sec.key} section={sec} injuries={grouped[sec.key]} />
      ))}
    </div>
  );
}

/* -- Tab type: "top" landing or per-league -- */
type Tab = "top" | string;

export default function HomePage({ initialLeague }: { initialLeague?: string }) {
  const { leagueSlug: routeLeague } = useParams<{ leagueSlug: string }>();
  const { data: leagues = [] } = useLeagues();
  const [activeTab, setActiveTab] = useState<Tab>(routeLeague ?? initialLeague ?? "top");

  const orderedSlugs = LEAGUE_ORDER.filter(
    (s) => leagues.length === 0 || leagues.some((l) => l.slug === s),
  );

  const allTabs: { key: Tab; label: string }[] = [
    { key: "top", label: "Top Players" },
    ...orderedSlugs.map((s) => ({ key: s, label: LEAGUE_LABELS[s] ?? s.toUpperCase() })),
  ];

  const year = new Date().getFullYear();
  const seoTitle = activeTab === "top"
    ? `Sports Injury Tracker (${year}) - Live Updates & Return Dates`
    : `${LEAGUE_LABELS[activeTab] ?? activeTab.toUpperCase()} Injuries (${year}) - Status & Return Dates`;
  const seoDesc = activeTab === "top"
    ? `Live injury updates for NBA, NFL, MLB, NHL, and EPL. Track player injuries, expected return dates, and status changes.`
    : `${LEAGUE_LABELS[activeTab] ?? activeTab.toUpperCase()} injury report - latest player injuries, return dates, and status updates.`;

  return (
    <div className="min-h-screen bg-[#0A0E1A] text-white">
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
          </Link>

          <div className="flex items-center gap-1 sm:gap-3 text-sm font-medium overflow-x-auto">
            <Link to="/" className="px-2 py-1 text-[#1C7CFF] shrink-0">Home</Link>
            <Link to="/recovery-stats" className="px-2 py-1 text-white/60 hover:text-white transition-colors shrink-0">Recovery Stats</Link>
          </div>
        </div>

        {/* League tabs */}
        <div className="max-w-5xl mx-auto px-4 pb-2 flex gap-2 overflow-x-auto">
          {allTabs.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`shrink-0 px-3 py-1 rounded-full text-xs font-bold border transition-colors ${
                activeTab === key
                  ? key === "top"
                    ? "border-amber-400/40 bg-amber-500/15 text-amber-300"
                    : "border-[#1C7CFF]/60 bg-[#1C7CFF]/15 text-[#1C7CFF]"
                  : "border-white/10 text-white/50 hover:border-white/20 hover:text-white/70"
              }`}
            >
              {key === "top" && "\uD83D\uDC51 "}
              {label}
            </button>
          ))}
        </div>
      </nav>

      {/* Content */}
      <main className="max-w-5xl mx-auto px-4 py-6 pb-16">
        {activeTab === "top" ? (
          <TopPlayersView key="top-players" />
        ) : (
          <LeagueInjuries key="league-injuries" slug={activeTab} />
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-white/5 py-6 text-center text-xs text-white/20">
        Back In Play · Sports Injury Intelligence Platform
      </footer>
    </div>
  );
}
