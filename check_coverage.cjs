const { createClient } = require("@supabase/supabase-js");
const sb = createClient("https://pmjmcsrmxbhaukjgunfs.supabase.co", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBtam1jc3JteGJoYXVramd1bmZzIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjIyNjA4NiwiZXhwIjoyMDg3ODAyMDg2fQ.ISSbw1W_lzNxMS1CMdS849FDEAg_AuBBpJ6ijJaE5Wk");

async function countDistinct(table, col, filter) {
  // Use the REST API to get distinct player_ids
  let all = new Set();
  let offset = 0;
  const LIMIT = 1000;
  while (true) {
    let q = sb.from(table).select(col).range(offset, offset + LIMIT - 1);
    if (filter) {
      for (const [k, v] of Object.entries(filter)) {
        q = q.eq(k, v);
      }
    }
    const { data } = await q;
    if (!data || data.length === 0) break;
    for (const row of data) all.add(row[col]);
    if (data.length < LIMIT) break;
    offset += LIMIT;
  }
  return all;
}

(async () => {
  const leagues = ["nba", "nfl", "nhl", "mlb", "premier-league"];

  for (const league of leagues) {
    // Get distinct player_ids with game logs for this league
    const glPlayers = await countDistinct("back_in_play_player_game_logs", "player_id", { league_slug: league });

    // Get distinct player_ids with injuries in this league (through players table)
    // First get players in this league
    let injuredPlayers = new Set();
    let offset = 0;
    while (true) {
      const { data } = await sb.from("back_in_play_players")
        .select("player_id")
        .eq("league_slug", league)
        .range(offset, offset + 999);
      if (!data || data.length === 0) break;
      for (const r of data) injuredPlayers.add(r.player_id);
      if (data.length < 1000) break;
      offset += 1000;
    }

    // How many injured players have game logs?
    let matched = 0;
    for (const pid of injuredPlayers) {
      if (glPlayers.has(pid)) matched++;
    }

    console.log(`${league}: ${matched}/${injuredPlayers.size} players have game logs (${Math.round(matched/injuredPlayers.size*100)}%) | ${glPlayers.size} distinct players in game_logs`);
  }
})();
