const https = require("https");

const SB_URL = "https://pmjmcsrmxbhaukjgunfs.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBtam1jc3JteGJoYXVramd1bmZzIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjIyNjA4NiwiZXhwIjoyMDg3ODAyMDg2fQ.ISSbw1W_lzNxMS1CMdS849FDEAg_AuBBpJ6ijJaE5Wk";

function fetch(path) {
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
        console.log("Content-Range:", res.headers["content-range"]);
        try { resolve(JSON.parse(body)); } catch { resolve(body); }
      });
    }).on("error", reject);
  });
}

(async () => {
  // Check injuries table
  console.log("=== back_in_play_injuries ===");
  const inj = await fetch("back_in_play_injuries?select=player_id,status&league_slug=eq.nba&limit=3");
  console.log(inj);

  // Check game_logs count for NBA
  console.log("\n=== back_in_play_player_game_logs (NBA sample) ===");
  const gl = await fetch("back_in_play_player_game_logs?select=player_id,season&league_slug=eq.nba&limit=3");
  console.log(gl);

  // If we got game log player_ids, check if any have injuries
  if (Array.isArray(gl) && gl.length > 0) {
    const pid = gl[0].player_id;
    console.log("\n=== Injuries for game_log player", pid.substring(0,8), "===");
    const pi = await fetch("back_in_play_injuries?select=player_id,status,date_injured&player_id=eq." + pid + "&limit=5");
    console.log(pi);
  }
})();
