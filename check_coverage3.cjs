const https = require("https");
const SB_URL = "https://pmjmcsrmxbhaukjgunfs.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBtam1jc3JteGJoYXVramd1bmZzIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjIyNjA4NiwiZXhwIjoyMDg3ODAyMDg2fQ.ISSbw1W_lzNxMS1CMdS849FDEAg_AuBBpJ6ijJaE5Wk";

function sbGet(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(SB_URL + "/rest/v1/" + path);
    https.get({
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, Prefer: "count=exact" },
    }, r => {
      let b = ""; r.on("data", d => b += d);
      r.on("end", () => {
        const range = r.headers["content-range"];
        try { resolve({ data: JSON.parse(b), range }); } catch { resolve({ data: b, range }); }
      });
    }).on("error", reject);
  });
}

(async () => {
  const leagues = ["nba", "nfl", "nhl", "mlb", "premier-league"];

  // Get all distinct player_ids from game_logs per league
  for (const league of leagues) {
    const glPids = new Set();
    let offset = 0;
    while (true) {
      const { data } = await sbGet(`back_in_play_player_game_logs?league_slug=eq.${league}&select=player_id&limit=1000&offset=${offset}`);
      if (!Array.isArray(data) || data.length === 0) break;
      for (const r of data) glPids.add(r.player_id);
      if (data.length < 1000) break;
      offset += 1000;
      if (offset > 100000) break; // safety
    }

    // Get all distinct player_ids from injuries for this league
    const injPids = new Set();
    offset = 0;
    while (true) {
      const { data } = await sbGet(`back_in_play_injuries?league_slug=eq.${league}&select=player_id&limit=1000&offset=${offset}`);
      if (!Array.isArray(data) || data.length === 0) break;
      for (const r of data) injPids.add(r.player_id);
      if (data.length < 1000) break;
      offset += 1000;
      if (offset > 200000) break;
    }

    // Count returned injuries
    const retPids = new Set();
    offset = 0;
    while (true) {
      const { data } = await sbGet(`back_in_play_injuries?league_slug=eq.${league}&status=eq.returned&select=player_id&limit=1000&offset=${offset}`);
      if (!Array.isArray(data) || data.length === 0) break;
      for (const r of data) retPids.add(r.player_id);
      if (data.length < 1000) break;
      offset += 1000;
      if (offset > 200000) break;
    }

    let matchAll = 0;
    for (const pid of injPids) { if (glPids.has(pid)) matchAll++; }
    let matchRet = 0;
    for (const pid of retPids) { if (glPids.has(pid)) matchRet++; }

    console.log(`${league}:`);
    console.log(`  All injured players: ${matchAll}/${injPids.size} have game logs (${Math.round(matchAll/injPids.size*100)}%)`);
    console.log(`  Returned players:    ${matchRet}/${retPids.size} have game logs (${Math.round(matchRet/retPids.size*100)}%)`);
    console.log(`  Game log players:    ${glPids.size} distinct`);
  }
})();
