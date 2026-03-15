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
  // 1. Get league_id -> slug mapping
  const { data: leagues } = await sbGet("back_in_play_leagues?select=league_id,slug");
  const leagueMap = {};
  for (const l of leagues) leagueMap[l.league_id] = l.slug;
  console.log("League mapping:", leagueMap);

  // 2. Build player -> league_slug mapping from players table
  const playerLeague = {};
  let offset = 0;
  while (true) {
    const { data } = await sbGet(`back_in_play_players?select=player_id,league_id&limit=1000&offset=${offset}`);
    if (!Array.isArray(data) || data.length === 0) break;
    for (const p of data) playerLeague[p.player_id] = leagueMap[p.league_id];
    if (data.length < 1000) break;
    offset += 1000;
  }
  console.log("Total players loaded:", Object.keys(playerLeague).length);

  // 3. Get all distinct player_ids from game_logs per league
  const glByLeague = { nba: new Set(), nfl: new Set(), nhl: new Set(), mlb: new Set(), "premier-league": new Set() };
  for (const league of Object.keys(glByLeague)) {
    offset = 0;
    while (true) {
      const { data } = await sbGet(`back_in_play_player_game_logs?league_slug=eq.${league}&select=player_id&limit=1000&offset=${offset}`);
      if (!Array.isArray(data) || data.length === 0) break;
      for (const r of data) glByLeague[league].add(r.player_id);
      if (data.length < 1000) break;
      offset += 1000;
      if (offset > 200000) break;
    }
    console.log(`Game logs: ${league} has ${glByLeague[league].size} distinct players`);
  }

  // 4. Get injured player_ids with return_date (the ones we need for performance curves)
  const injByLeague = { nba: new Set(), nfl: new Set(), nhl: new Set(), mlb: new Set(), "premier-league": new Set() };
  offset = 0;
  while (true) {
    const { data } = await sbGet(`back_in_play_injuries?select=player_id&not.return_date=is.null&limit=1000&offset=${offset}`);
    if (!Array.isArray(data) || data.length === 0) break;
    for (const r of data) {
      const league = playerLeague[r.player_id];
      if (league && injByLeague[league]) injByLeague[league].add(r.player_id);
    }
    if (data.length < 1000) break;
    offset += 1000;
    if (offset > 200000) break;
  }

  // 5. Coverage
  console.log("\n=== COVERAGE ===");
  for (const league of Object.keys(glByLeague)) {
    const inj = injByLeague[league];
    const gl = glByLeague[league];
    let matched = 0;
    for (const pid of inj) { if (gl.has(pid)) matched++; }
    const pct = inj.size > 0 ? Math.round(matched / inj.size * 100) : 0;
    console.log(`${league}: ${matched}/${inj.size} returned-injury players have game logs (${pct}%)`);
  }
})();
