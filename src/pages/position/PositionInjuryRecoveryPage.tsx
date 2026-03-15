import { useState, useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { SiteHeader } from "../../components/SiteHeader";
import { SEO } from "../../components/seo/SEO";
import { usePerformanceCurves } from "../../features/performance-curves/lib/queries";
import { resolvePositionSlug } from "./PositionInjuryHubPage";

const LEAGUE_LABELS: Record<string, string> = {
  nba: "NBA", nfl: "NFL", mlb: "MLB", nhl: "NHL", "premier-league": "EPL",
};

const PLURAL_TO_SINGULAR: Record<string, string> = {
  guards: "guard", forwards: "forward", centers: "center",
  quarterbacks: "quarterback", "running-backs": "running-back",
  "wide-receivers": "wide-receiver", "tight-ends": "tight-end",
  linebackers: "linebacker", "defensive-backs": "defensive-back",
  kickers: "kicker", "offensive-linemen": "offensive-line",
  "defensive-linemen": "defensive-line",
  pitchers: "pitcher", infielders: "infielder", outfielders: "outfielder",
  catchers: "catcher", "designated-hitters": "designated-hitter",
  defensemen: "defenseman", goalies: "goalie", goalkeepers: "goalkeeper",
  defenders: "defender", midfielders: "midfielder",
};

const POSITION_LABELS: Record<string, Record<string, string>> = {
  nba: { G: "Guards", F: "Forwards", C: "Centers" },
  nfl: { QB: "Quarterbacks", RB: "Running Backs", WR: "Wide Receivers", TE: "Tight Ends", OL: "Offensive Linemen", DL: "Defensive Linemen", LB: "Linebackers", DB: "Defensive Backs", K: "Kickers" },
  mlb: { P: "Pitchers", IF: "Infielders", OF: "Outfielders", C: "Catchers", DH: "Designated Hitters" },
  nhl: { W: "Forwards", D: "Defensemen", G: "Goalies" },
  "premier-league": { DEF: "Defenders", MID: "Midfielders", FWD: "Forwards", GK: "Goalkeepers" },
};

function slugToTitle(slug: string) {
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
}

const RETURN_OPTS = [
  { value: "", label: "All" },
  { value: "same_season", label: "Same Season" },
  { value: "next_season", label: "Next Season" },
] as const;

export default function PositionInjuryRecoveryPage() {
  const { leagueSlug = "", injuryPerf: positionPlural = "", position: recoverySeg = "" } = useParams<{
    leagueSlug: string; injuryPerf: string; position: string;
  }>();

  const injurySlug = recoverySeg.replace(/-recovery$/, "");
  const singularPos = PLURAL_TO_SINGULAR[positionPlural] ?? positionPlural;
  const posCode = resolvePositionSlug(leagueSlug, singularPos);
  const leagueLabel = LEAGUE_LABELS[leagueSlug] ?? leagueSlug.toUpperCase();
  const posLabel = posCode ? (POSITION_LABELS[leagueSlug]?.[posCode] ?? posCode) : positionPlural;

  const [returnType, setReturnType] = useState<string>("");
  const { data: curves, isLoading } = usePerformanceCurves(leagueSlug, injurySlug, posCode ?? undefined, returnType);
  const curve = useMemo(() => curves?.[0] ?? null, [curves]);

  const injuryName = curve?.injury_type ?? slugToTitle(injurySlug);
  const g10 = curve?.median_pct_recent?.[9];
  const g10Pct = g10 != null ? Math.round(g10 * 100) : null;
  const pageTitle = `${leagueLabel} ${posLabel} ${injuryName} Recovery`;
  const pagePath = `/${leagueSlug}/${positionPlural}/${injurySlug}-recovery`;

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
      <SEO title={pageTitle} description={`${injuryName} recovery data for ${leagueLabel} ${posLabel.toLowerCase()}.`} path={pagePath} type="article" />
      <SiteHeader />
      <nav className="px-4 py-3 text-sm text-white/45 max-w-3xl mx-auto">
        <Link to="/" className="hover:text-white/60">Home</Link>{" / "}
        <Link to={`/${leagueSlug}-injuries`} className="hover:text-white/60">{leagueLabel}</Link>{" / "}
        <Link to={`/${leagueSlug}/${singularPos}-injuries`} className="hover:text-white/60">{posLabel}</Link>{" / "}
        <span className="text-white/60">{injuryName} Recovery</span>
      </nav>
      <div className="max-w-3xl mx-auto px-4 pb-12">
        <h1 className="text-2xl font-bold mb-1">{leagueLabel} {posLabel}: {injuryName} Recovery</h1>
        <div className="flex gap-1 mt-3 mb-6">
          {RETURN_OPTS.map(opt => (
            <button key={opt.value} onClick={() => setReturnType(opt.value)}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${returnType === opt.value ? "bg-cyan-500 text-black" : "bg-white/10 text-white/60 hover:bg-white/15"}`}>
              {opt.label}
            </button>
          ))}
        </div>
        {isLoading ? (
          <div className="animate-pulse text-white/40 text-sm py-8 text-center">Loading...</div>
        ) : !curve ? (
          <div className="bg-white/5 border border-white/10 rounded-xl p-6 text-center">
            <p className="text-white/40">{returnType ? "Insufficient data for this return window. Try 'All'." : "No data available."}</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
              <StatCard label="Sample Size" value={String(curve.sample_size)} />
              <StatCard label="Avg Recovery" value={curve.recovery_days_avg != null ? `${Math.round(curve.recovery_days_avg)}d` : "—"} />
              <StatCard label="Avg Games Missed" value={curve.games_missed_avg != null ? String(Math.round(curve.games_missed_avg)) : "—"} />
              <StatCard label="G10 Performance" value={g10Pct != null ? `${g10Pct}%` : "—"}
                color={g10Pct != null ? (g10Pct >= 95 ? "text-emerald-400" : g10Pct >= 85 ? "text-yellow-400" : "text-red-400") : undefined} />
            </div>
            {curve.next_season_pct != null && (
              <div className="bg-white/5 border border-white/10 rounded-lg p-3 mb-6 text-sm">
                <span className="text-white/50">Next season performance:</span>{" "}
                <span className={curve.next_season_pct >= 0.95 ? "text-emerald-400" : curve.next_season_pct >= 0.85 ? "text-yellow-400" : "text-red-400"}>
                  {Math.round(curve.next_season_pct * 100)}%
                </span>
                <span className="text-white/30 text-xs ml-1">of baseline</span>
              </div>
            )}
            <h2 className="text-lg font-semibold mb-3">Game-by-Game Recovery</h2>
            <div className="grid grid-cols-5 sm:grid-cols-10 gap-2 mb-8">
              {curve.median_pct_recent.slice(0, 10).map((val, i) => {
                const pct = Math.round(val * 100);
                return (
                  <div key={i} className="bg-white/5 rounded-lg p-2 text-center">
                    <div className="text-[10px] text-white/40">G{i + 1}</div>
                    <div className={`text-sm font-semibold ${pct >= 95 ? "text-emerald-400" : pct >= 85 ? "text-yellow-400" : "text-red-400"}`}>{pct}%</div>
                  </div>
                );
              })}
            </div>
            {curve.avg_minutes_pct?.length > 0 && (
              <>
                <h2 className="text-lg font-semibold mb-3">Minutes Load</h2>
                <div className="grid grid-cols-5 sm:grid-cols-10 gap-2 mb-8">
                  {curve.avg_minutes_pct.slice(0, 10).map((val, i) => (
                    <div key={i} className="bg-white/5 rounded-lg p-2 text-center">
                      <div className="text-[10px] text-white/40">G{i + 1}</div>
                      <div className="text-sm font-mono text-white/70">{Math.round(val * 100)}%</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
        <div className="border-t border-white/10 pt-8 mt-8 space-y-2 text-sm">
          <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wide mb-3">Related</h3>
          <Link to={`/${leagueSlug}/${injurySlug}-injury-performance`} className="block text-cyan-400 hover:underline">{leagueLabel} {injuryName} performance</Link>
          <Link to={`/${leagueSlug}/${singularPos}-injuries`} className="block text-cyan-400 hover:underline">{leagueLabel} {posLabel} injuries</Link>
          <Link to={`/injuries/${injurySlug}/compare`} className="block text-cyan-400 hover:underline">{injuryName} cross-league comparison</Link>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-white/5 border border-white/10 rounded-lg p-3">
      <div className="text-[10px] text-white/40 uppercase tracking-wide">{label}</div>
      <div className={`text-lg font-semibold mt-1 ${color ?? "text-white"}`}>{value}</div>
    </div>
  );
}
