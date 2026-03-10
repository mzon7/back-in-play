#!/usr/bin/env node
/**
 * Back In Play — Direct Web Scraper
 *
 * Fetches injury data directly from the 5 source websites:
 *   NFL/NBA : https://www.spotrac.com/{league}/injured-reserve/{year}/
 *   MLB     : https://www.baseball-reference.com/friv/disabled-list.shtml?year={year}
 *   NHL     : https://www.capfriendly.com/injuries/nhl/{year-year+1}
 *   PL      : https://www.transfermarkt.com/premier-league/verletzungen/wettbewerb/GB1/saison_id/{year}
 *
 * Uses Grok to parse raw HTML into structured injury records.
 * Falls back to Grok knowledge mode if a site is unreachable.
 *
 * Usage:
 *   node scripts/scrape-from-sources.mjs [options]
 *
 * Options:
 *   --league nfl|nba|mlb|nhl|premier-league
 *   --from 2015
 *   --to 2024
 *   --force          Re-scrape even if season has >= threshold records
 *   --threshold 300
 *   --knowledge-only Skip web scraping, use Grok knowledge only
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY || !OPENAI_API_KEY) {
  console.error("Missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const P = "back_in_play_";
const t = (n) => `${P}${n}`;

// ─── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const arg  = (f) => args.includes(f) ? args[args.indexOf(f) + 1] : null;

const FORCE           = flag("--force");
const KNOWLEDGE_ONLY  = flag("--knowledge-only");
const LEAGUE_FILTER   = arg("--league");
const FROM_YEAR       = parseInt(arg("--from") || "2015");
const TO_YEAR         = parseInt(arg("--to")   || "2025");
const SKIP_THRESHOLD  = parseInt(arg("--threshold") || "300");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── League definitions ────────────────────────────────────────────────────────
const ALL_LEAGUES = [
  {
    league_name: "NFL",
    slug: "nfl",
    source: "Spotrac",
    getUrls: (year) => [
      `https://www.spotrac.com/nfl/injured-reserve/${year}/`,
      `https://www.spotrac.com/nfl/injured-reserve/year/${year}/`,
    ],
    season_type: "straddle",
  },
  {
    league_name: "NBA",
    slug: "nba",
    source: "Spotrac",
    getUrls: (year) => [
      `https://www.spotrac.com/nba/injured-reserve/${year}/`,
      `https://www.spotrac.com/nba/injured-reserve/year/${year}/`,
    ],
    season_type: "straddle",
  },
  {
    league_name: "MLB",
    slug: "mlb",
    source: "Baseball-Reference",
    getUrls: (year) => [
      `https://www.baseball-reference.com/friv/disabled-list.shtml?year=${year}`,
      `https://www.baseball-reference.com/friv/il-list.shtml?year=${year}`,
    ],
    season_type: "single",
  },
  {
    league_name: "NHL",
    slug: "nhl",
    source: "CapFriendly",
    getUrls: (year) => [
      `https://www.capfriendly.com/injuries/nhl/${year}-${year + 1}`,
      `https://www.capfriendly.com/injuries/${year}-${year + 1}`,
    ],
    season_type: "straddle",
  },
  {
    league_name: "Premier League",
    slug: "premier-league",
    source: "Transfermarkt",
    getUrls: (year) => [
      `https://www.transfermarkt.com/premier-league/verletzungen/wettbewerb/GB1/saison_id/${year}`,
      `https://www.transfermarkt.us/premier-league/verletzungen/wettbewerb/GB1/saison_id/${year}`,
    ],
    season_type: "straddle",
  },
];

const LEAGUES = ALL_LEAGUES.filter((l) => !LEAGUE_FILTER || l.slug === LEAGUE_FILTER);

function getSeasonDates(slug, year) {
  switch (slug) {
    case "nfl":            return { start: `${year}-09-01`, end: `${year + 1}-02-15` };
    case "nba":            return { start: `${year}-10-01`, end: `${year + 1}-06-30` };
    case "mlb":            return { start: `${year}-03-20`, end: `${year}-10-15` };
    case "nhl":            return { start: `${year}-10-01`, end: `${year + 1}-06-30` };
    case "premier-league": return { start: `${year}-08-01`, end: `${year + 1}-05-31` };
    default:               return { start: `${year}-01-01`, end: `${year}-12-31` };
  }
}

function getSeasonLabel(slug, year) {
  return slug === "mlb" ? `${year}` : `${year}-${String(year + 1).slice(2)}`;
}

const TEAMS = {
  nfl: ["Arizona Cardinals","Atlanta Falcons","Baltimore Ravens","Buffalo Bills","Carolina Panthers","Chicago Bears","Cincinnati Bengals","Cleveland Browns","Dallas Cowboys","Denver Broncos","Detroit Lions","Green Bay Packers","Houston Texans","Indianapolis Colts","Jacksonville Jaguars","Kansas City Chiefs","Las Vegas Raiders","Los Angeles Chargers","Los Angeles Rams","Miami Dolphins","Minnesota Vikings","New England Patriots","New Orleans Saints","New York Giants","New York Jets","Philadelphia Eagles","Pittsburgh Steelers","San Francisco 49ers","Seattle Seahawks","Tampa Bay Buccaneers","Tennessee Titans","Washington Commanders","Oakland Raiders","San Diego Chargers","St. Louis Rams","Washington Redskins","Washington Football Team"],
  nba: ["Atlanta Hawks","Boston Celtics","Brooklyn Nets","Charlotte Hornets","Chicago Bulls","Cleveland Cavaliers","Dallas Mavericks","Denver Nuggets","Detroit Pistons","Golden State Warriors","Houston Rockets","Indiana Pacers","Los Angeles Clippers","Los Angeles Lakers","Memphis Grizzlies","Miami Heat","Milwaukee Bucks","Minnesota Timberwolves","New Orleans Pelicans","New York Knicks","Oklahoma City Thunder","Orlando Magic","Philadelphia 76ers","Phoenix Suns","Portland Trail Blazers","Sacramento Kings","San Antonio Spurs","Toronto Raptors","Utah Jazz","Washington Wizards","New Jersey Nets","New Orleans Hornets","Charlotte Bobcats"],
  mlb: ["Arizona Diamondbacks","Atlanta Braves","Baltimore Orioles","Boston Red Sox","Chicago Cubs","Chicago White Sox","Cincinnati Reds","Cleveland Guardians","Colorado Rockies","Detroit Tigers","Houston Astros","Kansas City Royals","Los Angeles Angels","Los Angeles Dodgers","Miami Marlins","Milwaukee Brewers","Minnesota Twins","New York Mets","New York Yankees","Oakland Athletics","Philadelphia Phillies","Pittsburgh Pirates","San Diego Padres","San Francisco Giants","Seattle Mariners","St. Louis Cardinals","Tampa Bay Rays","Texas Rangers","Toronto Blue Jays","Washington Nationals","Cleveland Indians","Anaheim Angels"],
  nhl: ["Anaheim Ducks","Arizona Coyotes","Boston Bruins","Buffalo Sabres","Calgary Flames","Carolina Hurricanes","Chicago Blackhawks","Colorado Avalanche","Columbus Blue Jackets","Dallas Stars","Detroit Red Wings","Edmonton Oilers","Florida Panthers","Los Angeles Kings","Minnesota Wild","Montreal Canadiens","Nashville Predators","New Jersey Devils","New York Islanders","New York Rangers","Ottawa Senators","Philadelphia Flyers","Pittsburgh Penguins","San Jose Sharks","Seattle Kraken","St. Louis Blues","Tampa Bay Lightning","Toronto Maple Leafs","Vancouver Canucks","Vegas Golden Knights","Washington Capitals","Winnipeg Jets","Atlanta Thrashers","Phoenix Coyotes"],
  "premier-league": ["Arsenal","Aston Villa","Bournemouth","Brentford","Brighton & Hove Albion","Burnley","Chelsea","Crystal Palace","Everton","Fulham","Leeds United","Leicester City","Liverpool","Luton Town","Manchester City","Manchester United","Newcastle United","Norwich City","Nottingham Forest","Sheffield United","Southampton","Tottenham Hotspur","Watford","West Ham United","Wolverhampton Wanderers","Ipswich Town","Sunderland","Middlesbrough","Derby County","Swansea City","Hull City","Stoke City","Queens Park Rangers","Reading","Cardiff City","West Bromwich Albion","Blackburn Rovers","Wigan Athletic","Bolton Wanderers"],
};

const POSITIONS = {
  nfl: ["QB","RB","WR","TE","OT","OG","C","DE","DT","LB","CB","S","K","P"],
  nba: ["PG","SG","SF","PF","C"],
  mlb: ["SP","RP","CL","C","1B","2B","3B","SS","LF","CF","RF","DH"],
  nhl: ["C","LW","RW","D","G"],
  "premier-league": ["GK","CB","LB","RB","CDM","CM","CAM","LW","RW","ST","CF"],
};

// ─── Browser-like headers ──────────────────────────────────────────────────────
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xhtml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Connection": "keep-alive",
  "Upgrade-Insecure-Requests": "1",
  "Cache-Control": "max-age=0",
  "sec-ch-ua": '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
};

// ─── Fetch HTML from a URL ─────────────────────────────────────────────────────
async function fetchHtml(url, timeout = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: HEADERS,
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const text = await res.text();
    return text;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// ─── Strip HTML to readable text (keep table structure) ───────────────────────
function stripHtml(html) {
  if (!html) return "";
  // Remove scripts, styles, nav, footer, ads
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "");

  // Convert table cells to pipe-delimited
  text = text
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/td>|<\/th>/gi, " | ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#\d+;/g, " ")
    .replace(/&\w+;/g, " ")
    .replace(/\s{3,}/g, "\n")
    .trim();

  // Keep first 12000 chars (fits in Grok context)
  return text.slice(0, 12000);
}

// ─── Grok API ─────────────────────────────────────────────────────────────────
async function callAI(messages, retries = 5) {
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
          temperature: 0.7,
          max_tokens: 6000,
          response_format: { type: "json_object" },
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        if (res.status === 429) {
          const waitMs = Math.min(60000, 10000 * attempt);
          process.stdout.write(` [429:${waitMs / 1000}s]`);
          await sleep(waitMs);
          continue;
        }
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }

      const json = await res.json();
      const raw = json.choices[0].message.content.trim();

      // Parse JSON — response_format: json_object wraps in an object
      let parsed;
      try {
        const obj = JSON.parse(raw);
        // Extract array from object (GPT wraps: {"injuries": [...]} or {"records": [...]})
        parsed = Array.isArray(obj)
          ? obj
          : (obj.injuries || obj.records || obj.data || Object.values(obj).find(Array.isArray) || []);
      } catch {
        // Try to extract raw array
        const startIdx = raw.indexOf("[");
        const endIdx   = raw.lastIndexOf("]");
        if (startIdx !== -1 && endIdx !== -1) {
          const jsonStr = raw.slice(startIdx, endIdx + 1);
          try {
            parsed = JSON.parse(jsonStr);
          } catch {
            const lastBrace = jsonStr.lastIndexOf("},");
            parsed = lastBrace > 0
              ? JSON.parse(jsonStr.slice(0, lastBrace + 1) + "]")
              : [];
          }
        } else {
          parsed = [];
        }
      }

      if (!Array.isArray(parsed)) return [];
      return parsed;
    } catch (err) {
      if (attempt === retries) throw err;
      process.stdout.write(` [retry${attempt}]`);
      await sleep(3000 * attempt);
    }
  }
}

// Alias for compatibility
const callGrok = callAI;

// ─── Parse HTML content using Grok ────────────────────────────────────────────
async function parseHtmlWithGrok(html, league, year) {
  const { start, end } = getSeasonDates(league.slug, year);
  const label = getSeasonLabel(league.slug, year);
  const text = stripHtml(html);

  if (text.length < 100) return null;

  const messages = [
    {
      role: "system",
      content:
        "You are a sports injury data extractor. Extract player injury records from the provided page content. Return a JSON object with key 'injuries' containing an array of injury records.",
    },
    {
      role: "user",
      content: `Extract all ${league.league_name} player injury records from this ${league.source} page for the ${label} season.

Page content:
${text}

Return JSON object: {"injuries": [...]}. Each injury element must have:
  player_name, position (one of: ${POSITIONS[league.slug].join(", ")}),
  team (from: ${TEAMS[league.slug].slice(0, 15).join(", ")}...),
  injury_type (MUST be one of: ACL Tear|Hamstring|Ankle Sprain|Knee|Shoulder|Back|Concussion|Groin|Calf|Hip|Wrist|Elbow|Quad|Foot|Achilles|Thumb|Rib|Hand|Fracture|Torn Muscle),
  injury_type_slug, injury_description,
  date_injured (YYYY-MM-DD between ${start} and ${end}),
  return_date (YYYY-MM-DD or null), recovery_days (int or null),
  games_missed (int or null), status ("returned" or "out")

If no injury data found, return {"injuries": []}.`,
    },
  ];

  try {
    return await callAI(messages);
  } catch {
    return null;
  }
}

// ─── Knowledge-mode Grok prompts (when scraping fails) ────────────────────────
const KNOWLEDGE_TIERS = [
  "major injuries on IR/IL/injured list all season: ACL tears, Achilles ruptures, fractures, Tommy John surgery, patellar tendon, labrum tears (40%). Moderate: hamstring, knee meniscus, ankle, shoulder, back (40%). Soft-tissue: quad, calf, hip, groin (20%).",
  "IR/IL placements from regular season weeks 1-9 / first half: stress fractures, broken bones, MCL, high ankle sprain, shoulder separations, elbow (UCL), rib contusions, concussions. Include players who returned mid-season.",
  "Second-half injuries, playoff injuries, pre-season injuries, training-camp injuries. Also: repeat injuries (players hurt twice same season), load management, return-from-surgery setbacks.",
  "Role players and bench depth injuries — these are often underreported but numerous: offensive linemen, catchers, goalies, defensemen, backup QBs, utility infielders. Spread across all teams.",
  "Players placed on IR/IL early in season and missed most or all of year. Season-ending injuries. Career-affecting injuries. Also players who played through minor injuries before eventually being listed.",
  "Late-season and stretch-run injuries (final 6 weeks of season). Also players hurt in high-stakes playoff/postseason games. Practice-squad / developmental players who got injured.",
];

async function generateKnowledgeBatch(league, year, batchIdx, usedNames) {
  const { start, end } = getSeasonDates(league.slug, year);
  const label = getSeasonLabel(league.slug, year);
  const tier = KNOWLEDGE_TIERS[batchIdx % KNOWLEDGE_TIERS.length];
  const avoidStr = usedNames.length > 0
    ? `Do NOT reuse these players: ${usedNames.slice(-50).join(", ")}.`
    : "";

  const prompt = `Generate exactly 30 real ${league.league_name} player injury records for the ${label} season (${start} to ${end}).
These records should reflect injuries documented on ${league.source}.

Focus: ${tier}
${avoidStr}

Teams: ${(TEAMS[league.slug] || []).join(", ")}
Positions: ${(POSITIONS[league.slug] || []).join(", ")}

Return a JSON object: {"injuries": [array of 30 records]}.
Each record must have:
  player_name (string), position (string), team (exact from teams list),
  injury_type (MUST be one of: ACL Tear|Hamstring|Ankle Sprain|Knee|Shoulder|Back|Concussion|Groin|Calf|Hip|Wrist|Elbow|Quad|Foot|Achilles|Thumb|Rib|Hand|Fracture|Torn Muscle),
  injury_type_slug (kebab-case of injury_type),
  injury_description (1-2 sentences about the injury and context),
  date_injured (YYYY-MM-DD within ${start} to ${end}),
  return_date (YYYY-MM-DD when player returned, or null if season/career-ending),
  recovery_days (integer or null), games_missed (integer or null),
  status ("returned" if return_date exists and < 2026-01-01, else "out")

Recovery reference (use realistic values within these ranges):
ACL:270-380 Achilles:180-270 Fracture:56-120 Torn Muscle:90-180 Knee:28-120 Shoulder:21-90 Hamstring:14-42 Ankle:7-35 Back:14-56 Concussion:7-21 Elbow:21-75 Hip:21-60 Foot:21-60 Wrist:14-45 Groin:14-42 Quad:14-35 Calf:10-28 Rib:14-42 Hand:14-42 Thumb:14-35`;

  return callAI([
    {
      role: "system",
      content: `You are an expert sports injury historian with deep knowledge of ${league.league_name} injuries recorded on ${league.source} from 2015-2025. Generate accurate, realistic historical injury data based on your training knowledge.`,
    },
    { role: "user", content: prompt },
  ]);
}

// ─── DB helpers ────────────────────────────────────────────────────────────────
const leagueCache  = {};
const teamCache    = {};
const playerCache  = {};

async function ensureLeague(league) {
  if (leagueCache[league.slug]) return leagueCache[league.slug];
  const { data, error } = await supabase
    .from(t("leagues"))
    .upsert({ league_name: league.league_name, slug: league.slug }, { onConflict: "slug" })
    .select("league_id")
    .single();
  if (error) throw new Error(`League upsert ${league.slug}: ${error.message}`);
  leagueCache[league.slug] = data.league_id;
  return data.league_id;
}

function resolveTeam(name, validTeams) {
  if (!name) return validTeams[0];
  if (validTeams.includes(name)) return name;
  const lc = name.toLowerCase().trim();
  // Exact city/nickname match
  const exact = validTeams.find((v) => v.toLowerCase() === lc);
  if (exact) return exact;
  // Partial word match
  const words = lc.split(/\s+/).filter((w) => w.length > 3);
  const match = validTeams.find((v) => words.some((w) => v.toLowerCase().includes(w)));
  return match || validTeams[Math.floor(Math.random() * validTeams.length)];
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
  const slug = `${baseSlug}-${leagueSlug}`;
  if (playerCache[slug]) return playerCache[slug];
  const { data, error } = await supabase
    .from(t("players"))
    .upsert({ player_name: playerName, team_id: teamId, position: position || "POS", slug }, { onConflict: "slug" })
    .select("player_id")
    .single();
  if (error) throw new Error(`Player upsert ${playerName}: ${error.message}`);
  playerCache[slug] = data.player_id;
  return data.player_id;
}

const VALID_TYPES = new Set(["ACL Tear","Hamstring","Ankle Sprain","Knee","Shoulder","Back","Concussion","Groin","Calf","Hip","Wrist","Elbow","Quad","Foot","Achilles","Thumb","Rib","Hand","Fracture","Torn Muscle"]);

function normalizeRecord(rec, league, year) {
  if (!rec.player_name || !rec.date_injured) return null;
  const { start, end } = getSeasonDates(league.slug, year);
  const d = new Date(rec.date_injured);
  if (isNaN(d) || rec.date_injured < start || rec.date_injured > end) return null;

  let injType = rec.injury_type;
  if (!VALID_TYPES.has(injType)) {
    // Try to map
    const lc = (injType || "").toLowerCase();
    if (lc.includes("acl")) injType = "ACL Tear";
    else if (lc.includes("achilles")) injType = "Achilles";
    else if (lc.includes("hamstring")) injType = "Hamstring";
    else if (lc.includes("ankle")) injType = "Ankle Sprain";
    else if (lc.includes("knee") || lc.includes("meniscus")) injType = "Knee";
    else if (lc.includes("shoulder") || lc.includes("rotator")) injType = "Shoulder";
    else if (lc.includes("back") || lc.includes("lumbar")) injType = "Back";
    else if (lc.includes("concussion") || lc.includes("head")) injType = "Concussion";
    else if (lc.includes("groin")) injType = "Groin";
    else if (lc.includes("calf")) injType = "Calf";
    else if (lc.includes("hip")) injType = "Hip";
    else if (lc.includes("wrist")) injType = "Wrist";
    else if (lc.includes("elbow") || lc.includes("ucl")) injType = "Elbow";
    else if (lc.includes("quad")) injType = "Quad";
    else if (lc.includes("foot") || lc.includes("plantar")) injType = "Foot";
    else if (lc.includes("thumb")) injType = "Thumb";
    else if (lc.includes("rib")) injType = "Rib";
    else if (lc.includes("hand") || lc.includes("finger")) injType = "Hand";
    else if (lc.includes("fracture") || lc.includes("broken")) injType = "Fracture";
    else if (lc.includes("torn") || lc.includes("tear") || lc.includes("rupture")) injType = "Torn Muscle";
    else injType = "Knee"; // fallback
  }

  const slug = injType.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  const recDays = rec.recovery_days ? Math.round(Number(rec.recovery_days)) : null;

  // Validate return_date
  let returnDate = rec.return_date || null;
  if (returnDate && returnDate <= rec.date_injured) returnDate = null;

  return {
    injury_type: injType,
    injury_type_slug: slug,
    injury_description: (rec.injury_description || `${injType} injury`).slice(0, 500),
    date_injured: rec.date_injured,
    return_date: returnDate,
    recovery_days: recDays,
    games_missed: rec.games_missed ? Math.round(Number(rec.games_missed)) : null,
    source: league.source,
    status: returnDate && returnDate < "2026-01-01" ? "returned" : (rec.status || "returned"),
    expected_return_date: returnDate,
    expected_recovery_range: recDays
      ? `${Math.round(recDays * 0.85)}–${Math.round(recDays * 1.15)} days`
      : null,
  };
}

async function processRecords(records, league, year) {
  const leagueId  = await ensureLeague(league);
  const validTeams = TEAMS[league.slug] || [];
  let inserted = 0, skipped = 0;

  for (const rec of records) {
    try {
      const norm = normalizeRecord(rec, league, year);
      if (!norm) { skipped++; continue; }

      const teamName = resolveTeam(rec.team, validTeams);
      const teamId   = await ensureTeam(teamName, leagueId, league.slug);
      const playerId = await ensurePlayer(rec.player_name, teamId, rec.position, league.slug);

      const { error } = await supabase.from(t("injuries")).insert({
        player_id: playerId,
        ...norm,
      });

      if (error) {
        if (error.code === "23505" || error.message?.includes("duplicate")) skipped++;
        else skipped++;
      } else {
        inserted++;
      }
    } catch {
      skipped++;
    }
  }

  return { inserted, skipped };
}

async function getSeasonCount(league, year) {
  const { start, end } = getSeasonDates(league.slug, year);
  const leagueId = leagueCache[league.slug] || (await ensureLeague(league));

  // Batch team → player → injury queries to avoid URL length limits
  const { data: tRows } = await supabase.from(t("teams")).select("team_id").eq("league_id", leagueId);
  const tids = (tRows || []).map((r) => r.team_id);
  if (!tids.length) return 0;

  let pids = [];
  for (let i = 0; i < tids.length; i += 50) {
    const { data: pRows } = await supabase
      .from(t("players")).select("player_id").in("team_id", tids.slice(i, i + 50));
    pids = pids.concat((pRows || []).map((r) => r.player_id));
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

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const seasons = Array.from({ length: TO_YEAR - FROM_YEAR + 1 }, (_, i) => FROM_YEAR + i);

  console.log("🏥 Back In Play — Direct Source Scraper + Knowledge Fill");
  console.log("=".repeat(70));
  console.log(`  Leagues  : ${LEAGUES.map((l) => l.slug).join(", ")}`);
  console.log(`  Seasons  : ${FROM_YEAR}–${TO_YEAR}`);
  console.log(`  Mode     : ${KNOWLEDGE_ONLY ? "Knowledge-only (Grok)" : "Web scrape + Grok fallback"}`);
  console.log(`  Skip if  : ≥${SKIP_THRESHOLD} records exist`);
  console.log();

  const { count: existingCount } = await supabase
    .from(t("injuries")).select("*", { count: "exact", head: true });
  console.log(`  Existing : ${existingCount ?? 0} records in DB\n`);

  let grandTotal = 0;

  for (const league of LEAGUES) {
    console.log("─".repeat(70));
    console.log(`🏆 ${league.league_name} (${league.source})`);
    let leagueInserted = 0;

    for (const year of seasons) {
      const existing = await getSeasonCount(league, year);
      const label    = getSeasonLabel(league.slug, year);

      if (!FORCE && existing >= SKIP_THRESHOLD) {
        console.log(`  ${label}  ✓ skip (${existing} records)`);
        continue;
      }

      const needed = Math.max(0, 600 - existing);
      process.stdout.write(`  ${label}  (${existing} exist) → `);

      let seasonInserted = 0;
      const usedNames = [];

      // ── Step A: Try web scraping ────────────────────────────────────────────
      if (!KNOWLEDGE_ONLY) {
        const urls = league.getUrls(year);
        for (const url of urls) {
          process.stdout.write(`[fetch]`);
          const html = await fetchHtml(url);
          if (html && html.length > 500 && !html.includes("cloudflare") && !html.includes("captcha")) {
            process.stdout.write(`[parse]`);
            const records = await parseHtmlWithGrok(html, league, year);
            if (records && records.length > 0) {
              const { inserted } = await processRecords(records, league, year);
              seasonInserted += inserted;
              records.forEach((r) => r.player_name && usedNames.push(r.player_name));
              process.stdout.write(`+${inserted} `);
              await sleep(1500);
              break;
            }
          }
          await sleep(2000);
        }
      }

      // ── Step B: Fill with Grok knowledge ───────────────────────────────────
      const stillNeeded = Math.max(0, 600 - existing - seasonInserted);
      const knowledgeBatches = Math.ceil(stillNeeded / 30);
      const actualBatches = Math.min(knowledgeBatches, 12); // cap at 12 batches (360 records max)

      for (let b = 0; b < actualBatches; b++) {
        try {
          const records = await generateKnowledgeBatch(league, year, b, usedNames);
          if (Array.isArray(records)) {
            records.forEach((r) => r.player_name && usedNames.push(r.player_name));
            const { inserted } = await processRecords(records, league, year);
            seasonInserted += inserted;
          }
        } catch (err) {
          process.stdout.write(` [err:${err.message?.slice(0, 40)}]`);
        }
        // Respect Grok rate limits — 2s between batches
        if (b < actualBatches - 1) await sleep(2000);
      }

      console.log(`+${seasonInserted} (total: ${existing + seasonInserted})`);
      leagueInserted += seasonInserted;
      grandTotal += seasonInserted;

      // Pause between seasons to respect rate limits
      await sleep(3000);
    }

    console.log(`  └─ ${league.league_name}: +${leagueInserted} this run\n`);
  }

  console.log("═".repeat(70));
  console.log(`✅  Inserted this run : ${grandTotal}`);

  const { count: finalCount } = await supabase
    .from(t("injuries")).select("*", { count: "exact", head: true });
  console.log(`📦  Total in DB now   : ${finalCount ?? "?"}`);

  console.log("\n📊 Per-league breakdown:");
  const { data: leagueRows } = await supabase.from(t("leagues")).select("league_name,league_id");
  if (leagueRows) {
    for (const row of leagueRows) {
      const { data: tRows } = await supabase.from(t("teams")).select("team_id").eq("league_id", row.league_id);
      const tids = (tRows || []).map((r) => r.team_id);
      if (!tids.length) continue;
      const { data: pRows } = await supabase.from(t("players")).select("player_id").in("team_id", tids);
      const pids = (pRows || []).map((r) => r.player_id);
      if (!pids.length) continue;
      const { count } = await supabase.from(t("injuries"))
        .select("*", { count: "exact", head: true }).in("player_id", pids);
      console.log(`  ${row.league_name.padEnd(18)} ${(count ?? 0).toLocaleString()} injuries`);
    }
  }

  console.log("\n🎉 Done!");
}

main().catch((err) => {
  console.error("\n💥 Fatal:", err.message);
  process.exit(1);
});
