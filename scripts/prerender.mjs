#!/usr/bin/env node
/**
 * Build-time prerender for SEO.
 * Runs after `vite build`. Queries Supabase and generates static HTML files
 * in dist/ with real content inside <div id="root">...</div>.
 * React hydrates on top when JS loads.
 *
 * Env vars needed: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
 * (available on Vercel during build, or from .env locally)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, "..", "dist");
const SITE = "https://backinplay.app";

// Load env from .env files if not already set
function loadEnv() {
  for (const f of [".env.local", ".env", "../.env"]) {
    const p = path.join(__dirname, "..", f);
    if (fs.existsSync(p)) {
      for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
        const [key, ...rest] = trimmed.split("=");
        const val = rest.join("=").replace(/^['"]|['"]$/g, "");
        if (!process.env[key.trim()]) process.env[key.trim()] = val;
      }
    }
  }
}
loadEnv();

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.warn("⚠ Prerender: Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY, skipping prerender");
  process.exit(0);
}

// --- Supabase helpers ---
async function sbGet(table, params = "") {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${params}`;
  const resp = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!resp.ok) throw new Error(`Supabase ${table}: ${resp.status}`);
  return resp.json();
}

// --- HTML helpers ---
const LEAGUE_LABELS = { nba: "NBA", nfl: "NFL", mlb: "MLB", nhl: "NHL", "premier-league": "EPL" };
const LEAGUE_FULL = { nba: "National Basketball Association", nfl: "National Football League", mlb: "Major League Baseball", nhl: "National Hockey League", "premier-league": "English Premier League" };

function esc(s) { return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function slugify(s) { return (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
function fmtDate(d) { return new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); }
function todayStr() { return new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }); }

let baseHtml = "";
function loadBase() {
  baseHtml = fs.readFileSync(path.join(DIST, "index.html"), "utf-8");
}

function writePage(urlPath, { title, description, content }) {
  let html = baseHtml;
  // Replace title
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${esc(title)} | Back In Play</title>`);
  // Replace meta description
  html = html.replace(/<meta name="description" content="[^"]*"/, `<meta name="description" content="${esc(description)}"`);
  // Replace OG tags
  html = html.replace(/<meta property="og:title" content="[^"]*"/, `<meta property="og:title" content="${esc(title)}"`);
  html = html.replace(/<meta property="og:description" content="[^"]*"/, `<meta property="og:description" content="${esc(description)}"`);
  html = html.replace(/<meta property="og:url" content="[^"]*"/, `<meta property="og:url" content="${SITE}${urlPath}"`);
  // Add canonical link
  html = html.replace("</head>", `  <link rel="canonical" href="${SITE}${urlPath}" />\n  </head>`);
  // Inject content into root div
  html = html.replace('<div id="root"></div>', `<div id="root">${content}</div>`);

  // Write file
  const filePath = urlPath === "/" ? path.join(DIST, "index.html") : path.join(DIST, urlPath.slice(1), "index.html");
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, html);
}

// --- Page generators ---

function homeContent(leagues, topInjuries) {
  const today = todayStr();
  let h = `<div style="max-width:48rem;margin:0 auto;padding:1rem">`;
  h += `<p style="font-size:11px;color:#666">Last updated: ${today}</p>`;
  h += `<h1>Sports Injury Tracker &amp; Return Dates</h1>`;
  h += `<p>Live sports injury updates for NBA, NFL, MLB, NHL, and EPL. Track player injuries, expected return dates, status changes, and recovery timelines. Updated throughout the day.</p>`;

  // League links
  h += `<nav><h2>Injury Reports by League</h2><ul>`;
  for (const [slug, label] of Object.entries(LEAGUE_LABELS)) {
    h += `<li><a href="/${slug}-injuries">${LEAGUE_FULL[slug] ?? label} Injury Report</a></li>`;
  }
  h += `</ul></nav>`;

  // Top injuries
  if (topInjuries.length > 0) {
    h += `<h2>Top Player Injuries</h2><ul>`;
    for (const inj of topInjuries.slice(0, 30)) {
      const slug = inj.player_slug || slugify(inj.player_name);
      h += `<li><a href="/player/${slug}">${esc(inj.player_name)}</a> — ${esc(inj.team_name)} — ${esc(inj.injury_type)} (${esc(inj.status)})</li>`;
    }
    h += `</ul>`;
  }

  h += `</div>`;
  return h;
}

function leagueContent(leagueSlug, teams, injuries) {
  const label = LEAGUE_LABELS[leagueSlug] ?? leagueSlug.toUpperCase();
  const full = LEAGUE_FULL[leagueSlug] ?? label;
  const today = todayStr();
  const year = new Date().getFullYear();
  const active = injuries.filter(i => i.status !== "returned" && i.status !== "active");

  let h = `<div style="max-width:48rem;margin:0 auto;padding:1rem">`;
  h += `<p style="font-size:11px;color:#666">Last updated: ${today}</p>`;
  h += `<nav><a href="/">Home</a> / ${esc(label)} Injuries</nav>`;
  h += `<h1>${esc(label)} Injury Report (${year})</h1>`;
  h += `<p>${esc(full)} injury report — ${active.length} players currently injured. Latest ${esc(label)} injury updates, return dates, and status changes.</p>`;

  // Team directory
  if (teams.length > 0) {
    h += `<h2>Team Injury Reports</h2><ul>`;
    for (const t of teams) {
      h += `<li><a href="/${leagueSlug}/${slugify(t.team_name)}-injuries">${esc(t.team_name)}</a></li>`;
    }
    h += `</ul>`;
  }

  // Injured players
  if (active.length > 0) {
    h += `<h2>Currently Injured (${active.length})</h2><ul>`;
    for (const inj of active.slice(0, 60)) {
      const slug = inj.player_slug || slugify(inj.player_name);
      h += `<li><a href="/player/${slug}">${esc(inj.player_name)}</a> — ${esc(inj.team_name)} — ${esc(inj.injury_type)} (${esc(inj.status)})</li>`;
    }
    h += `</ul>`;
  }

  // Cross-league links
  h += `<h3>Other Leagues</h3><ul>`;
  for (const [s, l] of Object.entries(LEAGUE_LABELS)) {
    if (s !== leagueSlug) h += `<li><a href="/${s}-injuries">${l} Injury Report</a></li>`;
  }
  h += `</ul>`;
  h += `</div>`;
  return h;
}

function teamContent(leagueSlug, teamName, injuries) {
  const label = LEAGUE_LABELS[leagueSlug] ?? leagueSlug.toUpperCase();
  const today = todayStr();
  const active = injuries.filter(i => i.status !== "returned" && i.status !== "active");
  const returned = injuries.filter(i => i.status === "returned" || i.status === "active");

  let h = `<div style="max-width:48rem;margin:0 auto;padding:1rem">`;
  h += `<p style="font-size:11px;color:#666">Last updated: ${today}</p>`;
  h += `<nav><a href="/">Home</a> / <a href="/${leagueSlug}-injuries">${esc(label)} Injuries</a> / ${esc(teamName)}</nav>`;
  h += `<h1>${esc(teamName)} Injury Report</h1>`;
  h += `<p>${esc(teamName)} injury report — ${active.length} players currently injured. Latest injury updates, return dates, and status changes for the ${esc(teamName)} (${esc(label)}).</p>`;

  if (active.length > 0) {
    h += `<h2>Currently Injured (${active.length})</h2><ul>`;
    for (const inj of active) {
      const slug = inj.player_slug || slugify(inj.player_name);
      h += `<li><a href="/player/${slug}">${esc(inj.player_name)}</a> — ${esc(inj.injury_type)} (${esc(inj.status)})</li>`;
    }
    h += `</ul>`;
  }

  if (returned.length > 0) {
    h += `<h2>Recently Returned (${returned.length})</h2><ul>`;
    for (const inj of returned.slice(0, 20)) {
      const slug = inj.player_slug || slugify(inj.player_name);
      h += `<li><a href="/player/${slug}">${esc(inj.player_name)}</a> — ${esc(inj.injury_type)}</li>`;
    }
    h += `</ul>`;
  }

  h += `<p><a href="/${leagueSlug}-injuries">All ${esc(label)} injuries</a></p>`;
  h += `</div>`;
  return h;
}

function playerContent(player, injuries) {
  const today = todayStr();
  const year = new Date().getFullYear();
  const label = LEAGUE_LABELS[player.league_slug] ?? player.league_name ?? "";
  const current = injuries[0];
  const lastName = player.player_name.split(" ").pop();

  // Build unique SEO paragraph
  let blurb;
  if (!current) {
    blurb = `${player.player_name} of the ${player.team_name} is not currently listed on the injury report. This page tracks ${lastName}'s latest injury status, recovery timeline, and full injury history with the ${player.team_name} (${label}).`;
  } else if (current.status === "returned" || current.status === "active") {
    const recov = current.recovery_days ? ` ${lastName} was sidelined for ${current.recovery_days} days before returning.` : "";
    const missed = current.games_missed > 0 ? ` The injury caused ${lastName} to miss ${current.games_missed} game${current.games_missed > 1 ? "s" : ""}.` : "";
    blurb = `${player.player_name} of the ${player.team_name} is currently listed as ${current.status.replace(/_/g, " ")} after recovering from a ${current.injury_type.toLowerCase()} injury suffered on ${fmtDate(current.date_injured)}.${recov}${missed} This page tracks ${lastName}'s latest injury status, recovery timeline, and injury history with the ${player.team_name} (${label}).`;
  } else {
    const returnInfo = current.expected_return ? ` The expected return date is ${current.expected_return}.` : " No official return date has been announced.";
    const daysOut = Math.max(0, Math.floor((Date.now() - new Date(current.date_injured).getTime()) / 86400000));
    const missed = current.games_missed > 0 ? ` ${lastName} has missed ${current.games_missed} game${current.games_missed > 1 ? "s" : ""} so far.` : "";
    blurb = `${player.player_name} of the ${player.team_name} is currently listed as ${current.status.replace(/_/g, " ")} due to a ${current.injury_type.toLowerCase()} injury suffered on ${fmtDate(current.date_injured)}. ${lastName} has been out for ${daysOut} day${daysOut !== 1 ? "s" : ""}.${missed}${returnInfo} This page tracks the latest injury updates, recovery timeline, and injury history for ${player.player_name} (${label}).`;
  }

  let h = `<div style="max-width:48rem;margin:0 auto;padding:1rem">`;
  h += `<p style="font-size:11px;color:#666">Last updated: ${today}</p>`;
  h += `<nav><a href="/">Home</a> / <a href="/${player.league_slug}-injuries">${esc(label)} Injuries</a> / <a href="/${player.league_slug}/${slugify(player.team_name)}-injuries">${esc(player.team_name)}</a> / ${esc(player.player_name)}</nav>`;
  h += `<h1>${esc(player.player_name)} Injury Status</h1>`;
  h += `<p>${esc(blurb)}</p>`;

  // Is playing tonight?
  h += `<h2>Is ${esc(player.player_name)} Playing Tonight?</h2>`;
  if (current && current.status !== "returned" && current.status !== "active") {
    h += `<p>Status: ${esc(current.status.replace(/_/g, " "))}. Last injury: ${esc(current.injury_type)}.${current.expected_return ? " Expected return: " + esc(current.expected_return) + "." : ""}</p>`;
  } else {
    h += `<p>${esc(player.player_name)} is not currently listed on the injury report and is expected to be available.</p>`;
  }

  // Current status
  if (current) {
    h += `<h2>Current Status</h2>`;
    h += `<dl>`;
    h += `<dt>Injury</dt><dd>${esc(current.injury_type)}${current.side ? " (" + esc(current.side) + ")" : ""}</dd>`;
    h += `<dt>Date Injured</dt><dd>${fmtDate(current.date_injured)}</dd>`;
    h += `<dt>Status</dt><dd>${esc(current.status.replace(/_/g, " "))}</dd>`;
    if (current.expected_return) h += `<dt>Expected Return</dt><dd>${esc(current.expected_return)}</dd>`;
    if (current.return_date) h += `<dt>Actual Return</dt><dd>${fmtDate(current.return_date)}</dd>`;
    if (current.games_missed > 0) h += `<dt>Games Missed</dt><dd>${current.games_missed}</dd>`;
    if (current.recovery_days > 0) h += `<dt>Total Recovery</dt><dd>${current.recovery_days} days</dd>`;
    h += `</dl>`;
  }

  // Injury timeline
  if (injuries.length > 0) {
    h += `<h2>Injury Timeline</h2><ul>`;
    for (const inj of [...injuries].reverse()) {
      h += `<li>${fmtDate(inj.date_injured)} — ${esc(inj.injury_type)}`;
      if (inj.return_date) h += ` → Returned ${fmtDate(inj.return_date)}`;
      h += `</li>`;
    }
    h += `</ul>`;
  }

  // Injury history
  if (injuries.length > 1) {
    h += `<h2>Injury History</h2><ul>`;
    for (const inj of injuries) {
      h += `<li>${esc(inj.injury_type)} — ${fmtDate(inj.date_injured)}${inj.return_date ? " to " + fmtDate(inj.return_date) : ""} (${esc(inj.status.replace(/_/g, " "))})${inj.games_missed > 0 ? " — " + inj.games_missed + " games missed" : ""}</li>`;
    }
    h += `</ul>`;
  }

  // Related links
  h += `<h3>Related</h3><ul>`;
  h += `<li><a href="/${player.slug}-return-date">${esc(player.player_name)} return date</a></li>`;
  h += `<li><a href="/${player.league_slug}/${slugify(player.team_name)}-injuries">${esc(player.team_name)} injury report</a></li>`;
  h += `<li><a href="/${player.league_slug}-injuries">All ${esc(label)} injuries</a></li>`;
  h += `</ul>`;
  h += `</div>`;
  return h;
}

function returnDateContent(player, injuries) {
  const today = todayStr();
  const year = new Date().getFullYear();
  const label = LEAGUE_LABELS[player.league_slug] ?? player.league_name ?? "";
  const current = injuries[0];
  const lastName = player.player_name.split(" ").pop();

  let blurb;
  if (!current) {
    blurb = `${player.player_name} of the ${player.team_name} is not currently on the injury report. When will ${player.player_name} return? There is no current injury to recover from. This page tracks ${lastName}'s return timeline and injury history (${label}).`;
  } else if (current.status === "returned" || current.status === "active") {
    const returnStr = current.return_date ? ` and returned on ${fmtDate(current.return_date)}` : "";
    const recov = current.recovery_days ? ` Total recovery time was ${current.recovery_days} days.` : "";
    blurb = `When will ${player.player_name} return? ${lastName} has already returned to play for the ${player.team_name}. ${player.player_name} suffered a ${current.injury_type.toLowerCase()} injury on ${fmtDate(current.date_injured)}${returnStr}.${recov} This page tracks ${lastName}'s return date and recovery timeline (${label}).`;
  } else {
    const daysOut = Math.max(0, Math.floor((Date.now() - new Date(current.date_injured).getTime()) / 86400000));
    const returnInfo = current.expected_return ? ` The expected return date is ${current.expected_return}.` : " No official return date has been announced yet.";
    blurb = `When will ${player.player_name} return? ${player.player_name} of the ${player.team_name} has been out for ${daysOut} days with a ${current.injury_type.toLowerCase()} injury suffered on ${fmtDate(current.date_injured)}.${returnInfo} This page tracks the latest return date updates for ${player.player_name} (${label}).`;
  }

  let h = `<div style="max-width:48rem;margin:0 auto;padding:1rem">`;
  h += `<p style="font-size:11px;color:#666">Last updated: ${today}</p>`;
  h += `<nav><a href="/">Home</a> / <a href="/${player.league_slug}-injuries">${esc(label)} Injuries</a> / <a href="/player/${player.slug}">${esc(player.player_name)}</a> / Return Date</nav>`;
  h += `<h1>${esc(player.player_name)} Return Date (${year})</h1>`;
  h += `<p>${esc(blurb)}</p>`;

  if (current) {
    h += `<h2>Expected Return</h2>`;
    h += `<p><strong>${esc(current.expected_return ?? "TBD")}</strong></p>`;
    h += `<dl>`;
    h += `<dt>Injury</dt><dd>${esc(current.injury_type)}</dd>`;
    h += `<dt>Status</dt><dd>${esc(current.status.replace(/_/g, " "))}</dd>`;
    h += `<dt>Date Injured</dt><dd>${fmtDate(current.date_injured)}</dd>`;
    if (current.return_date) h += `<dt>Actual Return</dt><dd>${fmtDate(current.return_date)}</dd>`;
    if (current.games_missed > 0) h += `<dt>Games Missed</dt><dd>${current.games_missed}</dd>`;
    if (current.recovery_days > 0) h += `<dt>Total Recovery</dt><dd>${current.recovery_days} days</dd>`;
    h += `</dl>`;
  }

  h += `<h2>Is ${esc(player.player_name)} Playing Tonight?</h2>`;
  if (current && current.status !== "returned" && current.status !== "active") {
    h += `<p>Status: ${esc(current.status.replace(/_/g, " "))}. ${esc(current.injury_type)}.${current.expected_return ? " Expected return: " + esc(current.expected_return) : ""}</p>`;
  } else {
    h += `<p>${esc(player.player_name)} is expected to be available.</p>`;
  }

  h += `<h3>Related</h3><ul>`;
  h += `<li><a href="/player/${player.slug}">Full injury history for ${esc(player.player_name)}</a></li>`;
  h += `<li><a href="/${player.league_slug}/${slugify(player.team_name)}-injuries">${esc(player.team_name)} injury report</a></li>`;
  h += `<li><a href="/${player.league_slug}-injuries">All ${esc(label)} injuries</a></li>`;
  h += `</ul>`;
  h += `</div>`;
  return h;
}

// --- Main ---
async function main() {
  console.log("Prerender: Starting...");
  loadBase();

  // Fetch all data
  const leagues = await sbGet("back_in_play_leagues", "select=league_id,league_name,slug");
  const leagueMap = new Map();
  for (const l of leagues) leagueMap.set(l.league_id, l);

  const allTeams = await sbGet("back_in_play_teams", "select=team_id,team_name,league_id&team_name=neq.Unknown&order=team_name");
  const teamMap = new Map();
  for (const t of allTeams) teamMap.set(t.team_id, t);

  // Fetch all players with slugs (paginated)
  let allPlayers = [];
  let offset = 0;
  while (true) {
    const batch = await sbGet("back_in_play_players", `select=player_id,player_name,slug,position,team_id,league_id,is_star,is_starter,league_rank,headshot_url&slug=not.is.null&team_id=not.is.null&limit=1000&offset=${offset}`);
    allPlayers.push(...batch);
    if (batch.length < 1000) break;
    offset += 1000;
  }
  console.log(`Prerender: ${allPlayers.length} players, ${allTeams.length} teams, ${leagues.length} leagues`);

  // Fetch recent injuries (last 90 days)
  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  let allInjuries = [];
  offset = 0;
  while (true) {
    const batch = await sbGet("back_in_play_injuries", `select=injury_id,player_id,injury_type,status,date_injured,return_date,expected_return,games_missed,recovery_days,side&date_injured=gte.${cutoff}&order=date_injured.desc&limit=1000&offset=${offset}`);
    allInjuries.push(...batch);
    if (batch.length < 1000) break;
    offset += 1000;
  }
  console.log(`Prerender: ${allInjuries.length} recent injuries`);

  // Build player lookup
  const playerById = new Map();
  for (const p of allPlayers) {
    const team = teamMap.get(p.team_id);
    const league = leagueMap.get(p.league_id);
    if (!team || !league) continue;
    playerById.set(p.player_id, {
      ...p,
      team_name: team.team_name,
      league_slug: league.slug,
      league_name: league.league_name,
    });
  }

  // Build injuries by player
  const injByPlayer = new Map();
  for (const inj of allInjuries) {
    if (!injByPlayer.has(inj.player_id)) injByPlayer.set(inj.player_id, []);
    injByPlayer.get(inj.player_id).push(inj);
  }

  // Enrich injuries with player data for league/team pages
  const enrichedInjuries = allInjuries.map(inj => {
    const p = playerById.get(inj.player_id);
    return {
      ...inj,
      player_name: p?.player_name ?? "Unknown",
      player_slug: p?.slug ?? "",
      team_name: p?.team_name ?? "",
      league_slug: p?.league_slug ?? "",
    };
  }).filter(inj => inj.player_name !== "Unknown");

  let pageCount = 0;

  // 1. Homepage
  const topInjuries = enrichedInjuries
    .filter(i => i.status !== "returned" && i.status !== "active")
    .slice(0, 30);
  writePage("/", {
    title: "Back In Play - Sports Injury Tracker & Return Dates",
    description: "Live sports injury updates for NBA, NFL, MLB, NHL, and EPL. Track player injuries, expected return dates, status changes, and recovery timelines.",
    content: homeContent(leagues, topInjuries),
  });
  pageCount++;

  // 2. League pages
  for (const league of leagues) {
    const slug = league.slug;
    const label = LEAGUE_LABELS[slug] ?? slug.toUpperCase();
    const leagueTeams = allTeams.filter(t => t.league_id === league.league_id);
    const leagueInjuries = enrichedInjuries.filter(i => i.league_slug === slug);

    writePage(`/${slug}-injuries`, {
      title: `${label} Injuries (${new Date().getFullYear()}) - Injury Report & Updates`,
      description: `${LEAGUE_FULL[slug] ?? label} injury report. Latest ${label} injury updates, return dates, and status changes.`,
      content: leagueContent(slug, leagueTeams, leagueInjuries),
    });
    pageCount++;

    // 3. Team pages
    for (const team of leagueTeams) {
      const teamSlug = slugify(team.team_name);
      const teamInjuries = leagueInjuries.filter(i => i.team_name === team.team_name);

      writePage(`/${slug}/${teamSlug}-injuries`, {
        title: `${team.team_name} Injuries - ${label} Injury Report`,
        description: `${team.team_name} injury report. Latest injury updates, return dates, and status changes (${label}).`,
        content: teamContent(slug, team.team_name, teamInjuries),
      });
      pageCount++;
    }
  }

  // 4. Player pages + return date pages (only players with injury data)
  for (const [playerId, player] of playerById) {
    const injuries = injByPlayer.get(playerId) ?? [];
    if (injuries.length === 0) continue; // Skip players with no injuries — saves deployment size

    // Player injury page
    writePage(`/player/${player.slug}`, {
      title: `${player.player_name} Injury Update (${new Date().getFullYear()}) - Status & Return Date`,
      description: injuries[0]
        ? `${player.player_name} injury status: ${injuries[0].status}. ${injuries[0].injury_type}. ${player.team_name} (${LEAGUE_LABELS[player.league_slug] ?? ""}).`
        : `${player.player_name} injury history. ${player.team_name} (${LEAGUE_LABELS[player.league_slug] ?? ""}).`,
      content: playerContent(player, injuries),
    });
    pageCount++;

    // Return date page
    writePage(`/${player.slug}-return-date`, {
      title: `${player.player_name} Return Date (${new Date().getFullYear()}) - Latest Injury Update`,
      description: `When will ${player.player_name} return? Latest return date, recovery timeline, and injury updates. ${player.team_name} (${LEAGUE_LABELS[player.league_slug] ?? ""}).`,
      content: returnDateContent(player, injuries),
    });
    pageCount++;
  }

  console.log(`Prerender: Generated ${pageCount} pages`);
}

main().catch((err) => {
  console.error("Prerender error:", err);
  // Don't fail the build — the SPA still works without prerendering
  process.exit(0);
});
