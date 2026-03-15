import { Link, useParams } from "react-router-dom";
import { SiteHeader } from "../../components/SiteHeader";
import { SEO } from "../../components/seo/SEO";
import { usePerformanceCurves } from "../../features/performance-curves/lib/queries";
import type { PerformanceCurve } from "../../features/performance-curves/lib/types";

const LEAGUE_LABELS: Record<string, string> = {
  nba: "NBA", nfl: "NFL", mlb: "MLB", nhl: "NHL", "premier-league": "EPL",
};

/** URL slug → position group code, keyed by league */
const POSITION_SLUG_MAP: Record<string, Record<string, string>> = {
  nba: { guard: "G", forward: "F", center: "C" },
  nfl: {
    quarterback: "QB", "running-back": "RB", "wide-receiver": "WR",
    "tight-end": "TE", "offensive-line": "OL", "defensive-line": "DL",
    linebacker: "LB", "defensive-back": "DB", kicker: "K",
  },
  mlb: { pitcher: "P", infielder: "IF", outfielder: "OF", catcher: "C", "designated-hitter": "DH" },
  nhl: { forward: "W", defenseman: "D", goalie: "G" },
  "premier-league": { defender: "DEF", midfielder: "MID", forward: "FWD", goalkeeper: "GK" },
};

/** Pretty labels for position codes */
const POSITION_LABELS: Record<string, Record<string, string>> = {
  nba: { G: "Guards", F: "Forwards", C: "Centers" },
  nfl: {
    QB: "Quarterbacks", RB: "Running Backs", WR: "Wide Receivers",
    TE: "Tight Ends", OL: "Offensive Linemen", DL: "Defensive Linemen",
    LB: "Linebackers", DB: "Defensive Backs", K: "Kickers",
  },
  mlb: { P: "Pitchers", IF: "Infielders", OF: "Outfielders", C: "Catchers", DH: "Designated Hitters" },
  nhl: { W: "Forwards", D: "Defensemen", G: "Goalies" },
  "premier-league": { DEF: "Defenders", MID: "Midfielders", FWD: "Forwards", GK: "Goalkeepers" },
};

export function resolvePositionSlug(leagueSlug: string, posSlug: string): string | null {
  return POSITION_SLUG_MAP[leagueSlug]?.[posSlug] ?? null;
}

export function isKnownPositionSlug(leagueSlug: string, posSlug: string): boolean {
  return resolvePositionSlug(leagueSlug, posSlug) != null;
}

export default function PositionInjuryHubPage() {
  const { leagueSlug = "", teamSlug = "" } = useParams<{ leagueSlug: string; teamSlug: string }>();

  const posSlug = teamSlug.replace(/-injuries$/, "");
  const posCode = resolvePositionSlug(leagueSlug, posSlug);
  const leagueLabel = LEAGUE_LABELS[leagueSlug] ?? leagueSlug.toUpperCase();
  const posLabel = posCode ? (POSITION_LABELS[leagueSlug]?.[posCode] ?? posCode) : posSlug;

  const { data: curves, isLoading } = usePerformanceCurves(leagueSlug, undefined, posCode ?? undefined);

  const sorted = (curves ?? [])
    .filter((c) => c.injury_type_slug !== "other")
    .sort((a, b) => b.sample_size - a.sample_size);

  const pageTitle = `${leagueLabel} ${posLabel} Injuries — Performance After Injury`;
  const pageDesc = `How do ${leagueLabel} ${posLabel.toLowerCase()} perform after injury? Ranked injury types by frequency with recovery timelines and game-by-game performance data.`;
  const pagePath = `/${leagueSlug}/${posSlug}-injuries`;

  if (!posCode) {
    return (
      <div className="min-h-screen bg-[#0a0f1a] flex flex-col items-center justify-center gap-4">
        <p className="text-white/60">Position not found</p>
        <Link to="/" className="text-cyan-400 hover:underline text-sm">Back to Home</Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0f1a] text-white">
      <SEO title={pageTitle} description={pageDesc} path={pagePath} type="article" />
      <SiteHeader />

      <nav className="px-4 py-3 text-sm text-white/45 max-w-3xl mx-auto">
        <Link to="/" className="hover:text-white/60">Home</Link>
        {" / "}
        <Link to={`/${leagueSlug}-injuries`} className="hover:text-white/60">{leagueLabel} Injuries</Link>
        {" / "}
        <span className="text-white/60">{posLabel}</span>
      </nav>

      <div className="max-w-3xl mx-auto px-4 pb-12">
        <h1 className="text-2xl font-bold mb-1">{leagueLabel} {posLabel} Injuries</h1>
        <p className="text-sm text-white/40 mb-6">{sorted.length} injury types • ranked by frequency</p>

        {isLoading ? (
          <div className="animate-pulse text-white/40 text-sm py-8 text-center">Loading injury data...</div>
        ) : sorted.length === 0 ? (
          <div className="bg-white/5 border border-white/10 rounded-xl p-6 text-center">
            <p className="text-white/40">No injury data available for this position</p>
          </div>
        ) : (
          <div className="space-y-2">
            {sorted.map((curve) => (
              <InjuryRow key={curve.curve_id} curve={curve} leagueSlug={leagueSlug} posSlug={posSlug} />
            ))}
          </div>
        )}

        <div className="border-t border-white/10 pt-8 mt-8 space-y-2 text-sm">
          <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wide mb-3">Related</h3>
          <Link to={`/${leagueSlug}-injuries`} className="block text-cyan-400 hover:underline">
            {leagueLabel} injury report
          </Link>
          <Link to={`/${leagueSlug}-injury-performance`} className="block text-cyan-400 hover:underline">
            {leagueLabel} injury performance analysis
          </Link>
          <Link to="/performance-curves" className="block text-cyan-400 hover:underline">
            All performance curves
          </Link>
          {Object.entries(POSITION_SLUG_MAP[leagueSlug] ?? {}).map(([slug, code]) => {
            if (slug === posSlug) return null;
            const label = POSITION_LABELS[leagueSlug]?.[code] ?? code;
            return (
              <Link key={slug} to={`/${leagueSlug}/${slug}-injuries`} className="block text-cyan-400 hover:underline">
                {leagueLabel} {label} injuries
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function InjuryRow({ curve, leagueSlug, posSlug }: { curve: PerformanceCurve; leagueSlug: string; posSlug: string }) {
  const injSlug = curve.injury_type_slug;
  const g10 = curve.median_pct_recent?.[9];
  const g10Pct = g10 != null ? Math.round(g10 * 100) : null;
  const recovDays = curve.recovery_days_avg != null ? Math.round(curve.recovery_days_avg) : null;

  return (
    <Link
      to={`/${leagueSlug}/${injSlug}-injury-performance/${posSlug}`}
      className="flex items-center gap-3 bg-white/5 border border-white/10 rounded-lg p-3 hover:bg-white/10 transition-colors"
    >
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm">{curve.injury_type}</div>
        <div className="flex items-center gap-3 mt-0.5 text-xs text-white/50">
          <span>{curve.sample_size} cases</span>
          {recovDays != null && <span>{recovDays}d median recovery</span>}
        </div>
      </div>
      {g10Pct != null && (
        <div className="text-right shrink-0">
          <div className={`text-sm font-semibold ${g10Pct >= 95 ? "text-emerald-400" : g10Pct >= 85 ? "text-yellow-400" : "text-red-400"}`}>
            {g10Pct}%
          </div>
          <div className="text-[10px] text-white/30">G10</div>
        </div>
      )}
    </Link>
  );
}
