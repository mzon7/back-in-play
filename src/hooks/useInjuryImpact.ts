import { useQuery } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import type { PlayerPageData } from "./usePlayerPage";

export interface ImpactPlayer {
  player_name: string;
  slug: string;
  opportunity: string;
}

const SIGNIFICANT_STATUSES = new Set([
  "out", "ir", "injured_reserve", "long_term", "doubtful", "suspended",
]);

/** Case-insensitive check: does `pos` match any of the `candidates`? */
function posMatches(pos: string, candidates: string[]): boolean {
  const p = pos.toLowerCase().trim();
  return candidates.some((c) => c.toLowerCase() === p);
}

/** Return the set of related positions that could replace `position` in `league`. */
function getRelatedPositions(position: string, league: string): string[] {
  const pos = position.toLowerCase().trim();

  if (league === "nfl") {
    if (pos === "qb" || pos.includes("quarterback")) return ["qb", "quarterback"];
    if (pos === "rb" || pos === "fb" || pos.includes("running") || pos.includes("fullback")) return ["rb", "fb", "running back", "fullback"];
    if (pos === "wr" || pos.includes("wide")) return ["wr", "wide receiver"];
    if (pos === "te" || pos.includes("tight")) return ["te", "tight end"];
    return [pos];
  }

  if (league === "nba") {
    if (["pg", "point guard"].includes(pos)) return ["pg", "sg", "point guard", "shooting guard", "guard"];
    if (["sg", "shooting guard"].includes(pos)) return ["sg", "pg", "shooting guard", "point guard", "guard"];
    if (["sf", "small forward"].includes(pos)) return ["sf", "pf", "small forward", "power forward", "forward"];
    if (["pf", "power forward"].includes(pos)) return ["pf", "sf", "c", "power forward", "small forward", "center", "forward"];
    if (["c", "center"].includes(pos)) return ["c", "pf", "center", "power forward"];
    if (pos === "guard" || pos === "g") return ["pg", "sg", "guard", "point guard", "shooting guard", "g"];
    if (pos === "forward" || pos === "f") return ["sf", "pf", "forward", "small forward", "power forward", "f"];
    return [pos];
  }

  if (league === "mlb") {
    if (pos.includes("pitcher") || pos === "sp" || pos === "rp") return ["pitcher", "sp", "rp", "starting pitcher", "relief pitcher"];
    if (pos.includes("catcher") || pos === "c") return ["catcher", "c"];
    if (["1b", "2b", "3b", "ss"].includes(pos) || pos.includes("baseman") || pos.includes("shortstop"))
      return ["1b", "2b", "3b", "ss", "first baseman", "second baseman", "third baseman", "shortstop", "infielder", "utility"];
    if (["lf", "cf", "rf"].includes(pos) || pos.includes("outfield") || pos.includes("fielder"))
      return ["lf", "cf", "rf", "outfielder", "left fielder", "center fielder", "right fielder"];
    if (pos.includes("designated") || pos === "dh") return ["dh", "designated hitter"];
    return [pos];
  }

  if (league === "nhl") {
    if (["center", "c", "left wing", "lw", "right wing", "rw", "forward", "f"].some((p) => pos === p || pos.includes(p)))
      return ["center", "c", "left wing", "lw", "right wing", "rw", "forward", "f"];
    if (pos.includes("defense") || pos === "d") return ["defenseman", "d", "defense"];
    if (pos.includes("goalt") || pos.includes("goalie") || pos === "g") return ["goaltender", "g", "goalie"];
    return [pos];
  }

  if (league === "premier-league") {
    if (pos.includes("forward") || pos.includes("striker") || pos.includes("winger"))
      return ["forward", "striker", "winger", "attacker"];
    if (pos.includes("midfield")) return ["midfielder", "attacking midfielder", "defensive midfielder", "midfield"];
    if (pos.includes("defend") || pos.includes("back"))
      return ["defender", "center back", "centre back", "full back", "left back", "right back", "cb", "lb", "rb"];
    if (pos.includes("goal") || pos.includes("keeper")) return ["goalkeeper", "gk", "keeper"];
    return [pos];
  }

  return [pos];
}

/** Opportunity label based on injured player's position and league. */
function getOpportunity(position: string, league: string): string {
  const pos = position.toLowerCase().trim();

  if (league === "nfl") {
    if (pos === "qb" || pos.includes("quarterback")) return "passing duties";
    if (pos === "rb" || pos === "fb" || pos.includes("running") || pos.includes("fullback")) return "carries";
    if (pos === "wr" || pos.includes("wide")) return "targets";
    if (pos === "te" || pos.includes("tight")) return "targets";
    return "snaps";
  }
  if (league === "nba") {
    if (["c", "center"].includes(pos)) return "minutes & rebounds";
    if (["pg", "sg", "point guard", "shooting guard", "guard", "g"].some((p) => pos === p)) return "usage";
    return "minutes";
  }
  if (league === "mlb") {
    if (pos.includes("pitcher") || pos === "sp" || pos === "rp") return "rotation spot";
    return "at-bats";
  }
  if (league === "nhl") {
    if (pos.includes("goalt") || pos.includes("goalie") || pos === "g") return "starts";
    return "ice time";
  }
  if (league === "premier-league") {
    if (pos.includes("forward") || pos.includes("striker")) return "attacking role";
    if (pos.includes("goal") || pos.includes("keeper")) return "starts";
    return "minutes";
  }
  return "opportunity";
}

export function useInjuryImpact(player: PlayerPageData | null | undefined) {
  const currentStatus = player?.injuries[0]?.status;
  const shouldShow =
    !!player &&
    !!currentStatus &&
    SIGNIFICANT_STATUSES.has(currentStatus);

  return useQuery<ImpactPlayer[]>({
    queryKey: ["injury-impact", player?.player_id],
    enabled: shouldShow,
    queryFn: async () => {
      if (!player) return [];

      const relatedPos = getRelatedPositions(player.position, player.league_slug);

      // Fetch all teammates — filter position client-side for robustness
      const { data: teammates } = await supabase
        .from("back_in_play_players")
        .select("player_name, slug, position, is_star, is_starter")
        .eq("team_id", player.team_id)
        .neq("player_id", player.player_id)
        .not("slug", "is", null)
        .order("is_star", { ascending: false })
        .order("is_starter", { ascending: false })
        .limit(100);

      if (!teammates || teammates.length === 0) return [];

      // Filter to matching positions
      const matched = teammates.filter(
        (t) => t.position && posMatches(t.position, relatedPos)
      );

      const opportunity = getOpportunity(player.position, player.league_slug);

      return matched.slice(0, 3).map((t) => ({
        player_name: t.player_name,
        slug: t.slug!,
        opportunity,
      }));
    },
    staleTime: 5 * 60 * 1000,
  });
}
