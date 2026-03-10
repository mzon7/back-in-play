import { Link, useSearchParams } from "react-router-dom";
import { useLatestInjuries, useCurrentlyInjured, useReturningSoon } from "../lib/queries";
import { InjuryTable } from "./InjuryTable";
import { SectionCard } from "./SectionCard";
import { config } from "../../../config";

const LEAGUES = [
  { label: "NFL", slug: "nfl" },
  { label: "NBA", slug: "nba" },
  { label: "MLB", slug: "mlb" },
  { label: "NHL", slug: "nhl" },
  { label: "EPL", slug: "epl" },
];

export default function HomePage() {
  const [searchParams] = useSearchParams();

  // Allow ?windowDays=<n> to override the default for quick tuning
  const paramRaw = searchParams.get("windowDays");
  const paramNum = Number(paramRaw);
  const windowDays =
    paramRaw !== null && Number.isFinite(paramNum) && paramNum > 0
      ? paramNum
      : config.returningSoonWindowDays;

  const latest = useLatestInjuries({ limit: 10 });
  const current = useCurrentlyInjured({ limit: 10 });
  const returning = useReturningSoon({ limit: 10, windowDays });

  return (
    <div className="min-h-screen bg-[#0A0E1A] text-white">
      {/* Top Nav */}
      <nav className="sticky top-0 z-50 border-b border-white/10 bg-[#0A0E1A]/90 backdrop-blur-md">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          {/* Logo */}
          <Link to="/" className="flex items-center gap-2 shrink-0">
            <span className="text-xl font-black tracking-tight">
              <span className="text-[#1C7CFF]">BACK</span>
              <span className="text-white/50 mx-1">IN</span>
              <span className="text-[#3DFF8F]">PLAY</span>
            </span>
          </Link>

          {/* Nav links */}
          <div className="flex items-center gap-1 sm:gap-3 text-sm font-medium overflow-x-auto">
            <Link to="/" className="px-2 py-1 text-[#1C7CFF] shrink-0">Home</Link>
            <Link to="/latest-injuries" className="px-2 py-1 text-white/60 hover:text-white transition-colors shrink-0">Latest</Link>
            <Link to="/return-tracker" className="px-2 py-1 text-white/60 hover:text-white transition-colors shrink-0">Return Tracker</Link>
            <Link to="/search" className="px-2 py-1 text-white/60 hover:text-white transition-colors shrink-0">Search</Link>
          </div>
        </div>

        {/* League quick links */}
        <div className="max-w-5xl mx-auto px-4 pb-2 flex gap-2 overflow-x-auto">
          {LEAGUES.map((l) => (
            <Link
              key={l.slug}
              to={`/league/${l.slug}`}
              className="shrink-0 px-3 py-1 rounded-full text-xs font-bold border border-white/10 text-white/50 hover:border-[#1C7CFF]/60 hover:text-[#1C7CFF] transition-colors"
            >
              {l.label}
            </Link>
          ))}
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-5xl mx-auto px-4 pt-12 pb-10 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-bold bg-[#1C7CFF]/10 text-[#1C7CFF] border border-[#1C7CFF]/20 mb-5">
          <span className="w-1.5 h-1.5 rounded-full bg-[#3DFF8F] animate-pulse" />
          Live Injury Intelligence · NFL · NBA · MLB · NHL · Premier League
        </div>

        <h1 className="text-4xl sm:text-5xl font-black tracking-tight mb-4">
          Sports Injury{" "}
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#1C7CFF] to-[#3DFF8F]">
            Intelligence
          </span>
        </h1>
        <p className="text-white/50 text-base sm:text-lg max-w-xl mx-auto mb-8">
          Track injuries, recovery timelines, and return dates across the biggest leagues — all in one place.
        </p>

        <div className="flex items-center justify-center gap-3 flex-wrap">
          <Link
            to="/latest-injuries"
            className="px-5 py-2.5 rounded-xl bg-[#1C7CFF] hover:bg-[#1C7CFF]/80 text-white font-bold text-sm transition-colors shadow-lg shadow-[#1C7CFF]/20"
          >
            Latest Injuries
          </Link>
          <Link
            to="/return-tracker"
            className="px-5 py-2.5 rounded-xl bg-white/10 hover:bg-white/15 text-white font-bold text-sm transition-colors border border-white/10"
          >
            Return Tracker
          </Link>
        </div>
      </section>

      {/* Three sections */}
      <main className="max-w-5xl mx-auto px-4 pb-16 flex flex-col gap-6">
        <SectionCard title="Latest Injuries" icon="⚡" viewAllTo="/latest-injuries">
          <InjuryTable
            rows={latest.data ?? []}
            isLoading={latest.isLoading}
            emptyMessage="No recent injuries found."
          />
        </SectionCard>

        <SectionCard title="Currently Injured" icon="🩹" viewAllTo="/latest-injuries">
          <InjuryTable
            rows={current.data ?? []}
            isLoading={current.isLoading}
            emptyMessage="No active injuries found."
          />
        </SectionCard>

        <SectionCard title="Returning Soon" icon="🏃" viewAllTo="/return-tracker">
          <InjuryTable
            rows={returning.data ?? []}
            isLoading={returning.isLoading}
            emptyMessage={`No players returning in the next ${windowDays} days.`}
          />
        </SectionCard>
      </main>

      {/* Footer */}
      <footer className="border-t border-white/5 py-6 text-center text-xs text-white/20">
        Back In Play · Sports Injury Intelligence Platform
      </footer>
    </div>
  );
}
