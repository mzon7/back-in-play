const https = require("https");

const SB_URL = "https://pmjmcsrmxbhaukjgunfs.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBtam1jc3JteGJoYXVramd1bmZzIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjIyNjA4NiwiZXhwIjoyMDg3ODAyMDg2fQ.ISSbw1W_lzNxMS1CMdS849FDEAg_AuBBpJ6ijJaE5Wk";

function sbGet(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(SB_URL + "/rest/v1/" + path);
    const opts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, Prefer: "count=exact" },
    };
    https.get(opts, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        const range = res.headers["content-range"];
        try { resolve({ data: JSON.parse(body), range }); } catch { resolve({ data: body, range }); }
      });
    }).on("error", reject);
  });
}

async function getAllPaged(path, selectCol) {
  const set = new Set();
  let offset = 0;
  const PAGE = 1000;
  while (true) {
    const { data } = await sbGet(path + `&select=${selectCol}&limit=${PAGE}&offset=${offset}`);
    if (!Array.isArray(data) || data.length === 0) break;
    for (const r of data) set.add(r[selectCol]);
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return set;
}

(async () => {
  const leagues = ["nba", "nfl", "nhl", "mlb", "premier-league"];

  for (const league of leagues) {
    // Count players in this league
    const { range: playerRange } = await sbGet(`back_in_play_players?league_slug=eq.${league}&select=player_id&limit=1`);
    const totalPlayers = playerRange ? parseInt(playerRange.split("/")[1]) : "?";

    // Count game log rows for this league
    const { range: glRange } = await sbGet(`back_in_play_player_game_logs?league_slug=eq.${league}&select=player_id&limit=1`);
    const totalGL = glRange ? parseInt(glRange.split("/")[1]) : "?";

    // Get distinct player_ids from game_logs for this league (sample approach)
    // Just use SQL RPC if available, otherwise estimate from count
    console.log(`${league}: ${totalPlayers} players, ${totalGL} game log rows`);
  }

  // Now do the actual coverage check using a JOIN-like approach
  // For each league, get all player_ids from players table and check how many exist in game_logs
  console.log("\n--- Coverage check ---");
  for (const league of leagues) {
    const playerIds = await getAllPaged(`back_in_play_players?league_slug=eq.${league}`, "player_id");

    // Check in batches which player_ids have game logs
    const pids = [...playerIds];
    let withLogs = 0;
    const BATCH = 100;
    for (let i = 0; i < pids.length; i += BATCH) {
      const batch = pids.slice(i, i + BATCH);
      const idsStr = batch.join(",");
      const { data } = await sbGet(`back_in_play_player_game_logs?player_id=in.(${idsStr})&select=player_id&limit=1000`);
      if (Array.isArray(data)) {
        const found = new Set(data.map(r => r.player_id));
        withLogs += found.size;
      }
    }

    const pct = Math.round(withLogs / playerIds.size * 100);
    console.log(`${league}: ${withLogs}/${playerIds.size} injured players have game logs (${pct}%)`);
  }
})();
