import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // Call the SQL function to refresh recovery stats
    const { error } = await supabase.rpc("back_in_play_refresh_recovery_stats");
    if (error) throw new Error(`Failed to refresh stats: ${error.message}`);

    // Fetch the updated stats
    const { data: stats, error: fetchErr } = await supabase
      .from("back_in_play_recovery_statistics")
      .select("*")
      .order("league_slug")
      .order("injury_type");
    if (fetchErr) throw new Error(`Failed to fetch stats: ${fetchErr.message}`);

    return new Response(
      JSON.stringify({ data: { stats, count: stats?.length ?? 0 }, error: null }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ data: null, error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
