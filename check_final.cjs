const https = require("https");
const SB_URL = "https://pmjmcsrmxbhaukjgunfs.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBtam1jc3JteGJoYXVramd1bmZzIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjIyNjA4NiwiZXhwIjoyMDg3ODAyMDg2fQ.ISSbw1W_lzNxMS1CMdS849FDEAg_AuBBpJ6ijJaE5Wk";

function sbRpc(sql) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query: sql });
    const opts = {
      hostname: "pmjmcsrmxbhaukjgunfs.supabase.co",
      path: "/rest/v1/rpc/exec_sql",
      method: "POST",
      headers: {
        apikey: SB_KEY,
        Authorization: "Bearer " + SB_KEY,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = https.request(opts, (r) => {
      let b = "";
      r.on("data", (d) => (b += d));
      r.on("end", () => {
        try { resolve(JSON.parse(b)); } catch { resolve(b); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

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
  // Get injury return cases — count per league via the pipeline's view
  // The pipeline enriches cases with league info from the players table
  // Let's check: how many injuries have return_date set?
  const { range: retRange } = await sbGet("back_in_play_injuries?select=injury_id&return_date=not.is.null&limit=1");
  console.log("Injuries with return_date:", retRange);

  // Total injuries
  const { range: totalRange } = await sbGet("back_in_play_injuries?select=injury_id&limit=1");
  console.log("Total injuries:", totalRange);

  // How many unique players in game_logs?
  // Since we can't do COUNT(DISTINCT), let's just check a few specific players
  // and see if the pipeline's Phase 4 is getting data

  // Quick check: grab 10 injury records with return_date, look up their game logs
  const { data: injuries } = await sbGet("back_in_play_injuries?select=player_id,date_injured,return_date&return_date=not.is.null&limit=10");
  console.log("\nSample returned injuries:", injuries ? injuries.length : 0);

  if (Array.isArray(injuries)) {
    for (const inj of injuries.slice(0, 5)) {
      const { range: glRange } = await sbGet(`back_in_play_player_game_logs?select=game_date&player_id=eq.${inj.player_id}&limit=1`);
      console.log(`  Player ${inj.player_id.substring(0,8)} (injured ${inj.date_injured}, returned ${inj.return_date}): ${glRange || "no game logs"}`);
    }
  }

  // Game log counts by league
  for (const league of ["nba", "nfl", "nhl", "mlb", "premier-league"]) {
    const { range } = await sbGet(`back_in_play_player_game_logs?select=player_id&league_slug=eq.${league}&limit=1`);
    console.log(`Game logs ${league}: ${range}`);
  }
})();
