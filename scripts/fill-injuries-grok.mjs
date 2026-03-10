#!/usr/bin/env node
/**
 * Back In Play — Comprehensive Historical Injury Fill (Grok/xAI)
 *
 * Generates injury data TEAM-BY-TEAM for every season from 2016–2025.
 * Uses Grok (xAI) API for realistic sports knowledge.
 *
 * Strategy: per-team generation avoids player name duplication and
 * ensures every franchise is represented uniformly.
 *
 * Usage:
 *   node scripts/fill-injuries-grok.mjs [options]
 *
 * Options:
 *   --league  nfl|nba|mlb|nhl|premier-league   (default: all)
 *   --from    2016   (default: 2016)
 *   --to      2025   (default: 2025)
 *   --min     300    skip team-season if already has >= min records
 *   --dry     dry run (print plan, no inserts)
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY || !OPENAI_API_KEY) {
  console.error("Missing env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const P = "back_in_play_";
const t = (n) => `${P}${n}`;

// ─── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const arg  = (f) => args.includes(f) ? args[args.indexOf(f) + 1] : null;

const DRY_RUN      = flag("--dry");
const LEAGUE_FILTER = arg("--league");
const FROM_YEAR    = parseInt(arg("--from") || "2016");
const TO_YEAR      = parseInt(arg("--to")   || "2025");
// Per-SEASON league min — skip season if already above this
const SEASON_MIN   = parseInt(arg("--min")  || "350");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── League configs ───────────────────────────────────────────────────────────
const LEAGUE_CONFIGS = {
  nfl: {
    name: "NFL",
    slug: "nfl",
    positions: ["QB","RB","WR","TE","OT","OG","C","DE","DT","LB","CB","S","K","P"],
    teams: [
      "Arizona Cardinals","Atlanta Falcons","Baltimore Ravens","Buffalo Bills",
      "Carolina Panthers","Chicago Bears","Cincinnati Bengals","Cleveland Browns",
      "Dallas Cowboys","Denver Broncos","Detroit Lions","Green Bay Packers",
      "Houston Texans","Indianapolis Colts","Jacksonville Jaguars","Kansas City Chiefs",
      "Las Vegas Raiders","Los Angeles Chargers","Los Angeles Rams","Miami Dolphins",
      "Minnesota Vikings","New England Patriots","New Orleans Saints","New York Giants",
      "New York Jets","Philadelphia Eagles","Pittsburgh Steelers","San Francisco 49ers",
      "Seattle Seahawks","Tampa Bay Buccaneers","Tennessee Titans","Washington Commanders",
    ],
    teamAliases: {
      "Las Vegas Raiders": ["Oakland Raiders"],
      "Los Angeles Rams": ["St. Louis Rams"],
      "Los Angeles Chargers": ["San Diego Chargers"],
      "Washington Commanders": ["Washington Redskins","Washington Football Team"],
    },
    season: (y) => ({ start: `${y}-09-01`, end: `${y+1}-02-15`, label: `${y}` }),
    targetPerSeason: 450,  // ~14 per team × 32 teams
    injuriesPerTeamBatch: 12,
  },
  nba: {
    name: "NBA",
    slug: "nba",
    positions: ["PG","SG","SF","PF","C"],
    teams: [
      "Atlanta Hawks","Boston Celtics","Brooklyn Nets","Charlotte Hornets","Chicago Bulls",
      "Cleveland Cavaliers","Dallas Mavericks","Denver Nuggets","Detroit Pistons",
      "Golden State Warriors","Houston Rockets","Indiana Pacers","Los Angeles Clippers",
      "Los Angeles Lakers","Memphis Grizzlies","Miami Heat","Milwaukee Bucks",
      "Minnesota Timberwolves","New Orleans Pelicans","New York Knicks","Oklahoma City Thunder",
      "Orlando Magic","Philadelphia 76ers","Phoenix Suns","Portland Trail Blazers",
      "Sacramento Kings","San Antonio Spurs","Toronto Raptors","Utah Jazz","Washington Wizards",
    ],
    teamAliases: {
      "Brooklyn Nets": ["New Jersey Nets"],
      "New Orleans Pelicans": ["New Orleans Hornets"],
      "Charlotte Hornets": ["Charlotte Bobcats"],
    },
    season: (y) => ({ start: `${y}-10-01`, end: `${y+1}-06-30`, label: `${y}-${String(y+1).slice(2)}` }),
    targetPerSeason: 550,
    injuriesPerTeamBatch: 18,
  },
  mlb: {
    name: "MLB",
    slug: "mlb",
    positions: ["SP","RP","CL","C","1B","2B","3B","SS","LF","CF","RF","DH"],
    teams: [
      "Arizona Diamondbacks","Atlanta Braves","Baltimore Orioles","Boston Red Sox",
      "Chicago Cubs","Chicago White Sox","Cincinnati Reds","Cleveland Guardians",
      "Colorado Rockies","Detroit Tigers","Houston Astros","Kansas City Royals",
      "Los Angeles Angels","Los Angeles Dodgers","Miami Marlins","Milwaukee Brewers",
      "Minnesota Twins","New York Mets","New York Yankees","Oakland Athletics",
      "Philadelphia Phillies","Pittsburgh Pirates","San Diego Padres","San Francisco Giants",
      "Seattle Mariners","St. Louis Cardinals","Tampa Bay Rays","Texas Rangers",
      "Toronto Blue Jays","Washington Nationals",
    ],
    teamAliases: {
      "Cleveland Guardians": ["Cleveland Indians"],
      "Oakland Athletics": ["Athletics"],
    },
    season: (y) => ({ start: `${y}-03-20`, end: `${y}-10-15`, label: `${y}` }),
    targetPerSeason: 450,  // ~15 per team × 30 teams
    injuriesPerTeamBatch: 14,
  },
  nhl: {
    name: "NHL",
    slug: "nhl",
    positions: ["C","LW","RW","D","G"],
    teams: [
      "Anaheim Ducks","Boston Bruins","Buffalo Sabres","Calgary Flames",
      "Carolina Hurricanes","Chicago Blackhawks","Colorado Avalanche","Columbus Blue Jackets",
      "Dallas Stars","Detroit Red Wings","Edmonton Oilers","Florida Panthers",
      "Los Angeles Kings","Minnesota Wild","Montreal Canadiens","Nashville Predators",
      "New Jersey Devils","New York Islanders","New York Rangers","Ottawa Senators",
      "Philadelphia Flyers","Pittsburgh Penguins","San Jose Sharks","Seattle Kraken",
      "St. Louis Blues","Tampa Bay Lightning","Toronto Maple Leafs","Vancouver Canucks",
      "Vegas Golden Knights","Washington Capitals","Winnipeg Jets","Arizona Coyotes",
    ],
    teamAliases: {
      "Arizona Coyotes": ["Phoenix Coyotes"],
    },
    season: (y) => ({ start: `${y}-10-01`, end: `${y+1}-06-30`, label: `${y}-${String(y+1).slice(2)}` }),
    targetPerSeason: 400,
    injuriesPerTeamBatch: 12,
  },
  "premier-league": {
    name: "Premier League",
    slug: "premier-league",
    positions: ["GK","CB","LB","RB","CDM","CM","CAM","LW","RW","ST","CF"],
    // Top teams + promoted sides. Some rotate; use stable core set + extras.
    teams: [
      "Arsenal","Aston Villa","Bournemouth","Brentford","Brighton & Hove Albion",
      "Chelsea","Crystal Palace","Everton","Fulham","Leeds United",
      "Leicester City","Liverpool","Manchester City","Manchester United","Newcastle United",
      "Nottingham Forest","Southampton","Tottenham Hotspur","West Ham United","Wolverhampton Wanderers",
    ],
    teamAliases: {},
    season: (y) => ({ start: `${y}-08-01`, end: `${y+1}-05-31`, label: `${y}-${String(y+1).slice(2)}` }),
    targetPerSeason: 350,
    injuriesPerTeamBatch: 17,
  },
};

// ─── Injury types ──────────────────────────────────────────────────────────────
const INJURY_TYPES = [
  "ACL Tear","Hamstring","Ankle Sprain","Knee","Shoulder","Back","Concussion",
  "Groin","Calf","Hip","Wrist","Elbow","Quad","Foot","Achilles","Thumb",
  "Rib","Hand","Fracture","Torn Muscle",
];

// ─── OpenAI API ───────────────────────────────────────────────────────────────
async function callGrok(messages, retries = 4) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages,
          temperature: 0.8,
          max_tokens: 4000,
          response_format: { type: "json_object" },
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        if (res.status === 429) {
          const wait = Math.min(90000, 15000 * attempt);
          process.stdout.write(` [rate:${Math.round(wait/1000)}s]`);
          await sleep(wait);
          continue;
        }
        throw new Error(`OpenAI HTTP ${res.status}: ${body.slice(0, 200)}`);
      }

      const json = await res.json();
      const raw  = json.choices?.[0]?.message?.content?.trim() || "{}";

      let parsed;
      try {
        const obj = JSON.parse(raw);
        parsed = Array.isArray(obj)
          ? obj
          : (obj.injuries || obj.records || obj.data || Object.values(obj).find(Array.isArray) || []);
      } catch {
        const s = raw.indexOf("["), e = raw.lastIndexOf("]");
        if (s !== -1 && e !== -1) {
          try { parsed = JSON.parse(raw.slice(s, e + 1)); }
          catch { parsed = []; }
        } else { parsed = []; }
      }

      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      if (attempt === retries) throw err;
      process.stdout.write(` [retry${attempt}]`);
      await sleep(4000 * attempt);
    }
  }
  return [];
}

// ─── Generate injuries for ONE team in ONE season ─────────────────────────────
async function generateTeamInjuries(league, teamName, year, count, existingPlayers) {
  const { start, end, label } = league.season(year);
  const avoid = existingPlayers.length > 0
    ? `\nDo NOT use these player names (already in DB): ${existingPlayers.slice(-30).join(", ")}.`
    : "";

  const systemPrompt = `You are an expert sports injury historian with comprehensive knowledge of ${league.name} player injuries from 2015-2026, including data from Spotrac injured-reserve lists, Baseball Reference IL data, CapFriendly NHL injury records, and Transfermarkt Premier League injury data. Generate accurate, realistic historical injury records based on your training knowledge.`;

  const userPrompt = `Generate exactly ${count} real player injury records for the ${teamName} (${league.name}) during the ${label} season (${start} to ${end}).

These should reflect actual IR/IL/injured-list placements documented on official sources.
${avoid}

Return JSON: {"injuries": [array of ${count} records]}

Each record must have:
- player_name: real ${teamName} player from that era (first + last name)
- position: one of ${league.positions.join(", ")}
- injury_type: EXACTLY one of: ${INJURY_TYPES.join("|")}
- injury_type_slug: kebab-case of injury_type
- injury_description: 1-2 sentences describing the injury and circumstances
- date_injured: YYYY-MM-DD (must be between ${start} and ${end})
- return_date: YYYY-MM-DD when player returned to play (or null if season/career-ending)
- recovery_days: integer days from injury to return (or null)
- games_missed: integer games missed (or null)
- status: "returned" if they came back same season, "out" if season/career-ending

Recovery time ranges (use realistic values):
ACL Tear: 270-380d | Achilles: 180-270d | Fracture: 45-120d | Torn Muscle: 90-180d
Knee: 21-90d | Shoulder: 21-90d | Hamstring: 14-42d | Ankle Sprain: 7-35d
Back: 14-56d | Concussion: 7-21d | Elbow: 14-75d | Hip: 14-60d | Foot: 14-60d
Wrist: 14-45d | Groin: 14-42d | Quad: 14-35d | Calf: 10-28d | Rib: 10-35d
Hand: 10-35d | Thumb: 10-28d

Include a realistic mix: ~20% season-ending (ACL, Achilles, Fracture, Tommy John) and ~80% shorter-term injuries.`;

  return callGrok([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ]);
}

// ─── DB helpers ───────────────────────────────────────────────────────────────
const leagueCache  = {};
const teamCache    = {};
const playerCache  = {};

async function ensureLeague(league) {
  if (leagueCache[league.slug]) return leagueCache[league.slug];
  const { data, error } = await supabase
    .from(t("leagues"))
    .upsert({ league_name: league.name, slug: league.slug }, { onConflict: "slug" })
    .select("league_id")
    .single();
  if (error) throw new Error(`League upsert ${league.slug}: ${error.message}`);
  leagueCache[league.slug] = data.league_id;
  return data.league_id;
}

async function ensureTeam(teamName, leagueId, leagueSlug) {
  const key = `${teamName}__${leagueSlug}`;
  if (teamCache[key]) return teamCache[key];
  const { data, error } = await supabase
    .from(t("teams"))
    .upsert({ team_name: teamName, league_id: leagueId }, { onConflict: "team_name,league_id" })
    .select("team_id")
    .single();
  if (error) throw new Error(`Team upsert ${teamName}: ${error.message}`);
  teamCache[key] = data.team_id;
  return data.team_id;
}

async function ensurePlayer(playerName, teamId, position, leagueSlug) {
  const baseSlug = playerName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const slug     = `${baseSlug}-${leagueSlug}`;
  if (playerCache[slug]) return { id: playerCache[slug], slug };

  // Check if player exists first
  const { data: existing } = await supabase
    .from(t("players"))
    .select("player_id")
    .eq("slug", slug)
    .maybeSingle();

  if (existing) {
    playerCache[slug] = existing.player_id;
    return { id: existing.player_id, slug };
  }

  const { data, error } = await supabase
    .from(t("players"))
    .insert({ player_name: playerName, team_id: teamId, position: position || "?", slug })
    .select("player_id")
    .single();

  if (error) {
    // Race condition — try to fetch again
    const { data: retry } = await supabase
      .from(t("players"))
      .select("player_id")
      .eq("slug", slug)
      .maybeSingle();
    if (retry) {
      playerCache[slug] = retry.player_id;
      return { id: retry.player_id, slug };
    }
    return null;
  }

  playerCache[slug] = data.player_id;
  return { id: data.player_id, slug };
}

function normalizeRecord(rec, league, year) {
  if (!rec?.player_name || !rec?.date_injured) return null;

  const { start, end } = league.season(year);
  if (rec.date_injured < start || rec.date_injured > end) return null;

  let injType = rec.injury_type || "Knee";
  const VALID = new Set(INJURY_TYPES);
  if (!VALID.has(injType)) {
    const lc = injType.toLowerCase();
    if (lc.includes("acl"))                      injType = "ACL Tear";
    else if (lc.includes("achilles"))            injType = "Achilles";
    else if (lc.includes("hamstring"))           injType = "Hamstring";
    else if (lc.includes("ankle"))               injType = "Ankle Sprain";
    else if (lc.includes("knee") || lc.includes("meniscus") || lc.includes("mcl") || lc.includes("pcl")) injType = "Knee";
    else if (lc.includes("shoulder") || lc.includes("rotator") || lc.includes("labrum"))  injType = "Shoulder";
    else if (lc.includes("back") || lc.includes("lumbar") || lc.includes("spine"))        injType = "Back";
    else if (lc.includes("concussion") || lc.includes("head") || lc.includes("brain"))    injType = "Concussion";
    else if (lc.includes("groin") || lc.includes("adductor"))                             injType = "Groin";
    else if (lc.includes("calf") || lc.includes("gastrocnemius"))                         injType = "Calf";
    else if (lc.includes("hip") || lc.includes("flexor"))                                 injType = "Hip";
    else if (lc.includes("wrist"))               injType = "Wrist";
    else if (lc.includes("elbow") || lc.includes("ucl") || lc.includes("tommy john"))     injType = "Elbow";
    else if (lc.includes("quad") || lc.includes("quadricep"))                             injType = "Quad";
    else if (lc.includes("foot") || lc.includes("plantar") || lc.includes("jones") || lc.includes("lisfranc")) injType = "Foot";
    else if (lc.includes("thumb"))               injType = "Thumb";
    else if (lc.includes("rib"))                 injType = "Rib";
    else if (lc.includes("hand") || lc.includes("finger"))                                injType = "Hand";
    else if (lc.includes("fracture") || lc.includes("broken") || lc.includes("stress"))  injType = "Fracture";
    else if (lc.includes("torn") || lc.includes("tear") || lc.includes("rupture") || lc.includes("strain")) injType = "Torn Muscle";
    else injType = "Knee";
  }

  const slug = injType.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");

  let returnDate = rec.return_date || null;
  if (returnDate && returnDate <= rec.date_injured) returnDate = null;

  const recovDays = rec.recovery_days ? Math.abs(Math.round(Number(rec.recovery_days))) || null : null;

  // Reasonable bounds check on recovery days
  const maxRecov = { "ACL Tear": 420, Achilles: 365, Fracture: 180, "Torn Muscle": 270,
    Knee: 180, Shoulder: 180, Hamstring: 90, "Ankle Sprain": 60, Back: 120,
    Concussion: 60, Elbow: 150, Hip: 120, Foot: 120, Wrist: 90, Groin: 90,
    Quad: 60, Calf: 60, Rib: 60, Hand: 60, Thumb: 42 };
  const minRecov = { "ACL Tear": 200, Achilles: 120, Fracture: 21, "Torn Muscle": 30,
    Knee: 7, Shoulder: 7, Hamstring: 5, "Ankle Sprain": 3, Back: 3,
    Concussion: 3, Elbow: 7, Hip: 7, Foot: 7, Wrist: 5, Groin: 5,
    Quad: 5, Calf: 3, Rib: 5, Hand: 5, Thumb: 5 };

  let finalRecov = recovDays;
  if (finalRecov !== null) {
    const mx = maxRecov[injType] || 300;
    const mn = minRecov[injType] || 3;
    if (finalRecov > mx) finalRecov = mx;
    if (finalRecov < mn) finalRecov = mn;
  }

  const status = returnDate && returnDate < "2026-03-01" ? "returned" : (rec.status || "out");

  return {
    injury_type:           injType,
    injury_type_slug:      slug,
    injury_description:    (rec.injury_description || `${injType} injury sustained during play.`).slice(0, 500),
    date_injured:          rec.date_injured,
    expected_return_date:  returnDate,
    expected_recovery_range: finalRecov
      ? `${Math.round(finalRecov * 0.85)}–${Math.round(finalRecov * 1.15)} days`
      : null,
    status,
  };
}

// ─── Get existing injuries for a league season ────────────────────────────────
async function getSeasonInjuryCount(leagueId, start, end) {
  // Get all teams for league
  const { data: teams } = await supabase.from(t("teams")).select("team_id").eq("league_id", leagueId);
  if (!teams?.length) return 0;
  const tids = teams.map((r) => r.team_id);

  // Get all players for those teams
  let pids = [];
  for (let i = 0; i < tids.length; i += 50) {
    const { data: players } = await supabase
      .from(t("players")).select("player_id").in("team_id", tids.slice(i, i + 50));
    pids = pids.concat((players || []).map((r) => r.player_id));
  }
  if (!pids.length) return 0;

  let total = 0;
  for (let i = 0; i < pids.length; i += 200) {
    const { count } = await supabase
      .from(t("injuries"))
      .select("injury_id", { count: "exact", head: true })
      .gte("date_injured", start)
      .lte("date_injured", end)
      .in("player_id", pids.slice(i, i + 200));
    total += count ?? 0;
  }
  return total;
}

// Get players already in DB for a team
async function getTeamPlayers(teamId) {
  const { data } = await supabase
    .from(t("players"))
    .select("player_name")
    .eq("team_id", teamId);
  return (data || []).map((r) => r.player_name);
}

// ─── Insert records for a team ────────────────────────────────────────────────
async function insertTeamRecords(records, league, teamId, teamName, year) {
  let inserted = 0;

  for (const rec of records) {
    try {
      const norm = normalizeRecord(rec, league, year);
      if (!norm) continue;

      const playerInfo = await ensurePlayer(
        rec.player_name,
        teamId,
        rec.position,
        league.slug
      );
      if (!playerInfo) continue;

      const { error } = await supabase.from(t("injuries")).insert({
        player_id: playerInfo.id,
        ...norm,
      });

      if (!error) inserted++;
    } catch {
      // silent skip
    }
  }

  return inserted;
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const leagues = Object.values(LEAGUE_CONFIGS).filter(
    (l) => !LEAGUE_FILTER || l.slug === LEAGUE_FILTER
  );
  const years = Array.from({ length: TO_YEAR - FROM_YEAR + 1 }, (_, i) => FROM_YEAR + i);

  console.log("🏥 Back In Play — Historical Injury Fill (GPT-4o-mini)");
  console.log("=".repeat(65));
  console.log(`  Leagues : ${leagues.map((l) => l.slug).join(", ")}`);
  console.log(`  Seasons : ${FROM_YEAR}–${TO_YEAR}`);
  console.log(`  Season min: ${SEASON_MIN} (skip season if already at/above)`);
  console.log(`  Dry run : ${DRY_RUN}`);
  console.log();

  let grandTotal = 0;

  for (const league of leagues) {
    console.log("─".repeat(65));
    console.log(`🏆 ${league.name}`);
    let leagueTotal = 0;

    // Ensure league exists in DB
    const leagueId = await ensureLeague(league);

    for (const year of years) {
      const { start, end, label } = league.season(year);
      const existing = await getSeasonInjuryCount(leagueId, start, end);

      if (existing >= SEASON_MIN) {
        console.log(`  ${label}  ✓ skip (${existing} records)`);
        continue;
      }

      const needed = league.targetPerSeason - existing;
      console.log(`  ${label}  ${existing} exist → target ${league.targetPerSeason}, need ~${needed}`);

      if (DRY_RUN) continue;

      let seasonInserted = 0;

      // ── Team-by-team generation ─────────────────────────────────────────────
      for (const teamName of league.teams) {
        const teamId = await ensureTeam(teamName, leagueId, league.slug);
        const existingPlayers = await getTeamPlayers(teamId);

        process.stdout.write(`    ${teamName.padEnd(32)} → `);

        const count = league.injuriesPerTeamBatch;

        try {
          const records = await generateTeamInjuries(league, teamName, year, count, existingPlayers);
          const ins     = await insertTeamRecords(records, league, teamId, teamName, year);
          process.stdout.write(`+${ins}\n`);
          seasonInserted += ins;
        } catch (err) {
          process.stdout.write(`ERR: ${err.message?.slice(0, 50)}\n`);
        }

        // Rate limit: small pause between teams
        await sleep(700);
      }

      console.log(`  └─ ${label} total inserted: +${seasonInserted} (now ~${existing + seasonInserted})`);
      leagueTotal += seasonInserted;
      grandTotal  += seasonInserted;

      // Pause between seasons
      await sleep(3000);
    }

    console.log(`  └─ ${league.name} TOTAL inserted this run: +${leagueTotal}\n`);
  }

  console.log("═".repeat(65));
  console.log(`✅  Total inserted this run: ${grandTotal}`);

  const { count: finalCount } = await supabase
    .from(t("injuries")).select("*", { count: "exact", head: true });
  console.log(`📦  Total injuries in DB:    ${finalCount ?? "?"}`);

  // Per-league breakdown
  console.log("\n📊 Final per-league counts:");
  for (const league of Object.values(LEAGUE_CONFIGS)) {
    const lid = leagueCache[league.slug];
    if (!lid) continue;
    const { data: tRows } = await supabase.from(t("teams")).select("team_id").eq("league_id", lid);
    const tids = (tRows || []).map((r) => r.team_id);
    if (!tids.length) continue;
    let pids = [];
    for (let i = 0; i < tids.length; i += 50) {
      const { data: pRows } = await supabase.from(t("players")).select("player_id").in("team_id", tids.slice(i, i + 50));
      pids = pids.concat((pRows || []).map((r) => r.player_id));
    }
    const { count } = await supabase.from(t("injuries"))
      .select("*", { count: "exact", head: true }).in("player_id", pids);
    console.log(`  ${league.name.padEnd(20)} ${(count ?? 0).toLocaleString()} injuries`);
  }

  console.log("\n🎉 Done!");
}

main().catch((err) => {
  console.error("\n💥 Fatal:", err.message);
  process.exit(1);
});
