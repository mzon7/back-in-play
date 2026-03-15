const { createClient } = require("@supabase/supabase-js");
const sb = createClient("https://pmjmcsrmxbhaukjgunfs.supabase.co", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBtam1jc3JteGJoYXVramd1bmZzIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjIyNjA4NiwiZXhwIjoyMDg3ODAyMDg2fQ.ISSbw1W_lzNxMS1CMdS849FDEAg_AuBBpJ6ijJaE5Wk");

(async () => {
  const { data: injuries } = await sb.from("back_in_play_injuries")
    .select("player_id, player_name, league_slug")
    .eq("league_slug", "nba")
    .not("return_date", "is", null)
    .limit(5);

  if (!injuries || injuries.length === 0) { console.log("No injuries found"); return; }

  for (const inj of injuries) {
    const { count } = await sb.from("back_in_play_player_game_logs")
      .select("*", { count: "exact", head: true })
      .eq("player_id", inj.player_id);
    console.log(inj.player_name, "(" + inj.player_id.substring(0,8) + "):", count, "game logs");
  }
})();
