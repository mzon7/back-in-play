import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { SiteHeader } from "../components/SiteHeader";
import { SEO } from "../components/seo/SEO";
import { InjuryPlayerCard } from "../components/InjuryPlayerCard";
import { getTrackedPlayers, removeTrackedPlayer } from "../lib/trackedPlayers";
import { supabase, dbTable } from "../lib/supabase";

interface TrackedPlayerData {
  player_slug: string;
  player_name: string;
  position: string;
  team_name: string;
  league_slug: string;
  headshot_url: string | null;
  status: string;
  injury_type: string;
  date_injured: string | null;
  expected_return: string | null;
  is_star: boolean;
  is_starter: boolean;
  games_missed: number | null;
}

export default function TrackedPlayersPage() {
  const [slugs, setSlugs] = useState<string[]>(() => getTrackedPlayers());
  const [players, setPlayers] = useState<TrackedPlayerData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (slugs.length === 0) {
      setPlayers([]);
      setLoading(false);
      return;
    }

    (async () => {
      setLoading(true);
      // Fetch player info + latest injury for each tracked slug
      const { data } = await supabase
        .from(dbTable("injuries"))
        .select("player_name, player_slug, position, team_name, league_slug, headshot_url, status, injury_type, date_injured, expected_return, is_star, is_starter, games_missed")
        .in("player_slug", slugs)
        .order("date_injured", { ascending: false });

      // Deduplicate — keep the most recent injury per player
      const seen = new Set<string>();
      const deduped: TrackedPlayerData[] = [];
      for (const row of data ?? []) {
        if (!seen.has(row.player_slug)) {
          seen.add(row.player_slug);
          deduped.push(row as TrackedPlayerData);
        }
      }
      setPlayers(deduped);
      setLoading(false);
    })();
  }, [slugs]);

  function handleUntrack(slug: string) {
    removeTrackedPlayer(slug);
    setSlugs(prev => prev.filter(s => s !== slug));
  }

  return (
    <div className="min-h-screen bg-[#0a0f1a] text-white">
      <SEO title="Tracked Players | Back In Play" description="Your tracked players for injury updates and return analysis." path="/tracked-players" />
      <SiteHeader />

      <main className="max-w-3xl mx-auto px-4 py-8">
        <h1 className="text-xl font-bold mb-1">Tracked Players</h1>
        <p className="text-sm text-white/40 mb-6">Players you're monitoring for injury updates and return analysis.</p>

        {loading ? (
          <div className="animate-pulse text-white/40 text-sm py-12 text-center">Loading tracked players...</div>
        ) : players.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-white/40 text-sm mb-2">No tracked players yet.</p>
            <p className="text-white/30 text-xs mb-6">Track players from the homepage or any player page to see them here.</p>
            <Link to="/" className="text-sm text-[#1C7CFF] hover:text-[#1C7CFF]/80 transition-colors">
              Browse players &rarr;
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {players.map((p) => (
              <InjuryPlayerCard
                key={p.player_slug}
                player_name={p.player_name}
                player_slug={p.player_slug}
                position={p.position}
                team_name={p.team_name}
                league_slug={p.league_slug}
                headshot_url={p.headshot_url}
                status={p.status}
                injury_type={p.injury_type}
                date_injured={p.date_injured}
                expected_return={p.expected_return}
                is_star={p.is_star}
                is_starter={p.is_starter}
                games_missed={p.games_missed}
                showLeague
              >
                <div className="px-4 pb-3">
                  <button
                    onClick={() => handleUntrack(p.player_slug)}
                    className="text-xs text-white/30 hover:text-red-400/70 transition-colors"
                  >
                    Remove from tracked
                  </button>
                </div>
              </InjuryPlayerCard>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
