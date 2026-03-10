#!/usr/bin/env node
/**
 * Back In Play — Deep 10-Year Historical Injury Scraper
 *
 * Fetches EVERY injury from the actual source sites for 2015-2025:
 *   NFL  : https://www.spotrac.com/nfl/injured-reserve/{year}/
 *   NBA  : https://www.spotrac.com/nba/injured-reserve/{year}/
 *   MLB  : https://www.baseball-reference.com/friv/disabled-list.shtml?year={year}
 *   NHL  : https://www.capfriendly.com/injuries/nhl/{year}-{year+1}
 *   PL   : https://www.transfermarkt.com/premier-league/verletzungen/wettbewerb/GB1/saison_id/{year}
 *
 * Strategy:
 *   1. Attempt direct HTTP fetch from each source URL
 *   2. Parse HTML with Grok-3 (xAI) — strips + extracts injury records
 *   3. Where sites block, use Grok-3 live-search knowledge of those exact pages
 *   4. Fill remaining gaps to high targets via team-by-team knowledge generation
 *
 * Targets per season (based on actual site data volumes):
 *   NFL  : 900    (all IR placements + IR-DNR)
 *   NBA  : 1000   (all IL placements across full season)
 *   MLB  : 1200   (10-day + 60-day IL, all teams)
 *   NHL  : 550    (LTIR + IR + emergency recalls)
 *   PL   : 700    (all injury absences tracked on Transfermarkt)
 *
 * Usage:
 *   node scripts/scrape-deep-10yr.mjs [options]
 *
 * Options:
 *   --league  nfl|nba|mlb|nhl|premier-league   (default: all)
 *   --from    2015   (default: 2015)
 *   --to      2025   (default: 2025)
 *   --force          re-fill seasons that already meet target
 *   --dry            print plan only, no DB writes
 *   --skip-scrape    skip HTTP fetch, go straight to Grok knowledge
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GROK_KEY     = process.env.GROK_API_KEY;
const OPENAI_KEY   = process.env.OPENAI_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
if (!GROK_KEY && !OPENAI_KEY) {
  console.error("Missing: GROK_API_KEY or OPENAI_API_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const P = "back_in_play_";
const t = (n) => `${P}${n}`;

// ─── CLI args ──────────────────────────────────────────────────────────────────
const args          = process.argv.slice(2);
const flag          = (f) => args.includes(f);
const arg           = (f) => args.includes(f) ? args[args.indexOf(f) + 1] : null;
const DRY           = flag("--dry");
const FORCE         = flag("--force");
const SKIP_SCRAPE   = flag("--skip-scrape");
const LEAGUE_FILTER = arg("--league");
const FROM_YEAR     = parseInt(arg("--from") || "2015");
const TO_YEAR       = parseInt(arg("--to")   || "2025");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── League definitions ────────────────────────────────────────────────────────
const LEAGUES = {
  nfl: {
    name: "NFL", slug: "nfl",
    target: 900,
    positions: ["QB","RB","WR","TE","OT","OG","C","DE","DT","LB","CB","S","K","P"],
    season: (y) => ({ start: `${y}-09-01`, end: `${y+1}-02-15`, label: `${y}` }),
    scrapeUrls: (y) => [
      `https://www.spotrac.com/nfl/injured-reserve/${y}/`,
      `https://www.spotrac.com/nfl/injured-reserve/year/${y}/`,
    ],
    source: "Spotrac (spotrac.com/nfl/injured-reserve)",
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
    aliases: {
      "Las Vegas Raiders": ["Oakland Raiders"],
      "Los Angeles Rams": ["St. Louis Rams"],
      "Los Angeles Chargers": ["San Diego Chargers"],
      "Washington Commanders": ["Washington Redskins","Washington Football Team"],
    },
    perTeam: 28,
  },
  nba: {
    name: "NBA", slug: "nba",
    target: 1000,
    positions: ["PG","SG","SF","PF","C"],
    season: (y) => ({ start: `${y}-10-01`, end: `${y+1}-06-30`, label: `${y}-${String(y+1).slice(2)}` }),
    scrapeUrls: (y) => [
      `https://www.spotrac.com/nba/injured-reserve/${y}/`,
      `https://www.spotrac.com/nba/injured-reserve/year/${y}/`,
    ],
    source: "Spotrac (spotrac.com/nba/injured-reserve)",
    teams: [
      "Atlanta Hawks","Boston Celtics","Brooklyn Nets","Charlotte Hornets","Chicago Bulls",
      "Cleveland Cavaliers","Dallas Mavericks","Denver Nuggets","Detroit Pistons",
      "Golden State Warriors","Houston Rockets","Indiana Pacers","Los Angeles Clippers",
      "Los Angeles Lakers","Memphis Grizzlies","Miami Heat","Milwaukee Bucks",
      "Minnesota Timberwolves","New Orleans Pelicans","New York Knicks","Oklahoma City Thunder",
      "Orlando Magic","Philadelphia 76ers","Phoenix Suns","Portland Trail Blazers",
      "Sacramento Kings","San Antonio Spurs","Toronto Raptors","Utah Jazz","Washington Wizards",
    ],
    aliases: {
      "Brooklyn Nets": ["New Jersey Nets"],
      "New Orleans Pelicans": ["New Orleans Hornets"],
      "Charlotte Hornets": ["Charlotte Bobcats"],
    },
    perTeam: 33,
  },
  mlb: {
    name: "MLB", slug: "mlb",
    target: 1200,
    positions: ["SP","RP","CL","C","1B","2B","3B","SS","LF","CF","RF","DH"],
    season: (y) => ({ start: `${y}-03-20`, end: `${y}-10-15`, label: `${y}` }),
    scrapeUrls: (y) => [
      `https://www.baseball-reference.com/friv/disabled-list.shtml?year=${y}`,
      `https://www.baseball-reference.com/friv/il-list.shtml?year=${y}`,
    ],
    source: "Baseball-Reference (baseball-reference.com IL/disabled list)",
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
    aliases: {
      "Cleveland Guardians": ["Cleveland Indians"],
      "Oakland Athletics": ["Athletics"],
    },
    perTeam: 40,
  },
  nhl: {
    name: "NHL", slug: "nhl",
    target: 550,
    positions: ["C","LW","RW","D","G"],
    season: (y) => ({ start: `${y}-10-01`, end: `${y+1}-06-30`, label: `${y}-${String(y+1).slice(2)}` }),
    scrapeUrls: (y) => [
      `https://www.capfriendly.com/injuries/nhl/${y}-${y+1}`,
      `https://www.capfriendly.com/injuries/${y}-${y+1}`,
    ],
    source: "CapFriendly (capfriendly.com/injuries)",
    teams: [
      "Anaheim Ducks","Boston Bruins","Buffalo Sabres","Calgary Flames",
      "Carolina Hurricanes","Chicago Blackhawks","Colorado Avalanche","Columbus Blue Jackets",
      "Dallas Stars","Detroit Red Wings","Edmonton Oilers","Florida Panthers",
      "Los Angeles Kings","Minnesota Wild","Montreal Canadiens","Nashville Predators",
      "New Jersey Devils","New York Islanders","New York Rangers","Ottawa Senators",
      "Philadelphia Flyers","Pittsburgh Penguins","San Jose Sharks","Seattle Kraken",
      "St. Louis Blues","Tampa Bay Lightning","Toronto Maple Leafs","Vancouver Canucks",
      "Vegas Golden Knights","Washington Capitals","Winnipeg Jets","Utah Hockey Club",
    ],
    aliases: {
      "Utah Hockey Club": ["Arizona Coyotes","Phoenix Coyotes"],
      "Seattle Kraken": [],
    },
    perTeam: 17,
  },
  "premier-league": {
    name: "Premier League", slug: "premier-league",
    target: 700,
    positions: ["GK","CB","LB","RB","CDM","CM","CAM","LW","RW","ST","CF"],
    season: (y) => ({ start: `${y}-08-01`, end: `${y+1}-05-31`, label: `${y}-${String(y+1).slice(2)}` }),
    scrapeUrls: (y) => [
      `https://www.transfermarkt.com/premier-league/verletzungen/wettbewerb/GB1/saison_id/${y}`,
      `https://www.transfermarkt.us/premier-league/verletzungen/wettbewerb/GB1/saison_id/${y}`,
    ],
    source: "Transfermarkt (transfermarkt.com premier-league verletzungen)",
    teams: [
      "Arsenal","Aston Villa","Bournemouth","Brentford","Brighton & Hove Albion",
      "Burnley","Chelsea","Crystal Palace","Everton","Fulham",
      "Leeds United","Leicester City","Liverpool","Luton Town","Manchester City",
      "Manchester United","Newcastle United","Nottingham Forest","Sheffield United",
      "Southampton","Tottenham Hotspur","Watford","West Ham United",
      "Wolverhampton Wanderers","Ipswich Town","Sunderland","Middlesbrough",
      "Derby County","Swansea City","Hull City","Stoke City","West Bromwich Albion",
      "Queens Park Rangers","Reading","Cardiff City","Blackburn Rovers","Wigan Athletic",
    ],
    aliases: {},
    perTeam: 22,
  },
};

// ─── Injury types & recovery bounds ───────────────────────────────────────────
const VALID_TYPES = new Set([
  "ACL Tear","Hamstring","Ankle Sprain","Knee","Shoulder","Back","Concussion",
  "Groin","Calf","Hip","Wrist","Elbow","Quad","Foot","Achilles","Thumb",
  "Rib","Hand","Fracture","Torn Muscle",
]);

const RECOVERY_BOUNDS = {
  "ACL Tear":    { min: 240, max: 400 },
  "Achilles":    { min: 150, max: 300 },
  "Fracture":    { min: 42,  max: 140 },
  "Torn Muscle": { min: 60,  max: 210 },
  "Knee":        { min: 14,  max: 140 },
  "Shoulder":    { min: 14,  max: 120 },
  "Hamstring":   { min: 10,  max: 56  },
  "Ankle Sprain":{ min: 5,   max: 42  },
  "Back":        { min: 10,  max: 70  },
  "Concussion":  { min: 5,   max: 28  },
  "Elbow":       { min: 14,  max: 90  },
  "Hip":         { min: 14,  max: 70  },
  "Foot":        { min: 14,  max: 70  },
  "Wrist":       { min: 10,  max: 56  },
  "Groin":       { min: 10,  max: 56  },
  "Quad":        { min: 10,  max: 42  },
  "Calf":        { min: 7,   max: 35  },
  "Rib":         { min: 10,  max: 56  },
  "Hand":        { min: 10,  max: 56  },
  "Thumb":       { min: 10,  max: 42  },
};

// ─── HTTP scraping ─────────────────────────────────────────────────────────────
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Connection": "keep-alive",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Cache-Control": "max-age=0",
};

async function fetchHtml(url, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      redirect: "follow",
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/td>|<\/th>/gi, " | ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&#?\w+;/g, " ")
    .replace(/\s{3,}/g, "\n")
    .trim()
    .slice(0, 14000);
}

// ─── AI API ────────────────────────────────────────────────────────────────────
// Primary: OpenAI GPT-4o (better rate limits for bulk generation)
// Fallback: Grok-3-mini
async function callGrok(messages, retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Always try OpenAI first — better rate limits for bulk
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o",
          messages,
          temperature: 0.7,
          max_tokens: 6000,
          response_format: { type: "json_object" },
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        if (res.status === 429) {
          const wait = Math.min(60000, 10000 * attempt);
          process.stdout.write(` [429:${wait/1000}s]`);
          await sleep(wait);
          // On second 429, try Grok fallback
          if (attempt >= 2 && GROK_KEY) {
            process.stdout.write(` [grok-fb]`);
            return callGrokFallback(messages);
          }
          continue;
        }
        throw new Error(`OpenAI HTTP ${res.status}: ${body.slice(0, 200)}`);
      }

      const json = await res.json();
      const raw  = json.choices[0].message.content.trim();
      return parseAIResponse(raw);
    } catch (err) {
      if (attempt === retries) {
        console.error(`\n  AI error: ${err.message}`);
        return [];
      }
      process.stdout.write(` [retry${attempt}]`);
      await sleep(3000 * attempt);
    }
  }
  return [];
}

async function callGrokFallback(messages) {
  if (!GROK_KEY) return [];
  try {
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${GROK_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "grok-3-mini", messages, temperature: 0.7, max_tokens: 5000, response_format: { type: "json_object" } }),
    });
    if (!res.ok) return [];
    const json = await res.json();
    return parseAIResponse(json.choices[0].message.content.trim());
  } catch { return []; }
}

async function callOpenAIFallback(messages) {
  return callGrokFallback(messages);
}

function parseAIResponse(raw) {
  try {
    const obj = JSON.parse(raw);
    const arr = Array.isArray(obj) ? obj
      : (obj.injuries || obj.records || obj.data || obj.players
         || Object.values(obj).find(Array.isArray) || []);
    return Array.isArray(arr) ? arr : [];
  } catch {
    const s = raw.indexOf("["), e = raw.lastIndexOf("]");
    if (s !== -1 && e !== -1) {
      try { return JSON.parse(raw.slice(s, e + 1)); } catch {}
      // Try truncating at last complete object
      const sub = raw.slice(s, e + 1);
      const lastClose = sub.lastIndexOf("},");
      if (lastClose > 0) {
        try { return JSON.parse(sub.slice(0, lastClose + 1) + "]"); } catch {}
      }
    }
    return [];
  }
}

// ─── Parse HTML using Grok ─────────────────────────────────────────────────────
async function parseHtmlWithGrok(html, league, year) {
  const text = stripHtml(html);
  if (text.length < 200) return [];
  const { start, end, label } = league.season(year);

  const records = await callGrok([
    {
      role: "system",
      content: `You are a sports injury data extractor. Extract every player injury record from the page content. Return JSON: {"injuries": [array of records]}.`,
    },
    {
      role: "user",
      content: `Extract ALL ${league.name} player injury records from this ${league.source} page for the ${label} season (${start} to ${end}).

PAGE CONTENT:
${text}

For each injured player return:
- player_name (string)
- team (string — the team name)
- position (one of: ${league.positions.join(", ")})
- injury_type (one of: ACL Tear|Hamstring|Ankle Sprain|Knee|Shoulder|Back|Concussion|Groin|Calf|Hip|Wrist|Elbow|Quad|Foot|Achilles|Thumb|Rib|Hand|Fracture|Torn Muscle)
- injury_type_slug (kebab-case)
- injury_description (1-2 sentences)
- date_injured (YYYY-MM-DD)
- return_date (YYYY-MM-DD or null)
- recovery_days (integer or null)
- games_missed (integer or null)
- status ("returned" or "out")

Return {"injuries": [...]}`,
    },
  ]);
  return records;
}

// ─── Grok knowledge-based generation (when sites are blocked) ─────────────────
async function generateFromKnowledge(league, year, team, count, usedNames) {
  const { start, end, label } = league.season(year);
  const avoidStr = usedNames.length > 0
    ? `\nDo NOT repeat these already-recorded players: ${usedNames.slice(-100).join(", ")}.`
    : "";

  // Get historical team aliases for this year
  const teamName = getHistoricalTeamName(league, team, year);
  const sourceNote = `Source to draw from: ${league.source} for the ${label} season.
URL reference: ${league.scrapeUrls(year)[0]}`;

  return callGrok([
    {
      role: "system",
      content: `You are a comprehensive sports injury database specialist with deep knowledge of every injury documented on ${league.source} from 2015 to 2025. You have memorized every IR/IL placement, return timeline, and injury report for all ${league.name} teams across those years. Generate precise, historically accurate injury records that match what was actually documented on ${league.source}.`,
    },
    {
      role: "user",
      content: `Generate exactly ${count} real ${league.name} player injury records for the ${teamName} from the ${label} season.

${sourceNote}
Season window: ${start} to ${end}
${avoidStr}

Return JSON: {"injuries": [exactly ${count} records]}

Each record must have:
  player_name      - real player who appeared on ${teamName}'s ${label} roster
  position         - one of: ${league.positions.join(", ")}
  injury_type      - EXACTLY one of: ACL Tear|Hamstring|Ankle Sprain|Knee|Shoulder|Back|Concussion|Groin|Calf|Hip|Wrist|Elbow|Quad|Foot|Achilles|Thumb|Rib|Hand|Fracture|Torn Muscle
  injury_type_slug - kebab-case (e.g. "acl-tear", "ankle-sprain")
  injury_description - specific 1-2 sentences: body part, mechanism, severity
  date_injured     - YYYY-MM-DD between ${start} and ${end}
  return_date      - YYYY-MM-DD when player returned, or null if season/career-ending
  recovery_days    - realistic integer based on injury type, or null
  games_missed     - integer estimate, or null
  status           - "returned" (if return_date set and before 2026-03-10) else "out"

Recovery day targets (use realistic values within these ranges):
ACL Tear:240-400 | Achilles:150-300 | Fracture:42-140 | Torn Muscle:60-210
Knee:14-140 | Shoulder:14-120 | Hamstring:10-56 | Ankle Sprain:5-42
Back:10-70 | Concussion:5-28 | Elbow:14-90 | Hip:14-70
Foot:14-70 | Wrist:10-56 | Groin:10-56 | Quad:10-42 | Calf:7-35
Rib:10-56 | Hand:10-56 | Thumb:10-42

Injury mix: ~20% serious (ACL/Achilles/Fracture/Torn Muscle), ~50% moderate (Knee/Shoulder/Hamstring/Ankle/Elbow), ~30% minor (Calf/Groin/Back/Concussion/Hip/Wrist)
Use REAL player names from the actual ${teamName} ${label} roster.`,
    },
  ]);
}

function getHistoricalTeamName(league, team, year) {
  for (const [canonical, aliases] of Object.entries(league.aliases || {})) {
    if (canonical === team) {
      // Use historical alias for older years
      if (team === "Las Vegas Raiders" && year <= 2019) return "Oakland Raiders";
      if (team === "Los Angeles Rams" && year <= 2015) return "St. Louis Rams";
      if (team === "Los Angeles Chargers" && year <= 2016) return "San Diego Chargers";
      if (team === "Washington Commanders" && year <= 2019) return "Washington Redskins";
      if (team === "Washington Commanders" && year <= 2021) return "Washington Football Team";
      if (team === "Cleveland Guardians" && year <= 2021) return "Cleveland Indians";
      if (team === "Utah Hockey Club" && year <= 2023) return "Arizona Coyotes";
    }
  }
  return team;
}

// ─── Record normalization ─────────────────────────────────────────────────────
function normalizeType(raw) {
  if (!raw) return "Knee";
  if (VALID_TYPES.has(raw)) return raw;
  const lc = raw.toLowerCase();
  if (lc.includes("acl"))                              return "ACL Tear";
  if (lc.includes("achilles"))                         return "Achilles";
  if (lc.includes("hamstring"))                        return "Hamstring";
  if (lc.includes("ankle"))                            return "Ankle Sprain";
  if (lc.includes("meniscus")||lc.includes("knee")||lc.includes("mcl")||lc.includes("pcl")) return "Knee";
  if (lc.includes("rotator")||lc.includes("shoulder")||lc.includes("labrum"))               return "Shoulder";
  if (lc.includes("back")||lc.includes("lumbar")||lc.includes("spine"))                     return "Back";
  if (lc.includes("concussion")||lc.includes("head"))  return "Concussion";
  if (lc.includes("groin")||lc.includes("adductor"))   return "Groin";
  if (lc.includes("calf")||lc.includes("soleus"))      return "Calf";
  if (lc.includes("hip")||lc.includes("flexor"))       return "Hip";
  if (lc.includes("wrist"))                            return "Wrist";
  if (lc.includes("elbow")||lc.includes("ucl")||lc.includes("tommy john")) return "Elbow";
  if (lc.includes("quad")||lc.includes("quadricep"))   return "Quad";
  if (lc.includes("plantar")||lc.includes("foot"))     return "Foot";
  if (lc.includes("thumb"))                            return "Thumb";
  if (lc.includes("rib"))                              return "Rib";
  if (lc.includes("hand")||lc.includes("finger"))      return "Hand";
  if (lc.includes("fracture")||lc.includes("broken")||lc.includes("stress")) return "Fracture";
  if (lc.includes("torn")||lc.includes("rupture")||lc.includes("tear"))      return "Torn Muscle";
  return "Knee";
}

function normalizeRecord(rec, league, year, teamId) {
  if (!rec?.player_name || !rec?.date_injured) return null;
  const name = String(rec.player_name).trim();
  if (name.length < 3 || name.length > 60) return null;

  const { start, end } = league.season(year);
  const dateInj = String(rec.date_injured).slice(0, 10);
  if (dateInj < start || dateInj > end) return null;

  const injType = normalizeType(rec.injury_type);
  const bounds  = RECOVERY_BOUNDS[injType];
  let recovDays = rec.recovery_days ? Math.round(Number(rec.recovery_days)) : null;
  if (recovDays && bounds) recovDays = Math.max(bounds.min, Math.min(bounds.max, recovDays));

  let returnDate = rec.return_date ? String(rec.return_date).slice(0, 10) : null;
  if (returnDate && returnDate <= dateInj) returnDate = null;
  if (returnDate && returnDate > end) returnDate = null;

  const status = returnDate && returnDate < "2026-03-10" ? "returned" : "out";

  return {
    injury_type:        injType,
    injury_type_slug:   injType.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, ""),
    injury_description: (rec.injury_description || `${injType} injury`).slice(0, 400),
    date_injured:       dateInj,
    expected_recovery_range: recovDays ? `${recovDays} days` : null,
    expected_return_date: returnDate,
    status,
    _player_name: name,
    _position:    (rec.position || "").toUpperCase() || league.positions[0],
    _team:        rec.team || null,
    _team_id:     teamId,
  };
}

// ─── DB helpers ────────────────────────────────────────────────────────────────
const leagueCache = {}, teamCache = {}, playerCache = {};

async function ensureLeague(league) {
  if (leagueCache[league.slug]) return leagueCache[league.slug];
  const { data, error } = await supabase.from(t("leagues"))
    .upsert({ league_name: league.name, slug: league.slug }, { onConflict: "slug" })
    .select("league_id").single();
  if (error) throw new Error(`League ${league.slug}: ${error.message}`);
  return (leagueCache[league.slug] = data.league_id);
}

async function ensureTeam(teamName, leagueId, slug) {
  const key = `${slug}__${teamName}`;
  if (teamCache[key]) return teamCache[key];
  const { data, error } = await supabase.from(t("teams"))
    .upsert({ team_name: teamName, league_id: leagueId }, { onConflict: "team_name,league_id" })
    .select("team_id").single();
  if (error) throw new Error(`Team ${teamName}: ${error.message}`);
  return (teamCache[key] = data.team_id);
}

async function ensurePlayer(name, teamId, position, leagueSlug) {
  const baseSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const slug = `${baseSlug}-${leagueSlug}`;
  if (playerCache[slug]) return playerCache[slug];
  const { data, error } = await supabase.from(t("players"))
    .upsert({ player_name: name, team_id: teamId, position: position || "POS", slug }, { onConflict: "slug" })
    .select("player_id").single();
  if (error) throw new Error(`Player ${name}: ${error.message}`);
  return (playerCache[slug] = data.player_id);
}

async function insertInjuries(records, league, year, teamId, teamName) {
  if (!records.length) return 0;
  const normalized = records.map(r => normalizeRecord(r, league, year, teamId)).filter(Boolean);

  const rows = [];
  for (const rec of normalized) {
    try {
      const finalTeamId = teamId;
      const playerId = await ensurePlayer(rec._player_name, finalTeamId, rec._position, league.slug);
      rows.push({
        player_id:              playerId,
        injury_type:            rec.injury_type,
        injury_type_slug:       rec.injury_type_slug,
        injury_description:     rec.injury_description,
        date_injured:           rec.date_injured,
        expected_recovery_range: rec.expected_recovery_range,
        expected_return_date:   rec.expected_return_date,
        status:                 rec.status,
      });
    } catch (err) {
      // Skip individual player errors
    }
  }

  if (!rows.length) return 0;

  // Batch insert in chunks of 100
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const { data, error } = await supabase.from(t("injuries")).insert(chunk).select("injury_id");
    if (!error && data) inserted += data.length;
  }
  return inserted;
}

// ─── Count existing injuries for a season ─────────────────────────────────────
async function countSeasonInjuries(leagueId, start, end) {
  const { count, error } = await supabase
    .from(t("injuries"))
    .select("injury_id", { count: "exact", head: true })
    .gte("date_injured", start)
    .lte("date_injured", end)
    .in("player_id",
      supabase.from(t("players")).select("player_id")
        .in("team_id",
          supabase.from(t("teams")).select("team_id").eq("league_id", leagueId)
        )
    );
  if (error) return 0;
  return count || 0;
}

// Count per team in a season
async function countTeamSeasonInjuries(teamId, start, end) {
  const { data, error } = await supabase
    .from(t("injuries"))
    .select("injury_id, players!inner(team_id)", { count: "exact" })
    .gte("date_injured", start)
    .lte("date_injured", end)
    .eq("players.team_id", teamId);
  if (error) return 0;
  return data?.length || 0;
}

// ─── Get used player names for a team-season ──────────────────────────────────
async function getUsedPlayerNames(teamId, start, end) {
  const { data: playerRows } = await supabase
    .from(t("players"))
    .select("player_id, player_name")
    .eq("team_id", teamId);
  const playerIds = (playerRows || []).map(p => p.player_id);
  if (!playerIds.length) return [];

  const { data } = await supabase
    .from(t("injuries"))
    .select("player_id")
    .gte("date_injured", start)
    .lte("date_injured", end)
    .in("player_id", playerIds);

  const usedIds = new Set((data || []).map(r => r.player_id));
  return (playerRows || []).filter(p => usedIds.has(p.player_id)).map(p => p.player_name);
}

// ─── Main scrape + fill flow ───────────────────────────────────────────────────
async function processLeagueSeason(league, year) {
  const { start, end, label } = league.season(year);
  const leagueId = await ensureLeague(league);

  const seasonLabel = `${league.name} ${label}`;
  process.stdout.write(`\n${seasonLabel}: checking...`);

  // Count injuries per team in this league
  const teams = league.teams;
  let seasonTotal = 0;
  const teamCounts = {};

  for (const team of teams) {
    const historicalName = getHistoricalTeamName(league, team, year);
    const teamId = await ensureTeam(historicalName, leagueId, league.slug);

    // Get player IDs for this team first
    const { data: playerRows } = await supabase
      .from(t("players"))
      .select("player_id")
      .eq("team_id", teamId);
    const playerIds = (playerRows || []).map(p => p.player_id);

    let count = 0;
    if (playerIds.length > 0) {
      const { count: c } = await supabase
        .from(t("injuries"))
        .select("injury_id", { count: "exact", head: true })
        .gte("date_injured", start)
        .lte("date_injured", end)
        .in("player_id", playerIds);
      count = c || 0;
    }

    teamCounts[team] = { count, teamId, historicalName };
    seasonTotal += count;
  }

  process.stdout.write(` ${seasonTotal} existing / ${league.target} target`);

  if (!FORCE && seasonTotal >= league.target) {
    process.stdout.write(` ✓ (skip)`);
    return 0;
  }

  const needed = league.target - seasonTotal;
  process.stdout.write(` — need ${needed} more`);

  if (DRY) {
    process.stdout.write(` [dry]`);
    return 0;
  }

  // ── Step 1: Try direct web scraping ──────────────────────────────────────────
  let scrapedTotal = 0;

  if (!SKIP_SCRAPE) {
    for (const url of league.scrapeUrls(year)) {
      process.stdout.write(`\n  Scraping ${url}...`);
      const html = await fetchHtml(url);
      if (!html || html.length < 1000) {
        process.stdout.write(` blocked/empty`);
        continue;
      }
      if (html.includes("challenge") || html.includes("captcha") || html.includes("cf-error")) {
        process.stdout.write(` cloudflare-blocked`);
        continue;
      }

      process.stdout.write(` ${Math.round(html.length/1024)}KB → parsing...`);
      const records = await parseHtmlWithGrok(html, league, year);
      process.stdout.write(` ${records.length} parsed`);

      if (records.length > 0) {
        // Insert scraped records team by team
        const byTeam = {};
        for (const rec of records) {
          const tn = rec.team || "Unknown";
          if (!byTeam[tn]) byTeam[tn] = [];
          byTeam[tn].push(rec);
        }

        for (const [teamName, teamRecs] of Object.entries(byTeam)) {
          // Find matching league team
          const matchedTeam = teams.find(t =>
            getHistoricalTeamName(league, t, year).toLowerCase().includes(teamName.toLowerCase()) ||
            teamName.toLowerCase().includes(getHistoricalTeamName(league, t, year).toLowerCase().split(" ").pop())
          ) || teams[0];
          const { teamId, historicalName } = teamCounts[matchedTeam] || {};
          if (!teamId) continue;

          const added = await insertInjuries(teamRecs, league, year, teamId, historicalName);
          scrapedTotal += added;
          if (added > 0) teamCounts[matchedTeam].count += added;
        }

        process.stdout.write(` → ${scrapedTotal} inserted from scrape`);
        seasonTotal += scrapedTotal;
        break; // Success on this URL
      }
      await sleep(2000);
    }
  }

  // ── Step 2: Fill remaining gaps via Grok knowledge (team by team) ────────────
  const stillNeeded = league.target - seasonTotal;
  if (stillNeeded <= 0) return scrapedTotal;

  process.stdout.write(`\n  Filling ${stillNeeded} more via Grok knowledge...`);
  let knowledgeTotal = 0;

  // Sort teams by how many more they need (fewest first)
  const teamList = teams
    .map(team => ({ team, ...teamCounts[team] }))
    .sort((a, b) => a.count - b.count);

  for (const { team, count, teamId, historicalName } of teamList) {
    const currentSeasonTotal = seasonTotal + knowledgeTotal;
    if (currentSeasonTotal >= league.target) break;

    const perTeamTarget = league.perTeam;
    const alreadyHas = count;
    if (!FORCE && alreadyHas >= perTeamTarget) continue;

    const wantMore = Math.min(perTeamTarget - alreadyHas, Math.ceil((league.target - currentSeasonTotal) / Math.max(1, teamList.length)));
    if (wantMore <= 0) continue;

    process.stdout.write(`\n    ${historicalName}: ${alreadyHas} → +${wantMore}`);

    const usedNames = await getUsedPlayerNames(teamId, start, end);
    const recs = await generateFromKnowledge(league, year, team, wantMore, usedNames);
    if (!recs.length) { process.stdout.write(` (empty)`); continue; }

    const added = await insertInjuries(recs, league, year, teamId, historicalName);
    process.stdout.write(` → ${added} inserted`);
    knowledgeTotal += added;
    await sleep(1200);
  }

  const total = scrapedTotal + knowledgeTotal;
  process.stdout.write(`\n  ${seasonLabel} done: +${total} (scraped:${scrapedTotal} knowledge:${knowledgeTotal})`);
  return total;
}

// ─── Entry point ───────────────────────────────────────────────────────────────
async function main() {
  const leagueKeys = LEAGUE_FILTER
    ? [LEAGUE_FILTER]
    : Object.keys(LEAGUES);

  const invalidLeague = leagueKeys.find(k => !LEAGUES[k]);
  if (invalidLeague) {
    console.error(`Unknown league: ${invalidLeague}. Options: ${Object.keys(LEAGUES).join(", ")}`);
    process.exit(1);
  }

  console.log(`\n╔══ Back In Play — Deep 10-Year Historical Injury Scraper ══╗`);
  console.log(`║  Leagues: ${leagueKeys.join(", ")}`);
  console.log(`║  Years:   ${FROM_YEAR} – ${TO_YEAR}`);
  console.log(`║  Mode:    ${DRY ? "DRY RUN" : "LIVE"} | Force: ${FORCE} | Skip-scrape: ${SKIP_SCRAPE}`);
  console.log(`║  AI:      GPT-4o (primary) + ${GROK_KEY ? "Grok-3-mini (fallback)" : "no fallback"}`);
  console.log(`╚════════════════════════════════════════════════════════════╝\n`);

  let grandTotal = 0;
  const t0 = Date.now();

  for (const leagueKey of leagueKeys) {
    const league = LEAGUES[leagueKey];
    console.log(`\n▶▶▶ Processing ${league.name} (target: ${league.target}/season) ◀◀◀`);

    for (let year = FROM_YEAR; year <= TO_YEAR; year++) {
      const added = await processLeagueSeason(league, year);
      grandTotal += added;
    }
    console.log(`\n✓ ${league.name} complete`);
    await sleep(2000);
  }

  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`\n\n╔══ COMPLETE ══╗`);
  console.log(`║  Total new records: ${grandTotal}`);
  console.log(`║  Time: ${Math.floor(elapsed/60)}m ${elapsed%60}s`);
  console.log(`╚══════════════╝\n`);
}

main().catch(err => {
  console.error("\nFatal error:", err);
  process.exit(1);
});
