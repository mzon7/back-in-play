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
      console.log("[TrackedPlayers] Looking up slugs:", slugs);
      // First get player_ids from the players table by slug
      const { data: playerRows, error: playerErr } = await supabase
        .from(dbTable("players"))
        .select("player_id, slug, player_name")
        .in("slug", slugs);

      console.log("[TrackedPlayers] Players found:", playerRows?.length, "error:", playerErr);
      if (!playerRows || playerRows.length === 0) {
        setPlayers([]);
        setLoading(false);
        return;
      }

      const playerIds = playerRows.map((p) => p.player_id);
      const slugById = Object.fromEntries(playerRows.map((p) => [p.player_id, p.slug]));

      // Fetch injuries with player join (injuries table doesn't have player_name etc directly)
      const { data, error: injErr } = await supabase
        .from(dbTable("injuries"))
        .select(`
          player_id, status, injury_type, date_injured, expected_return, games_missed,
          player:${dbTable("players")}!inner(
            player_name, slug, position, headshot_url, is_star, is_starter,
            team:${dbTable("teams")}!inner(team_name, league:${dbTable("leagues")}(slug))
          )
        `)
        .in("player_id", playerIds)
        .order("date_injured", { ascending: false });

      console.log("[TrackedPlayers] Injuries found:", data?.length, "error:", injErr);

      // Flatten and deduplicate
      const seen = new Set<string>();
      const deduped: TrackedPlayerData[] = [];
      for (const row of data ?? []) {
        const p = (row as any).player;
        const t = p?.team;
        const l = t?.league;
        const slug = slugById[row.player_id] || p?.slug;
        if (slug && !seen.has(slug)) {
          seen.add(slug);
          deduped.push({
            player_slug: slug,
            player_name: p?.player_name ?? "",
            position: p?.position ?? "",
            team_name: t?.team_name ?? "",
            league_slug: l?.slug ?? "",
            headshot_url: p?.headshot_url ?? null,
            status: row.status,
            injury_type: row.injury_type,
            date_injured: row.date_injured,
            expected_return: row.expected_return,
            is_star: p?.is_star ?? false,
            is_starter: p?.is_starter ?? false,
            games_missed: row.games_missed,
          });
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
