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
const SB_DELAY_MS = 100; // throttle requests to avoid pool exhaustion
let _lastSbCall = 0;

async function sbGet(table, params = "") {
  // Rate-limit: ensure at least SB_DELAY_MS between requests
  const now = Date.now();
  const wait = SB_DELAY_MS - (now - _lastSbCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _lastSbCall = Date.now();

  const url = `${SUPABASE_URL}/rest/v1/${table}?${params}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      });
      if (!resp.ok) {
        if (resp.status === 429 || resp.status >= 500) {
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }
        throw new Error(`Supabase ${table}: ${resp.status}`);
      }
      return resp.json();
    } catch (e) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
}

// --- HTML helpers ---
const LEAGUE_LABELS = { nba: "NBA", nfl: "NFL", mlb: "MLB", nhl: "NHL", "premier-league": "EPL" };
const LEAGUE_FULL = { nba: "National Basketball Association", nfl: "National Football League", mlb: "Major League Baseball", nhl: "National Hockey League", "premier-league": "English Premier League" };
const LEAGUE_SPORT = { nba: "basketball", nfl: "football", mlb: "baseball", nhl: "hockey", "premier-league": "football" };

function esc(s) { return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function slugify(s) { return (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
function fmtDate(d) { return new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); }
function todayStr() { return new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }); }

let baseHtml = "";
function loadBase() {
  baseHtml = fs.readFileSync(path.join(DIST, "index.html"), "utf-8");
}

function writePage(urlPath, { title, description, content, preloadedQueries }) {
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
  // Inject preloaded React Query data (instant render, background refetch)
  if (preloadedQueries?.length) {
    const json = JSON.stringify(preloadedQueries)
      .replace(/<\/script/gi, '<\\/script')
      .replace(/<!--/g, '<\\!--');
    if (json.length < 300_000) { // 300KB cap
      html = html.replace("</head>", `<script>window.__PRELOADED_QUERIES__=${json};</script>\n</head>`);
    }
  }
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
  h += `<li><a href="/${player.league_slug}-injury-performance">${esc(label)} injury performance analysis</a></li>`;
  h += `<li><a href="/performance-curves">Performance curves</a></li>`;
  h += `<li><a href="/recovery-stats">Recovery statistics</a></li>`;
  h += `<li><a href="/${player.league_slug}/returning-today">${esc(label)} players returning today</a></li>`;
  h += `<li><a href="/${player.league_slug}-injury-analysis">${esc(label)} injury analysis</a></li>`;
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

function injuryTypeContent(injuryType, injurySlug, injuriesByLeague) {
  const today = todayStr();
  const year = new Date().getFullYear();
  const totalCount = Object.values(injuriesByLeague).reduce((a, b) => a + b.length, 0);

  // Compute average recovery
  const allRecov = Object.values(injuriesByLeague).flat().filter(i => i.recovery_days > 0).map(i => i.recovery_days);
  const avgRecov = allRecov.length > 0 ? Math.round(allRecov.reduce((a, b) => a + b, 0) / allRecov.length) : null;
  const allMissed = Object.values(injuriesByLeague).flat().filter(i => i.games_missed > 0).map(i => i.games_missed);
  const avgMissed = allMissed.length > 0 ? Math.round(allMissed.reduce((a, b) => a + b, 0) / allMissed.length) : null;

  let h = `<div style="max-width:48rem;margin:0 auto;padding:1rem">`;
  h += `<p style="font-size:11px;color:#666">Last updated: ${today}</p>`;
  h += `<nav><a href="/">Home</a> / Injuries / ${esc(injuryType)}</nav>`;
  h += `<h1>${esc(injuryType)} Injuries in Professional Sports (${year})</h1>`;

  h += `<p>${esc(injuryType)} injuries are among the most tracked in professional sports. `;
  h += `Our database contains ${totalCount} recorded ${esc(injuryType.toLowerCase())} injuries across the NBA, NFL, MLB, NHL, and EPL.`;
  if (avgRecov) h += ` The average recovery time is ${avgRecov} days.`;
  if (avgMissed) h += ` Players miss an average of ${avgMissed} games.`;
  h += `</p>`;

  // Recovery statistics
  if (avgRecov || avgMissed) {
    h += `<h2>Recovery Statistics</h2>`;
    h += `<dl>`;
    if (avgRecov) h += `<dt>Average Recovery Time</dt><dd>${avgRecov} days</dd>`;
    if (avgMissed) h += `<dt>Average Games Missed</dt><dd>${avgMissed} games</dd>`;
    h += `<dt>Total Cases in Database</dt><dd>${totalCount}</dd>`;
    h += `</dl>`;
  }

  // Per-league breakdown
  for (const [leagueSlug, leagueInjs] of Object.entries(injuriesByLeague)) {
    if (leagueInjs.length === 0) continue;
    const label = LEAGUE_LABELS[leagueSlug] ?? leagueSlug.toUpperCase();
    const leagueRecov = leagueInjs.filter(i => i.recovery_days > 0).map(i => i.recovery_days);
    const leagueAvg = leagueRecov.length > 0 ? Math.round(leagueRecov.reduce((a, b) => a + b, 0) / leagueRecov.length) : null;

    h += `<h2>${esc(injuryType)} Injuries in the ${esc(label)} (${leagueInjs.length})</h2>`;
    if (leagueAvg) h += `<p>Average recovery in the ${esc(label)}: ${leagueAvg} days.</p>`;

    // Recent players
    const recent = leagueInjs.slice(0, 15);
    h += `<ul>`;
    for (const inj of recent) {
      const pSlug = inj.player_slug || slugify(inj.player_name);
      h += `<li><a href="/injury/${pSlug}">${esc(inj.player_name)}</a> — ${esc(inj.team_name)} — ${fmtDate(inj.date_injured)}`;
      if (inj.return_date) h += ` → Returned ${fmtDate(inj.return_date)}`;
      if (inj.recovery_days > 0) h += ` (${inj.recovery_days} days)`;
      h += `</li>`;
    }
    h += `</ul>`;
  }

  // Related links
  h += `<h3>Related Injury Types</h3><ul>`;
  h += `<li><a href="/performance-curves">Performance After Injury (Recovery Curves)</a></li>`;
  for (const [s, l] of Object.entries(LEAGUE_LABELS)) {
    h += `<li><a href="/${s}-injuries">${l} Injury Report</a></li>`;
  }
  h += `</ul>`;
  h += `</div>`;
  return h;
}

// --- New page generators ---

function returningTodayContent(leagueSlug, returningPlayers) {
  const today = todayStr();
  const year = new Date().getFullYear();
  const isAll = !leagueSlug;
  const label = isAll ? "All Leagues" : (LEAGUE_LABELS[leagueSlug] ?? leagueSlug.toUpperCase());

  let h = `<div style="max-width:48rem;margin:0 auto;padding:1rem">`;
  h += `<p style="font-size:11px;color:#666">Last updated: ${today}</p>`;
  h += `<nav><a href="/">Home</a>${isAll ? "" : ` / <a href="/${leagueSlug}-injuries">${esc(label)} Injuries</a>`} / Returning Today</nav>`;
  h += `<h1>${esc(label)} Players Returning From Injury Today (${year})</h1>`;
  h += `<p>Track which ${isAll ? "" : esc(label) + " "}players are expected to return from injury today. Updated daily with the latest return-to-play updates.</p>`;

  if (returningPlayers.length > 0) {
    h += `<h2>${returningPlayers.length} Players Returning</h2><ul>`;
    for (const p of returningPlayers) {
      h += `<li><a href="/player/${esc(p.slug)}">${esc(p.player_name)}</a> — ${esc(p.team_name)} — ${esc(p.injury_type)}</li>`;
    }
    h += `</ul>`;
  } else {
    h += `<p>No players are currently expected to return today. Check back later for updates.</p>`;
  }

  // Cross-links
  h += `<h3>Related</h3><ul>`;
  if (isAll) {
    for (const [s, l] of Object.entries(LEAGUE_LABELS)) {
      h += `<li><a href="/${s}/returning-today">${l} Players Returning Today</a></li>`;
    }
  } else {
    h += `<li><a href="/returning-today">All Leagues — Returning Today</a></li>`;
    h += `<li><a href="/${leagueSlug}-injuries">${esc(label)} Injury Report</a></li>`;
    h += `<li><a href="/${leagueSlug}-injury-performance">${esc(label)} Injury Performance Analysis</a></li>`;
  }
  h += `</ul></div>`;
  return h;
}

function leagueInjuryPerformanceContent(leagueSlug, curveSummaries) {
  const label = LEAGUE_LABELS[leagueSlug] ?? leagueSlug.toUpperCase();
  const full = LEAGUE_FULL[leagueSlug] ?? label;
  const year = new Date().getFullYear();
  const totalCases = curveSummaries.reduce((s, c) => s + c.sample_size, 0);

  let h = `<div style="max-width:48rem;margin:0 auto;padding:1rem">`;
  h += `<nav><a href="/">Home</a> / <a href="/${leagueSlug}-injuries">${esc(label)} Injuries</a> / Injury Performance</nav>`;
  h += `<h1>${esc(label)} Player Performance After Injury (${year})</h1>`;
  h += `<p>How do ${esc(full)} players perform after returning from injury? Analysis of recovery curves across ${curveSummaries.length} injury types based on ${totalCases.toLocaleString()} historical cases.</p>`;

  if (curveSummaries.length > 0) {
    h += `<h2>Recovery Curves by Injury Type</h2>`;
    h += `<table><thead><tr><th>Injury</th><th>Cases</th><th>Avg Recovery</th><th>Game 1</th><th>Game 10</th></tr></thead><tbody>`;
    for (const c of curveSummaries) {
      const g1 = c.game1 != null ? `${Math.round(c.game1 * 100)}%` : "—";
      const g10 = c.game10 != null ? `${Math.round(c.game10 * 100)}%` : "—";
      const recov = c.recovery_avg != null ? `${Math.round(c.recovery_avg)}d` : "—";
      h += `<tr><td><a href="/injuries/${esc(slugify(c.injury_type))}">${esc(c.injury_type)}</a></td>`;
      h += `<td>${c.sample_size}</td><td>${recov}</td><td>${g1}</td><td>${g10}</td></tr>`;
    }
    h += `</tbody></table>`;
  }

  h += `<h2>How ${esc(label)} Injuries Affect Player Performance</h2>`;
  h += `<p>Understanding post-injury performance is critical for fantasy sports managers, sports bettors, and team analysts. Our data tracks ${esc(label)} players in their first 10 games back, comparing post-return stats against pre-injury baselines.</p>`;

  h += `<h3>Related</h3><ul>`;
  h += `<li><a href="/performance-curves">All Leagues — Performance Curves</a></li>`;
  h += `<li><a href="/${leagueSlug}-injuries">${esc(label)} Injury Report</a></li>`;
  h += `<li><a href="/recovery-stats">Recovery Statistics</a></li>`;
  for (const [s, l] of Object.entries(LEAGUE_LABELS)) {
    if (s !== leagueSlug) h += `<li><a href="/${s}-injury-performance">${l} Injury Performance</a></li>`;
  }
  h += `</ul></div>`;
  return h;
}

function performanceCurvesContent(allCurveSummaries) {
  const year = new Date().getFullYear();
  const totalCases = allCurveSummaries.reduce((s, c) => s + c.sample_size, 0);

  let h = `<div style="max-width:48rem;margin:0 auto;padding:1rem">`;
  h += `<nav><a href="/">Home</a> / Performance Curves</nav>`;
  h += `<h1>Post-Injury Performance Curves — All Leagues (${year})</h1>`;
  h += `<p>How do professional athletes perform after returning from injury? Explore recovery curves across NBA, NFL, MLB, NHL, and EPL based on ${totalCases.toLocaleString()} historical cases.</p>`;

  // Per-league links
  h += `<h2>Performance by League</h2><ul>`;
  for (const [s, l] of Object.entries(LEAGUE_LABELS)) {
    h += `<li><a href="/${s}-injury-performance">${l} Injury Performance Analysis</a></li>`;
  }
  h += `</ul>`;

  // Top injuries across all leagues
  const top = [...allCurveSummaries].sort((a, b) => b.sample_size - a.sample_size).slice(0, 20);
  if (top.length > 0) {
    h += `<h2>Most Common Injuries</h2><ul>`;
    for (const c of top) {
      const g10 = c.game10 != null ? ` — Game 10: ${Math.round(c.game10 * 100)}%` : "";
      h += `<li>${esc(c.injury_type)} (${esc(c.league)}) — ${c.sample_size} cases${g10}</li>`;
    }
    h += `</ul>`;
  }

  h += `<h2>About Performance Curves</h2>`;
  h += `<p>Each performance curve tracks a player's composite stat score in their first 10 games back from injury, expressed as a percentage of their pre-injury baseline. Curves are computed using a 10-game pre-injury window with per-minute normalization, ratio capping at 3x, and trimmed means to handle outliers.</p>`;

  h += `<h3>Related</h3><ul>`;
  h += `<li><a href="/recovery-stats">Recovery Statistics</a></li>`;
  h += `<li><a href="/returning-today">Players Returning Today</a></li>`;
  for (const [s, l] of Object.entries(LEAGUE_LABELS)) {
    h += `<li><a href="/${s}-injuries">${l} Injury Report</a></li>`;
  }
  h += `</ul></div>`;
  return h;
}

function recoveryStatsContent(injuryTypeStats) {
  const year = new Date().getFullYear();
  const totalTypes = injuryTypeStats.length;

  let h = `<div style="max-width:48rem;margin:0 auto;padding:1rem">`;
  h += `<nav><a href="/">Home</a> / Recovery Statistics</nav>`;
  h += `<h1>Sports Injury Recovery Statistics (${year})</h1>`;
  h += `<p>Comprehensive recovery statistics for ${totalTypes} injury types across professional sports. Average recovery times, games missed, and severity analysis.</p>`;

  if (injuryTypeStats.length > 0) {
    h += `<h2>Recovery by Injury Type</h2>`;
    h += `<table><thead><tr><th>Injury</th><th>Cases</th><th>Avg Recovery</th><th>Avg Games Missed</th></tr></thead><tbody>`;
    for (const s of injuryTypeStats.slice(0, 30)) {
      h += `<tr><td><a href="/injuries/${esc(slugify(s.type))}">${esc(s.type)}</a></td>`;
      h += `<td>${s.count}</td><td>${s.avgRecov ? s.avgRecov + "d" : "—"}</td><td>${s.avgMissed ?? "—"}</td></tr>`;
    }
    h += `</tbody></table>`;
  }

  h += `<h3>Related</h3><ul>`;
  h += `<li><a href="/performance-curves">Performance Curves</a></li>`;
  h += `<li><a href="/returning-today">Players Returning Today</a></li>`;
  for (const [s, l] of Object.entries(LEAGUE_LABELS)) {
    h += `<li><a href="/${s}-injuries">${l} Injury Report</a></li>`;
  }
  h += `</ul></div>`;
  return h;
}

function leagueInjuryAnalysisContent(leagueSlug, curveSummaries, injuryStats) {
  const label = LEAGUE_LABELS[leagueSlug] ?? leagueSlug.toUpperCase();
  const full = LEAGUE_FULL[leagueSlug] ?? label;
  const year = new Date().getFullYear();
  const totalCases = curveSummaries.reduce((s, c) => s + c.sample_size, 0);

  let h = `<div style="max-width:48rem;margin:0 auto;padding:1rem">`;
  h += `<nav><a href="/">Home</a> / <a href="/${leagueSlug}-injuries">${esc(label)} Injuries</a> / Injury Analysis</nav>`;
  h += `<h1>${esc(label)} Injury Analysis Hub (${year})</h1>`;
  h += `<p>Comprehensive ${esc(label)} injury analytics: recovery timelines, performance after injury, and return-to-play analysis based on ${totalCases.toLocaleString()} historical cases across ${curveSummaries.length} injury types.</p>`;

  // Injury type analysis links
  if (curveSummaries.length > 0) {
    h += `<h2>Injury Type Analysis</h2><ul>`;
    for (const c of curveSummaries.slice(0, 25)) {
      h += `<li><a href="/injuries/${esc(slugify(c.injury_type))}">${esc(c.injury_type)}</a> — ${c.sample_size} cases`;
      if (c.recovery_avg) h += `, ${Math.round(c.recovery_avg)}d avg recovery`;
      h += `</li>`;
    }
    h += `</ul>`;
  }

  // Performance analysis links
  h += `<h2>Performance After Injury</h2><ul>`;
  h += `<li><a href="/${leagueSlug}-injury-performance">${esc(label)} Post-Injury Performance Curves</a></li>`;
  for (const c of curveSummaries.slice(0, 5)) {
    h += `<li><a href="/${leagueSlug}/${slugify(c.injury_type)}-injury-performance">${esc(c.injury_type)} Performance in ${esc(label)}</a></li>`;
  }
  h += `</ul>`;

  // Related links
  h += `<h2>Related Analysis</h2><ul>`;
  h += `<li><a href="/${leagueSlug}/returning-today">${esc(label)} Players Returning Today</a></li>`;
  h += `<li><a href="/${leagueSlug}/minutes-restriction-after-injury">${esc(label)} Minutes Restrictions</a></li>`;
  h += `<li><a href="/performance-curves">All Leagues — Performance Curves</a></li>`;
  h += `<li><a href="/recovery-stats">Recovery Statistics</a></li>`;
  for (const [s, l] of Object.entries(LEAGUE_LABELS)) {
    if (s !== leagueSlug) h += `<li><a href="/${s}-injury-analysis">${l} Injury Analysis</a></li>`;
  }
  h += `</ul>`;

  // SEO text
  h += `<h2>About ${esc(label)} Injury Analysis</h2>`;
  h += `<p>Back In Play provides the most comprehensive ${esc(label)} injury analytics available. Our database tracks every ${esc(full)} injury, computes recovery curves from historical game log data, and analyzes how injuries impact player performance. Whether you're a fantasy ${esc(label)} manager looking for edges on returning players, a sports bettor evaluating injury impact on lines, or a team analyst studying injury trends — our data covers ${curveSummaries.length} injury types with ${totalCases.toLocaleString()} historical return cases.</p>`;
  h += `</div>`;
  return h;
}

function leagueInjuryTypePerformanceContent(leagueSlug, injuryType, curveSummary) {
  const label = LEAGUE_LABELS[leagueSlug] ?? leagueSlug.toUpperCase();
  const year = new Date().getFullYear();

  let h = `<div style="max-width:48rem;margin:0 auto;padding:1rem">`;
  h += `<nav><a href="/">Home</a> / <a href="/${leagueSlug}-injuries">${esc(label)} Injuries</a> / <a href="/injuries/${esc(slugify(injuryType))}">${esc(injuryType)}</a> / Performance</nav>`;
  h += `<h1>${esc(injuryType)} Injury Performance in the ${esc(label)} (${year})</h1>`;

  if (curveSummary) {
    const g1 = curveSummary.game1 != null ? Math.round(curveSummary.game1 * 100) : null;
    const g10 = curveSummary.game10 != null ? Math.round(curveSummary.game10 * 100) : null;
    h += `<p>Analysis of how ${esc(label)} players perform after ${esc(injuryType.toLowerCase())} injuries, based on ${curveSummary.sample_size} historical cases.`;
    if (g1) h += ` Players average ${g1}% of pre-injury performance in game 1`;
    if (g10) h += ` and ${g10}% by game 10.`;
    h += `</p>`;

    h += `<h2>Recovery Overview</h2><dl>`;
    h += `<dt>Sample Size</dt><dd>${curveSummary.sample_size} cases</dd>`;
    if (curveSummary.recovery_avg) h += `<dt>Avg Recovery</dt><dd>${Math.round(curveSummary.recovery_avg)} days</dd>`;
    if (g1) h += `<dt>Game 1 Performance</dt><dd>${g1}% of baseline</dd>`;
    if (g10) h += `<dt>Game 10 Performance</dt><dd>${g10}% of baseline</dd>`;
    h += `</dl>`;
  }

  // Related links
  h += `<h2>Related</h2><ul>`;
  h += `<li><a href="/${leagueSlug}-injury-performance">${esc(label)} All Injury Performance</a></li>`;
  h += `<li><a href="/injuries/${esc(slugify(injuryType))}">${esc(injuryType)} Recovery Statistics</a></li>`;
  h += `<li><a href="/${leagueSlug}-injury-analysis">${esc(label)} Injury Analysis Hub</a></li>`;
  h += `<li><a href="/${leagueSlug}-injuries">${esc(label)} Injury Report</a></li>`;
  h += `<li><a href="/performance-curves">All Performance Curves</a></li>`;
  h += `<li><a href="/recovery-stats">Recovery Statistics</a></li>`;
  h += `<li><a href="/${leagueSlug}/returning-today">${esc(label)} Returning Today</a></li>`;
  h += `<li><a href="/${leagueSlug}/minutes-restriction-after-injury">${esc(label)} Minutes Restrictions</a></li>`;
  h += `</ul>`;

  h += `<p>${esc(injuryType)} injuries in the ${esc(label)} require careful monitoring of post-return performance. Our analysis tracks player stats across the first 10 games back from ${esc(injuryType.toLowerCase())} injuries, comparing them against pre-injury baselines to quantify the true performance impact. This data helps fantasy managers set realistic expectations and bettors adjust their models for returning players.</p>`;
  h += `</div>`;
  return h;
}

function minutesRestrictionContent(leagueSlug, curveSummaries) {
  const isAll = !leagueSlug;
  const label = isAll ? "All Leagues" : (LEAGUE_LABELS[leagueSlug] ?? leagueSlug.toUpperCase());
  const year = new Date().getFullYear();

  // Compute average minutes pct from curves
  const withMinutes = curveSummaries.filter(c => c.minutes_g1 != null);
  const avgG1 = withMinutes.length > 0 ? Math.round(withMinutes.reduce((s, c) => s + c.minutes_g1, 0) / withMinutes.length * 100) : null;
  const avgG10 = withMinutes.length > 0 ? Math.round(withMinutes.reduce((s, c) => s + c.minutes_g10, 0) / withMinutes.length * 100) : null;

  let h = `<div style="max-width:48rem;margin:0 auto;padding:1rem">`;
  h += `<nav><a href="/">Home</a>${isAll ? "" : ` / <a href="/${leagueSlug}-injuries">${esc(label)} Injuries</a>`} / Minutes Restriction</nav>`;
  h += `<h1>${isAll ? "" : esc(label) + " "}Minutes Restriction After Injury (${year})</h1>`;
  h += `<p>How long do players have minutes restrictions after returning from injury? `;
  if (avgG1) h += `On average, ${isAll ? "" : esc(label) + " "}players play ${avgG1}% of pre-injury minutes in game 1 and ${avgG10 ?? "N/A"}% by game 10. `;
  h += `Analysis based on historical return-to-play data.</p>`;

  if (withMinutes.length > 0) {
    h += `<h2>Minutes by Injury Type</h2>`;
    h += `<table><thead><tr><th>Injury</th><th>Cases</th><th>Game 1 Min%</th><th>Game 10 Min%</th></tr></thead><tbody>`;
    for (const c of withMinutes.sort((a, b) => (a.minutes_g1 ?? 1) - (b.minutes_g1 ?? 1)).slice(0, 20)) {
      h += `<tr><td>${esc(c.injury_type)}</td><td>${c.sample_size}</td>`;
      h += `<td>${c.minutes_g1 != null ? Math.round(c.minutes_g1 * 100) + "%" : "—"}</td>`;
      h += `<td>${c.minutes_g10 != null ? Math.round(c.minutes_g10 * 100) + "%" : "—"}</td></tr>`;
    }
    h += `</tbody></table>`;
  }

  // FAQ
  h += `<h2>FAQ</h2>`;
  h += `<h3>How long do players typically have minutes restrictions?</h3>`;
  h += `<p>Most players return to near-full workloads within 3-5 games. ${avgG1 ? `Game 1 averages ${avgG1}% minutes, ` : ""}reaching near baseline by game 10.</p>`;
  h += `<h3>Which injuries cause the longest minutes restrictions?</h3>`;
  h += `<p>ACL injuries, fractures, and surgeries typically result in the most significant and prolonged minutes restrictions.</p>`;

  // Links
  h += `<h3>Related</h3><ul>`;
  if (isAll) {
    for (const [s, l] of Object.entries(LEAGUE_LABELS)) {
      h += `<li><a href="/${s}/minutes-restriction-after-injury">${l} Minutes Restrictions</a></li>`;
    }
  }
  h += `<li><a href="/performance-curves">Performance Curves</a></li>`;
  h += `<li><a href="/recovery-stats">Recovery Statistics</a></li>`;
  h += `<li><a href="/returning-today">Players Returning Today</a></li>`;
  h += `<li><a href="/players-returning-from-injury-this-week">Returning This Week</a></li>`;
  for (const [s, l] of Object.entries(LEAGUE_LABELS)) {
    h += `<li><a href="/${s}-injuries">${l} Injury Report</a></li>`;
  }
  h += `</ul></div>`;
  return h;
}

function returningThisWeekContent(leagueSlug, returningPlayers) {
  const isAll = !leagueSlug;
  const label = isAll ? "All Leagues" : (LEAGUE_LABELS[leagueSlug] ?? leagueSlug.toUpperCase());
  const year = new Date().getFullYear();

  let h = `<div style="max-width:48rem;margin:0 auto;padding:1rem">`;
  h += `<nav><a href="/">Home</a>${isAll ? "" : ` / <a href="/${leagueSlug}-injuries">${esc(label)} Injuries</a>`} / Returning This Week</nav>`;
  h += `<h1>${isAll ? "" : esc(label) + " "}Players Returning From Injury This Week (${year})</h1>`;
  h += `<p>Track which ${isAll ? "" : esc(label) + " "}players are expected to return from injury this week. Essential for fantasy managers and bettors.</p>`;

  if (returningPlayers.length > 0) {
    h += `<h2>${returningPlayers.length} Expected Returns</h2><ul>`;
    for (const p of returningPlayers) {
      h += `<li><a href="/player/${esc(p.slug)}">${esc(p.player_name)}</a> — ${esc(p.team_name)} — ${esc(p.injury_type)}`;
      if (p.games_missed) h += ` (${p.games_missed} games missed)`;
      h += `</li>`;
    }
    h += `</ul>`;
  } else {
    h += `<p>No players are currently expected to return this week.</p>`;
  }

  h += `<p>Players returning from injury often face minutes restrictions and reduced performance in their first games back. Check our <a href="/performance-curves">performance curves</a> to see typical recovery trajectories.</p>`;

  h += `<h3>Related</h3><ul>`;
  h += `<li><a href="/returning-today">Returning Today</a></li>`;
  h += `<li><a href="/performance-curves">Performance Curves</a></li>`;
  h += `<li><a href="/minutes-restriction-after-injury">Minutes Restrictions</a></li>`;
  h += `<li><a href="/recovery-stats">Recovery Statistics</a></li>`;
  h += `<li><a href="/props">Player Props</a></li>`;
  for (const [s, l] of Object.entries(LEAGUE_LABELS)) {
    h += `<li><a href="/${s}-injuries">${l} Injury Report</a></li>`;
  }
  h += `</ul></div>`;
  return h;
}

// Position slug → code mapping (mirrors PositionInjuryHubPage.tsx)
const POSITION_SLUG_MAP = {
  nba: { guard: "G", forward: "F", center: "C" },
  nfl: {
    quarterback: "QB", "running-back": "RB", "wide-receiver": "WR",
    "tight-end": "TE", "offensive-line": "OL", "defensive-line": "DL",
    linebacker: "LB", "defensive-back": "DB", kicker: "K",
  },
  mlb: { pitcher: "P", infielder: "IF", outfielder: "OF", catcher: "C", "designated-hitter": "DH" },
  nhl: { forward: "W", defenseman: "D", goalie: "G" },
  "premier-league": { defender: "DEF", midfielder: "MID", forward: "FWD", goalkeeper: "GK" },
};

const POSITION_LABEL_MAP = {
  nba: { G: "Guards", F: "Forwards", C: "Centers" },
  nfl: { QB: "Quarterbacks", RB: "Running Backs", WR: "Wide Receivers", TE: "Tight Ends", OL: "Offensive Linemen", DL: "Defensive Linemen", LB: "Linebackers", DB: "Defensive Backs", K: "Kickers" },
  mlb: { P: "Pitchers", IF: "Infielders", OF: "Outfielders", C: "Catchers", DH: "Designated Hitters" },
  nhl: { W: "Forwards", D: "Defensemen", G: "Goalies" },
  "premier-league": { DEF: "Defenders", MID: "Midfielders", FWD: "Forwards", GK: "Goalkeepers" },
};

function positionInjuryHubContent(leagueSlug, posSlug, posCode, posLabel, curvesForPosition) {
  const label = LEAGUE_LABELS[leagueSlug] ?? leagueSlug.toUpperCase();
  const year = new Date().getFullYear();
  const sorted = curvesForPosition.sort((a, b) => b.sample_size - a.sample_size);

  let h = `<div style="max-width:48rem;margin:0 auto;padding:1rem">`;
  h += `<nav><a href="/">Home</a> / <a href="/${leagueSlug}-injuries">${esc(label)} Injuries</a> / ${esc(posLabel)}</nav>`;
  h += `<h1>${esc(label)} ${esc(posLabel)} Injuries (${year})</h1>`;
  h += `<p>How do ${esc(label)} ${esc(posLabel.toLowerCase())} perform after injury? Analysis of ${sorted.length} injury types ranked by frequency.</p>`;

  if (sorted.length > 0) {
    h += `<h2>Injury Types by Frequency</h2>`;
    h += `<table><thead><tr><th>Injury</th><th>Cases</th><th>Recovery</th><th>G10 %</th></tr></thead><tbody>`;
    for (const c of sorted) {
      const g10 = c.game10 != null ? `${Math.round(c.game10 * 100)}%` : "—";
      const recov = c.recovery_avg != null ? `${Math.round(c.recovery_avg)}d` : "—";
      h += `<tr><td><a href="/${leagueSlug}/${esc(slugify(c.injury_type))}-injury-performance/${esc(posSlug)}">${esc(c.injury_type)}</a></td>`;
      h += `<td>${c.sample_size}</td><td>${recov}</td><td>${g10}</td></tr>`;
    }
    h += `</tbody></table>`;
  }

  // Other positions in this league
  h += `<h3>Other Positions</h3><ul>`;
  for (const [slug, code] of Object.entries(POSITION_SLUG_MAP[leagueSlug] ?? {})) {
    if (slug === posSlug) continue;
    const otherLabel = POSITION_LABEL_MAP[leagueSlug]?.[code] ?? code;
    h += `<li><a href="/${leagueSlug}/${slug}-injuries">${esc(label)} ${esc(otherLabel)} Injuries</a></li>`;
  }
  h += `</ul>`;

  h += `<h3>Related</h3><ul>`;
  h += `<li><a href="/${leagueSlug}-injuries">${esc(label)} Injury Report</a></li>`;
  h += `<li><a href="/${leagueSlug}-injury-performance">${esc(label)} Injury Performance</a></li>`;
  h += `<li><a href="/performance-curves">All Performance Curves</a></li>`;
  h += `</ul></div>`;
  return h;
}

// --- Sitemap generation ---
function generateSitemapIndex(segments) {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  for (const seg of segments) {
    xml += `  <sitemap>\n    <loc>${SITE}/${seg.file}</loc>\n    <lastmod>${new Date().toISOString().slice(0, 10)}</lastmod>\n  </sitemap>\n`;
  }
  xml += '</sitemapindex>';
  return xml;
}

function generateSitemapSegment(urls) {
  const today = new Date().toISOString().slice(0, 10);
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  for (const u of urls) {
    xml += `  <url>\n    <loc>${SITE}${u.loc}</loc>\n    <lastmod>${today}</lastmod>\n`;
    xml += `    <changefreq>${u.changefreq ?? "daily"}</changefreq>\n`;
    xml += `    <priority>${u.priority ?? "0.5"}</priority>\n  </url>\n`;
  }
  xml += '</urlset>';
  return xml;
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
    const batch = await sbGet("back_in_play_injuries", `select=injury_id,player_id,injury_type,status,date_injured,return_date,expected_return,games_missed,recovery_days,side,rank_at_injury&date_injured=gte.${cutoff}&order=date_injured.desc&limit=1000&offset=${offset}`);
    allInjuries.push(...batch);
    if (batch.length < 1000) break;
    offset += 1000;
  }
  console.log(`Prerender: ${allInjuries.length} recent injuries`);

  // Fetch ALL injuries (full history for player pages — healthy players show past injuries)
  let fullInjuries = [];
  offset = 0;
  while (true) {
    const batch = await sbGet("back_in_play_injuries", `select=injury_id,player_id,injury_type,status,date_injured,return_date,expected_return,games_missed,recovery_days,side&order=date_injured.desc&limit=1000&offset=${offset}`);
    fullInjuries.push(...batch);
    if (batch.length < 1000) break;
    offset += 1000;
  }
  console.log(`Prerender: ${fullInjuries.length} total injuries (all time)`);

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

  // Build injuries by player (recent — for league/team pages)
  const injByPlayer = new Map();
  for (const inj of allInjuries) {
    if (!injByPlayer.has(inj.player_id)) injByPlayer.set(inj.player_id, []);
    injByPlayer.get(inj.player_id).push(inj);
  }

  // Build ALL injuries by player (full history — for player pages)
  const allInjByPlayer = new Map();
  for (const inj of fullInjuries) {
    if (!allInjByPlayer.has(inj.player_id)) allInjByPlayer.set(inj.player_id, []);
    allInjByPlayer.get(inj.player_id).push(inj);
  }

  // Enrich injuries with player data for league/team pages
  const enrichedInjuries = allInjuries.map(inj => {
    const p = playerById.get(inj.player_id);
    return {
      ...inj,
      player_name: p?.player_name ?? "Unknown",
      player_slug: p?.slug ?? "",
      position: p?.position ?? "",
      team_name: p?.team_name ?? "",
      league_slug: p?.league_slug ?? "",
      league_name: p?.league_name ?? "",
      league_rank: p?.league_rank ?? null,
      preseason_rank: p?.preseason_rank ?? null,
      rank_at_injury: inj.rank_at_injury ?? null,
      headshot_url: p?.headshot_url ?? null,
      espn_id: null,
      is_star: p?.is_star ?? false,
      is_starter: p?.is_starter ?? false,
    };
  }).filter(inj => inj.player_name !== "Unknown");

  let pageCount = 0;

  // 1. Homepage — mirror useTopPlayerInjuries() client query:
  //    injuries with rank_at_injury <= 50 OR player league_rank/preseason_rank <= 50
  const cutoff60 = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
  const topInjuries = enrichedInjuries
    .filter(i => i.status !== "returned" && i.status !== "active")
    .filter(i => i.date_injured >= cutoff60)
    .filter(i =>
      (i.rank_at_injury != null && i.rank_at_injury <= 50) ||
      (i.league_rank != null && i.league_rank <= 50) ||
      (i.preseason_rank != null && i.preseason_rank <= 50) ||
      i.is_star
    )
    .slice(0, 100);
  writePage("/", {
    title: "Back In Play - Sports Injury Tracker & Return Dates",
    description: "Live sports injury updates for NBA, NFL, MLB, NHL, and EPL. Track player injuries, expected return dates, status changes, and recovery timelines.",
    content: homeContent(leagues, topInjuries),
    preloadedQueries: [
      [["bip-top-injuries"], topInjuries.slice(0, 80)],
    ],
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
      preloadedQueries: [
        [["bip-injuries", slug], leagueInjuries.slice(0, 200)],
      ],
    });
    pageCount++;

    // 3. Team pages
    for (const team of leagueTeams) {
      const teamSlug = slugify(team.team_name);
      const teamInjuries = leagueInjuries.filter(i => i.team_name === team.team_name);

      const teamPageData = {
        team_id: team.team_id,
        team_name: team.team_name,
        league_slug: slug,
        league_name: LEAGUE_FULL[slug] ?? label,
        injuries: teamInjuries.map(inj => ({
          injury_id: inj.injury_id,
          player_name: inj.player_name,
          player_slug: inj.player_slug,
          position: inj.position ?? "",
          injury_type: inj.injury_type,
          status: inj.status,
          date_injured: inj.date_injured,
          expected_return: inj.expected_return ?? null,
          games_missed: inj.games_missed ?? null,
          headshot_url: inj.headshot_url ?? null,
          espn_id: null,
          is_star: inj.is_star ?? false,
          is_starter: inj.is_starter ?? false,
        })),
      };

      writePage(`/${slug}/${teamSlug}-injuries`, {
        title: `${team.team_name} Injuries - ${label} Injury Report`,
        description: `${team.team_name} injury report. Latest injury updates, return dates, and status changes (${label}).`,
        content: teamContent(slug, team.team_name, teamInjuries),
        preloadedQueries: [
          [["team-page", slug, teamSlug], teamPageData],
        ],
      });
      pageCount++;
    }
  }

  // 4. Injury type pages (/injuries/acl, /injuries/hamstring, etc.)
  const injuryTypeMap = new Map(); // injury_type_slug → { type, byLeague }
  for (const inj of enrichedInjuries) {
    const typeSlug = slugify(inj.injury_type);
    if (!typeSlug) continue;
    if (!injuryTypeMap.has(typeSlug)) injuryTypeMap.set(typeSlug, { type: inj.injury_type, byLeague: {} });
    const entry = injuryTypeMap.get(typeSlug);
    if (!entry.byLeague[inj.league_slug]) entry.byLeague[inj.league_slug] = [];
    entry.byLeague[inj.league_slug].push(inj);
  }
  // Also include full history injuries for richer type pages
  for (const inj of fullInjuries) {
    const p = playerById.get(inj.player_id);
    if (!p) continue;
    const typeSlug = slugify(inj.injury_type);
    if (!typeSlug) continue;
    if (!injuryTypeMap.has(typeSlug)) injuryTypeMap.set(typeSlug, { type: inj.injury_type, byLeague: {} });
    const entry = injuryTypeMap.get(typeSlug);
    if (!entry.byLeague[p.league_slug]) entry.byLeague[p.league_slug] = [];
    // Avoid duplicates (recent injuries already added)
    const existing = entry.byLeague[p.league_slug];
    if (!existing.some(e => e.injury_id === inj.injury_id)) {
      existing.push({
        ...inj,
        player_name: p.player_name,
        player_slug: p.slug,
        team_name: p.team_name,
        league_slug: p.league_slug,
      });
    }
  }

  for (const [typeSlug, { type, byLeague }] of injuryTypeMap) {
    const totalCount = Object.values(byLeague).reduce((a, b) => a + b.length, 0);
    if (totalCount < 3) continue; // Skip very rare injury types

    writePage(`/injuries/${typeSlug}`, {
      title: `${type} Injuries (${new Date().getFullYear()}) - Recovery Time & Statistics`,
      description: `${type} injury statistics across NBA, NFL, MLB, NHL, EPL. Average recovery time, games missed, and recent players with ${type.toLowerCase()} injuries.`,
      content: injuryTypeContent(type, typeSlug, byLeague),
    });
    pageCount++;
  }
  console.log(`Prerender: ${injuryTypeMap.size} injury types, ${pageCount} pages so far`);

  // 4b. Cross-league compare pages (/injuries/:slug/compare)
  const crossLeagueTypes = [...injuryTypeMap.entries()]
    .filter(([, { byLeague }]) => Object.keys(byLeague).filter(s => LEAGUE_LABELS[s]).length >= 2)
    .sort((a, b) => {
      const aTotal = Object.values(a[1].byLeague).reduce((s, arr) => s + arr.length, 0);
      const bTotal = Object.values(b[1].byLeague).reduce((s, arr) => s + arr.length, 0);
      return bTotal - aTotal;
    })
    .slice(0, 20);

  for (const [typeSlug, { type, byLeague }] of crossLeagueTypes) {
    const leagueSlugs = Object.keys(byLeague).filter(s => LEAGUE_LABELS[s]);
    let h = `<div style="max-width:48rem;margin:0 auto;padding:1rem">`;
    h += `<nav><a href="/">Home</a> / <a href="/recovery-stats">Injuries</a> / <a href="/injuries/${esc(typeSlug)}">${esc(type)}</a> / Cross-League Compare</nav>`;
    h += `<h1>${esc(type)}: Cross-League Recovery Comparison</h1>`;
    h += `<p>Compare how ${esc(type.toLowerCase())} injuries affect players across ${leagueSlugs.map(s => LEAGUE_LABELS[s]).join(", ")}.</p>`;
    h += `<table><thead><tr><th>League</th><th>Cases</th><th>Avg Recovery Days</th></tr></thead><tbody>`;
    for (const ls of leagueSlugs) {
      const injs = byLeague[ls];
      const recovDays = injs.filter(i => i.recovery_days > 0).map(i => i.recovery_days);
      const avg = recovDays.length > 0 ? Math.round(recovDays.reduce((a, b) => a + b, 0) / recovDays.length) : null;
      h += `<tr><td><a href="/${ls}/${typeSlug}-recovery">${esc(LEAGUE_LABELS[ls])}</a></td><td>${injs.length}</td><td>${avg ?? "—"}</td></tr>`;
    }
    h += `</tbody></table>`;
    h += `<h2>Related</h2><ul>`;
    h += `<li><a href="/injuries/${esc(typeSlug)}">${esc(type)} Overview</a></li>`;
    for (const ls of leagueSlugs) {
      h += `<li><a href="/${ls}/${typeSlug}-recovery">${esc(type)} Recovery in the ${esc(LEAGUE_LABELS[ls])}</a></li>`;
    }
    h += `</ul></div>`;

    writePage(`/injuries/${typeSlug}/compare`, {
      title: `${type} Recovery: Cross-League Comparison (${new Date().getFullYear()})`,
      description: `Compare ${type.toLowerCase()} recovery times across ${leagueSlugs.map(s => LEAGUE_LABELS[s]).join(", ")}. Per-league recovery days, games missed, and return performance.`,
      content: h,
    });
    pageCount++;
  }
  console.log(`Prerender: ${crossLeagueTypes.length} cross-league compare pages`);

  // 5. Player pages + return date pages
  // Generate for: players with injury history, stars, starters (skip unknowns with no history)
  for (const [playerId, player] of playerById) {
    const injuries = injByPlayer.get(playerId) ?? [];
    const allPlayerInjuries = allInjByPlayer.get(playerId) ?? injuries;
    const displayInjuries = injuries.length > 0 ? injuries : allPlayerInjuries;

    // Filter out "active" status entries — these aren't real injuries
    const realInjuries = displayInjuries.filter(i => i.status !== "active");

    // Only generate pages for players with injury history OR notable players
    const hasInjuryHistory = realInjuries.length > 0;
    const isNotable = player.is_star || player.is_starter || (player.league_rank && player.league_rank <= 200);
    if (!hasInjuryHistory && !isNotable) continue;

    const label = LEAGUE_LABELS[player.league_slug] ?? "";
    const year = new Date().getFullYear();

    const current = realInjuries[0];
    const title = `${player.player_name} Injury History & Performance After Injury (${label})`;

    const description = current
      ? `${player.player_name} injury status: ${current.status.replace(/_/g, " ")}. ${current.injury_type}. ${player.team_name} (${label}).`
      : `${player.player_name} injury status and history. ${player.team_name} (${label}). Currently healthy.`;

    // Build PlayerPageData for React Query hydration
    const playerPageData = {
      player_id: player.player_id,
      player_name: player.player_name,
      slug: player.slug,
      position: player.position ?? "",
      team_id: player.team_id ?? "",
      team_name: player.team_name,
      team_slug: slugify(player.team_name),
      league_slug: player.league_slug,
      league_name: player.league_name,
      league_id: player.league_id ?? "",
      headshot_url: player.headshot_url ?? null,
      espn_id: null,
      is_star: player.is_star ?? false,
      is_starter: player.is_starter ?? false,
      league_rank: player.league_rank ?? null,
      preseason_rank: null,
      injuries: displayInjuries.map(inj => ({
        injury_id: inj.injury_id,
        injury_type: inj.injury_type,
        injury_description: null,
        date_injured: inj.date_injured,
        return_date: inj.return_date ?? null,
        status: inj.status,
        expected_return: inj.expected_return ?? null,
        games_missed: inj.games_missed ?? null,
        recovery_days: inj.recovery_days ?? null,
        side: inj.side ?? null,
        long_comment: null,
        short_comment: null,
      })),
      statusChanges: [],
      injuredTeammates: [],
    };
    const playerPreload = [[["player-page", player.slug], playerPageData]];

    // /player/{slug} page
    writePage(`/player/${player.slug}`, {
      title,
      description,
      content: playerContent(player, displayInjuries),
      preloadedQueries: playerPreload,
    });
    pageCount++;

    // /injury/{slug} page (same content, different URL for SEO)
    writePage(`/injury/${player.slug}`, {
      title,
      description,
      content: playerContent(player, displayInjuries),
      preloadedQueries: playerPreload,
    });
    pageCount++;

    // Return date page (only for players with injury history)
    if (displayInjuries.length > 0) {
      writePage(`/${player.slug}-return-date`, {
        title: `${player.player_name} Return Date (${year}) - Latest Injury Update`,
        description: `When will ${player.player_name} return? Latest return date, recovery timeline, and injury updates. ${player.team_name} (${label}).`,
        content: returnDateContent(player, displayInjuries),
      });
      pageCount++;
    }
  }

  // 6. Returning Today pages
  // Find players returning today (status = "returned" with return_date = today)
  const todayISO = new Date().toISOString().slice(0, 10);
  const returningToday = enrichedInjuries.filter(i =>
    (i.status === "returned" || i.status === "active") && i.return_date === todayISO
  ).map(i => ({ slug: i.player_slug, player_name: i.player_name, team_name: i.team_name, injury_type: i.injury_type, league_slug: i.league_slug }));

  writePage("/returning-today", {
    title: `Players Returning From Injury Today (${new Date().getFullYear()})`,
    description: "Which players are returning from injury today? Live tracker for NBA, NFL, MLB, NHL, and EPL players coming back from injury.",
    content: returningTodayContent(null, returningToday),
  });
  pageCount++;

  for (const [slug, label] of Object.entries(LEAGUE_LABELS)) {
    const leagueReturning = returningToday.filter(p => p.league_slug === slug);
    writePage(`/${slug}/returning-today`, {
      title: `${label} Players Returning From Injury Today`,
      description: `Which ${label} players are returning from injury today? Daily return-to-play tracker.`,
      content: returningTodayContent(slug, leagueReturning),
    });
    pageCount++;
  }

  // 7. Performance curves & league injury performance pages
  // Fetch curve summaries from performance_curves table
  let curveSummaries = [];
  try {
    let cOffset = 0;
    while (true) {
      const batch = await sbGet("performance_curves",
        `select=curve_id,league_slug,injury_type,injury_type_slug,position,sample_size,recovery_days_avg,games_missed_avg,median_pct_recent&position=is.null&injury_type_slug=neq.other&order=sample_size.desc&limit=1000&offset=${cOffset}`
      );
      curveSummaries.push(...batch);
      if (batch.length < 1000) break;
      cOffset += 1000;
    }
  } catch (e) {
    console.warn("Prerender: Could not fetch performance_curves:", e.message);
  }

  if (curveSummaries.length > 0) {
    // All-leagues performance curves page
    const allCurveSummary = curveSummaries.map(c => ({
      injury_type: c.injury_type,
      league: LEAGUE_LABELS[c.league_slug] ?? c.league_slug,
      sample_size: c.sample_size,
      game1: Array.isArray(c.median_pct_recent) ? c.median_pct_recent[0] : null,
      game10: Array.isArray(c.median_pct_recent) ? c.median_pct_recent[9] : null,
      recovery_avg: c.recovery_days_avg,
    }));

    writePage("/performance-curves", {
      title: `Post-Injury Performance Curves (${new Date().getFullYear()}) - All Leagues`,
      description: "How do athletes perform after returning from injury? Recovery curves for NBA, NFL, MLB, NHL, and EPL based on historical data.",
      content: performanceCurvesContent(allCurveSummary),
    });
    pageCount++;

    // Per-league injury performance pages
    for (const [slug, label] of Object.entries(LEAGUE_LABELS)) {
      const leagueCurves = curveSummaries
        .filter(c => c.league_slug === slug)
        .map(c => ({
          injury_type: c.injury_type,
          sample_size: c.sample_size,
          game1: Array.isArray(c.median_pct_recent) ? c.median_pct_recent[0] : null,
          game10: Array.isArray(c.median_pct_recent) ? c.median_pct_recent[9] : null,
          recovery_avg: c.recovery_days_avg,
        }));

      writePage(`/${slug}-injury-performance`, {
        title: `${label} Injury Performance Analysis (${new Date().getFullYear()})`,
        description: `How do ${label} players perform after returning from injury? Recovery curves across ${leagueCurves.length} injury types.`,
        content: leagueInjuryPerformanceContent(slug, leagueCurves),
      });
      pageCount++;
    }
  }

  // 8. Recovery stats page
  const injuryTypeStats = [];
  for (const [typeSlug, { type, byLeague }] of injuryTypeMap) {
    const allInjs = Object.values(byLeague).flat();
    const recovDays = allInjs.filter(i => i.recovery_days > 0).map(i => i.recovery_days);
    const missed = allInjs.filter(i => i.games_missed > 0).map(i => i.games_missed);
    injuryTypeStats.push({
      type,
      count: allInjs.length,
      avgRecov: recovDays.length > 0 ? Math.round(recovDays.reduce((a, b) => a + b, 0) / recovDays.length) : null,
      avgMissed: missed.length > 0 ? Math.round(missed.reduce((a, b) => a + b, 0) / missed.length) : null,
    });
  }
  injuryTypeStats.sort((a, b) => b.count - a.count);

  writePage("/recovery-stats", {
    title: `Sports Injury Recovery Statistics (${new Date().getFullYear()})`,
    description: "Recovery statistics for sports injuries across NBA, NFL, MLB, NHL, EPL. Average recovery times, games missed, and severity data.",
    content: recoveryStatsContent(injuryTypeStats),
  });
  pageCount++;

  // 9a. League injury report pages (highest traffic potential)
  for (const [slug, label] of Object.entries(LEAGUE_LABELS)) {
    const leagueInjuries = enrichedInjuries.filter(i => i.league_slug === slug);
    const active = leagueInjuries.filter(i => i.status !== "returned" && i.status !== "active");
    const outCount = active.filter(i => ["out", "ir", "injured_reserve"].includes(i.status)).length;
    const questionable = active.filter(i => ["questionable", "doubtful", "day_to_day", "probable"].includes(i.status)).length;
    const leagueTeams = allTeams.filter(t => teamMap.get(t.team_id)?.league_slug === slug || leagueMap.get(t.league_id)?.slug === slug);

    // Today's date for archive URL
    const todayLong = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

    let h = `<div style="max-width:48rem;margin:0 auto;padding:1rem">`;
    h += `<p style="font-size:11px;color:#666">Updated: ${todayStr()}</p>`;
    h += `<nav><a href="/">Home</a> / <a href="/${slug}-injuries">${esc(label)} Injuries</a> / Injury Report</nav>`;
    h += `<h1>${esc(label)} Injury Report Today &mdash; ${todayStr()}</h1>`;
    h += `<p>${active.length} ${esc(label)} players currently injured. ${outCount} confirmed out, ${questionable} questionable or day-to-day. Updated throughout the day with the latest ${esc(label)} injury news.</p>`;

    // Major injuries
    const majorOut = active.filter(i => ["out", "ir", "injured_reserve"].includes(i.status)).slice(0, 30);
    if (majorOut.length > 0) {
      h += `<h2>Players Out</h2><ul>`;
      for (const inj of majorOut) {
        h += `<li><a href="/player/${esc(inj.player_slug)}">${esc(inj.player_name)}</a> — ${esc(inj.team_name)} — ${esc(inj.injury_type)} (${esc(inj.status.replace(/_/g, " "))})</li>`;
      }
      h += `</ul>`;
    }

    // Questionable
    const quest = active.filter(i => ["questionable", "doubtful", "day_to_day", "probable"].includes(i.status)).slice(0, 20);
    if (quest.length > 0) {
      h += `<h2>Questionable / Day-to-Day</h2><ul>`;
      for (const inj of quest) {
        h += `<li><a href="/player/${esc(inj.player_slug)}">${esc(inj.player_name)}</a> — ${esc(inj.team_name)} — ${esc(inj.injury_type)} (${esc(inj.status.replace(/_/g, " "))})</li>`;
      }
      h += `</ul>`;
    }

    // Returning
    const recentReturn = leagueInjuries.filter(i => (i.status === "returned" || i.status === "active") && i.return_date === todayISO).slice(0, 10);
    if (recentReturn.length > 0) {
      h += `<h2>Players Returning Today</h2><ul>`;
      for (const inj of recentReturn) {
        h += `<li><a href="/player/${esc(inj.player_slug)}">${esc(inj.player_name)}</a> — ${esc(inj.team_name)} — recovered from ${esc(inj.injury_type)}</li>`;
      }
      h += `</ul>`;
    }

    // Analytics text
    const injTypes = new Map();
    for (const inj of active) { injTypes.set(inj.injury_type, (injTypes.get(inj.injury_type) ?? 0) + 1); }
    const topType = [...injTypes.entries()].sort((a, b) => b[1] - a[1])[0];

    h += `<h2>${esc(label)} Injury Analysis</h2>`;
    h += `<p>The ${esc(LEAGUE_FULL[slug] ?? label)} currently has ${active.length} players on the injury report. `;
    if (topType) h += `The most common injury type is ${esc(topType[0])} with ${topType[1]} cases. `;
    h += `This injury report is updated throughout the day as new information becomes available from team reports and official league sources. `;
    h += `For detailed recovery analysis, see our <a href="/${slug}-injury-performance">${esc(label)} performance curves</a> which track how players perform in their first 10 games back from each injury type. `;
    h += `Fantasy ${esc(LEAGUE_SPORT[slug] ?? "sports")} managers and bettors can use our <a href="/${slug}/minutes-restriction-after-injury">minutes restriction data</a> to anticipate workload limitations for returning players.</p>`;

    // Related links
    h += `<h3>Related</h3><ul>`;
    h += `<li><a href="/${slug}-injuries">${esc(label)} Injury Report — Full List</a></li>`;
    h += `<li><a href="/${slug}-injury-performance">${esc(label)} Injury Performance Analysis</a></li>`;
    h += `<li><a href="/${slug}-injury-analysis">${esc(label)} Injury Analysis Hub</a></li>`;
    h += `<li><a href="/${slug}/returning-today">${esc(label)} Players Returning Today</a></li>`;
    h += `<li><a href="/${slug}/minutes-restriction-after-injury">${esc(label)} Minutes Restrictions</a></li>`;
    h += `<li><a href="/performance-curves">All Performance Curves</a></li>`;
    h += `<li><a href="/recovery-stats">Recovery Statistics</a></li>`;
    h += `<li><a href="/props">Player Props</a></li>`;
    for (const [s, l] of Object.entries(LEAGUE_LABELS)) {
      if (s !== slug) h += `<li><a href="/${s}-injury-report">${l} Injury Report</a></li>`;
    }
    h += `</ul></div>`;

    // Write today's report
    writePage(`/${slug}-injury-report`, {
      title: `${label} Injury Report Today (${todayStr()})`,
      description: `${label} injury report for ${todayStr()}. ${active.length} players injured, ${questionable} questionable. Latest ${label} injury updates.`,
      content: h,
    });
    pageCount++;

    // Write dated archive version
    writePage(`/${slug}-injury-report-${todayLong}`, {
      title: `${label} Injury Report — ${todayStr()}`,
      description: `${label} injury report for ${todayStr()}. ${active.length} players injured. Full injury list with return dates.`,
      content: h,
    });
    pageCount++;
  }

  // 9b. League injury analysis hub pages
  for (const [slug, label] of Object.entries(LEAGUE_LABELS)) {
    const leagueCurves = curveSummaries
      .filter(c => c.league_slug === slug)
      .map(c => ({
        injury_type: c.injury_type,
        sample_size: c.sample_size,
        game1: Array.isArray(c.median_pct_recent) ? c.median_pct_recent[0] : null,
        game10: Array.isArray(c.median_pct_recent) ? c.median_pct_recent[9] : null,
        recovery_avg: c.recovery_days_avg,
      }));

    writePage(`/${slug}-injury-analysis`, {
      title: `${label} Injury Analysis (${new Date().getFullYear()})`,
      description: `Comprehensive ${label} injury analysis: recovery data, performance impact, and return-to-play analytics.`,
      content: leagueInjuryAnalysisContent(slug, leagueCurves, []),
    });
    pageCount++;
  }

  // 10. League + injury type performance pages (e.g., /nba/hamstring-injury-performance)
  if (curveSummaries.length > 0) {
    for (const c of curveSummaries) {
      const typeSlug = slugify(c.injury_type);
      if (!typeSlug || typeSlug === "other") continue;
      const curveSummary = {
        injury_type: c.injury_type,
        sample_size: c.sample_size,
        game1: Array.isArray(c.median_pct_recent) ? c.median_pct_recent[0] : null,
        game10: Array.isArray(c.median_pct_recent) ? c.median_pct_recent[9] : null,
        recovery_avg: c.recovery_days_avg,
      };
      const label = LEAGUE_LABELS[c.league_slug] ?? c.league_slug.toUpperCase();

      writePage(`/${c.league_slug}/${typeSlug}-injury-performance`, {
        title: `${c.injury_type} Performance — ${label} (${new Date().getFullYear()})`,
        description: `How do ${label} players perform after ${c.injury_type.toLowerCase()} injuries? ${c.sample_size} cases analyzed.`,
        content: leagueInjuryTypePerformanceContent(c.league_slug, c.injury_type, curveSummary),
      });
      pageCount++;
    }
  }

  // 11. Minutes restriction pages
  const curvesWithMinutes = curveSummaries.map(c => ({
    injury_type: c.injury_type,
    sample_size: c.sample_size,
    minutes_g1: Array.isArray(c.median_pct_recent) ? c.median_pct_recent[0] : null, // approximate
    minutes_g10: Array.isArray(c.median_pct_recent) ? c.median_pct_recent[9] : null,
    league_slug: c.league_slug,
  }));

  writePage("/minutes-restriction-after-injury", {
    title: `Minutes Restriction After Injury (${new Date().getFullYear()})`,
    description: "How long do athletes have minutes restrictions after injury? Data analysis across NBA, NFL, MLB, NHL, EPL.",
    content: minutesRestrictionContent(null, curvesWithMinutes),
  });
  pageCount++;

  for (const [slug, label] of Object.entries(LEAGUE_LABELS)) {
    writePage(`/${slug}/minutes-restriction-after-injury`, {
      title: `${label} Minutes Restriction After Injury`,
      description: `How long do ${label} players have minutes restrictions after injury? Data-driven analysis.`,
      content: minutesRestrictionContent(slug, curvesWithMinutes.filter(c => c.league_slug === slug)),
    });
    pageCount++;
  }

  // 12. Returning this week pages
  const endOfWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const returningThisWeek = enrichedInjuries.filter(i =>
    i.expected_return && i.expected_return >= todayISO && i.expected_return <= endOfWeek &&
    i.status !== "returned" && i.status !== "active"
  ).map(i => ({ slug: i.player_slug, player_name: i.player_name, team_name: i.team_name, injury_type: i.injury_type, league_slug: i.league_slug, games_missed: i.games_missed }));

  writePage("/players-returning-from-injury-this-week", {
    title: `Players Returning This Week (${new Date().getFullYear()})`,
    description: `${returningThisWeek.length} players expected to return from injury this week across NBA, NFL, MLB, NHL, EPL.`,
    content: returningThisWeekContent(null, returningThisWeek),
  });
  pageCount++;

  for (const [slug, label] of Object.entries(LEAGUE_LABELS)) {
    const leagueReturning = returningThisWeek.filter(p => p.league_slug === slug);
    writePage(`/${slug}/players-returning-from-injury-this-week`, {
      title: `${label} Players Returning This Week`,
      description: `${leagueReturning.length} ${label} players expected to return from injury this week.`,
      content: returningThisWeekContent(slug, leagueReturning),
    });
    pageCount++;
  }

  // 14. League-specific recovery stats pages
  for (const [slug, label] of Object.entries(LEAGUE_LABELS)) {
    const leagueStats = injuryTypeStats.filter(s => s.league_slug === slug);
    if (leagueStats.length === 0) continue;
    let h = `<div style="max-width:48rem;margin:0 auto;padding:1rem">`;
    h += `<nav><a href="/">Home</a> / <a href="/recovery-stats">Recovery Stats</a> / ${esc(label)}</nav>`;
    h += `<h1>${esc(label)} Injury Recovery Statistics (${new Date().getFullYear()})</h1>`;
    h += `<p>Recovery timelines for ${leagueStats.length} injury types in the ${esc(label)}, based on historical return-to-play data. Includes average recovery days, games missed, and performance impact after return.</p>`;
    h += `<table><thead><tr><th>Injury</th><th>Median Days</th><th>Cases</th></tr></thead><tbody>`;
    for (const s of leagueStats.slice(0, 30)) {
      h += `<tr><td><a href="/${slug}/${slugify(s.injury_type)}-recovery">${esc(s.injury_type)}</a></td><td>${s.median_recovery_days ?? "—"}</td><td>${s.count}</td></tr>`;
    }
    h += `</tbody></table>`;
    h += `<h2>Related</h2><ul>`;
    h += `<li><a href="/${slug}-injury-performance">${esc(label)} Injury Performance Curves</a></li>`;
    h += `<li><a href="/${slug}-injury-analysis">${esc(label)} Injury Analysis</a></li>`;
    h += `<li><a href="/recovery-stats">All Leagues Recovery Stats</a></li>`;
    h += `</ul></div>`;
    writePage(`/${slug}/recovery-stats`, {
      title: `${label} Injury Recovery Statistics (${new Date().getFullYear()})`,
      description: `How long do ${label} injuries take to heal? Recovery timelines for ${leagueStats.length} injury types based on historical data.`,
      content: h,
    });
    pageCount++;
  }

  // 15. League + injury type recovery pages (e.g., /nba/acl-recovery)
  for (const c of curveSummaries) {
    const typeSlug = slugify(c.injury_type);
    if (!typeSlug || typeSlug === "other" || typeSlug === "unknown") continue;
    const leagueLabel = LEAGUE_LABELS[c.league_slug] ?? c.league_slug.toUpperCase();
    const matchingStat = injuryTypeStats.find(s => slugify(s.injury_type) === typeSlug && s.league_slug === c.league_slug);
    const medianDays = matchingStat?.median_recovery_days ?? null;
    let h = `<div style="max-width:48rem;margin:0 auto;padding:1rem">`;
    h += `<nav><a href="/">Home</a> / <a href="/${c.league_slug}/recovery-stats">${esc(leagueLabel)} Recovery</a> / ${esc(c.injury_type)}</nav>`;
    h += `<h1>${esc(c.injury_type)} Recovery in the ${esc(leagueLabel)} (${new Date().getFullYear()})</h1>`;
    h += `<p>How long does a ${esc(c.injury_type.toLowerCase())} take to recover from in the ${esc(leagueLabel)}? `;
    if (medianDays != null) h += `The median recovery time is ${Math.round(medianDays)} days. `;
    h += `Based on ${c.sample_size} historical cases.</p>`;
    h += `<h2>Key Recovery Stats</h2><ul>`;
    if (medianDays != null) h += `<li>Median recovery: ${Math.round(medianDays)} days</li>`;
    if (c.games_missed_avg != null) h += `<li>Average games missed: ${Math.round(c.games_missed_avg)}</li>`;
    h += `<li>Sample size: ${c.sample_size} cases</li>`;
    h += `</ul>`;
    h += `<h2>Related</h2><ul>`;
    h += `<li><a href="/${c.league_slug}/${typeSlug}-injury-performance">${esc(c.injury_type)} Performance After Return (${esc(leagueLabel)})</a></li>`;
    h += `<li><a href="/injuries/${typeSlug}">${esc(c.injury_type)} Recovery Across All Leagues</a></li>`;
    h += `<li><a href="/${c.league_slug}/recovery-stats">${esc(leagueLabel)} Recovery Stats</a></li>`;
    h += `</ul></div>`;
    writePage(`/${c.league_slug}/${typeSlug}-recovery`, {
      title: `${c.injury_type} Recovery Time in the ${leagueLabel} (${new Date().getFullYear()})`,
      description: `${c.injury_type} recovery timeline in the ${leagueLabel}. ${medianDays != null ? `Median ${Math.round(medianDays)} days.` : ""} ${c.sample_size} historical cases analyzed.`,
      content: h,
    });
    pageCount++;
  }

  // 16. Position injury hub pages (e.g., /nba/guard-injuries)
  let posCurves = [];
  if (curveSummaries.length > 0) {
    // Fetch position-specific curves (position != "")
    try {
      let pcOffset = 0;
      while (true) {
        const batch = await sbGet("performance_curves",
          `select=curve_id,league_slug,injury_type,injury_type_slug,position,sample_size,recovery_days_avg,games_missed_avg,median_pct_recent&position=neq.&injury_type_slug=neq.other&sample_size=gte.3&order=sample_size.desc&limit=1000&offset=${pcOffset}`
        );
        posCurves.push(...batch);
        if (batch.length < 1000) break;
        pcOffset += 1000;
      }
    } catch (e) {
      console.warn("Prerender: Could not fetch position curves:", e.message);
    }

    // Build lookup: position code → group code per league (from GROUPS_BY_LEAGUE)
    const GROUPS_BY_LEAGUE = {
      nba: { G: ["G", "PG", "SG"], F: ["F", "PF", "SF"] },
      nhl: { W: ["W", "LW", "RW"], D: ["D", "LD", "RD"] },
      nfl: {
        QB: ["QB", "Quarterback"], RB: ["RB", "Running Back", "FB", "Fullback"],
        WR: ["WR", "Wide Receiver"], TE: ["TE", "Tight End"],
        OL: ["OL", "OT", "G", "C", "Center", "Guard", "LT", "RT", "Offensive Tackle", "T", "LS", "Long Snapper"],
        DL: ["DL", "DE", "DT", "Defensive End", "Defensive Tackle"],
        LB: ["LB", "ILB", "OLB", "Linebacker"],
        DB: ["CB", "S", "SS", "FS", "Cornerback", "Safety"],
        K: ["K", "Kicker", "P", "Punter"],
      },
      mlb: { P: ["SP", "RP", "LHP", "RHP"], IF: ["1B", "2B", "3B", "SS"], OF: ["OF", "LF", "CF", "RF"] },
      "premier-league": { DEF: ["CB", "DF", "DEF"], MID: ["CM", "MID"], FWD: ["FWD", "RW", "LW"] },
    };

    for (const [leagueSlug, positions] of Object.entries(POSITION_SLUG_MAP)) {
      const label = LEAGUE_LABELS[leagueSlug] ?? leagueSlug.toUpperCase();
      const leagueGroups = GROUPS_BY_LEAGUE[leagueSlug] ?? {};

      for (const [posSlug, posCode] of Object.entries(positions)) {
        // Find curves matching this position group
        const groupMembers = leagueGroups[posCode] ?? [posCode];
        const matching = posCurves.filter(c =>
          c.league_slug === leagueSlug && groupMembers.includes(c.position)
        );

        // Aggregate by injury type (sum sample sizes across sub-positions)
        const byType = new Map();
        for (const c of matching) {
          const key = c.injury_type_slug;
          if (!byType.has(key)) {
            byType.set(key, {
              injury_type: c.injury_type,
              sample_size: 0,
              recovery_avg: null,
              game10: null,
              _recovSum: 0, _recovCount: 0,
              _g10Sum: 0, _g10Count: 0,
            });
          }
          const agg = byType.get(key);
          agg.sample_size += c.sample_size;
          if (c.recovery_days_avg != null) { agg._recovSum += c.recovery_days_avg * c.sample_size; agg._recovCount += c.sample_size; }
          const g10 = Array.isArray(c.median_pct_recent) ? c.median_pct_recent[9] : null;
          if (g10 != null) { agg._g10Sum += g10 * c.sample_size; agg._g10Count += c.sample_size; }
        }
        const aggregated = [...byType.values()].map(a => ({
          ...a,
          recovery_avg: a._recovCount > 0 ? a._recovSum / a._recovCount : null,
          game10: a._g10Count > 0 ? a._g10Sum / a._g10Count : null,
        }));

        if (aggregated.length === 0) continue;

        const posLabel = POSITION_LABEL_MAP[leagueSlug]?.[posCode] ?? posCode;
        writePage(`/${leagueSlug}/${posSlug}-injuries`, {
          title: `${label} ${posLabel} Injuries (${new Date().getFullYear()})`,
          description: `How do ${label} ${posLabel.toLowerCase()} perform after injury? ${aggregated.length} injury types analyzed.`,
          content: positionInjuryHubContent(leagueSlug, posSlug, posCode, posLabel, aggregated),
        });
        pageCount++;
      }
    }
    console.log(`Prerender: Position injury hub pages generated`);

    // Position + injury recovery pages (e.g., /nba/guards/acl-recovery)
    const POS_SLUG_TO_PLURAL = {
      guard: "guards", forward: "forwards", center: "centers",
      quarterback: "quarterbacks", "running-back": "running-backs",
      "wide-receiver": "wide-receivers", "tight-end": "tight-ends",
      "offensive-line": "offensive-linemen", "defensive-line": "defensive-linemen",
      linebacker: "linebackers", "defensive-back": "defensive-backs", kicker: "kickers",
      pitcher: "pitchers", infielder: "infielders", outfielder: "outfielders",
      catcher: "catchers", "designated-hitter": "designated-hitters",
      defenseman: "defensemen", goalie: "goalies",
      defender: "defenders", midfielder: "midfielders",
      goalkeeper: "goalkeepers",
    };

    for (const [leagueSlug, positions] of Object.entries(POSITION_SLUG_MAP)) {
      const label = LEAGUE_LABELS[leagueSlug] ?? leagueSlug.toUpperCase();
      const leagueGroups = GROUPS_BY_LEAGUE[leagueSlug] ?? {};

      for (const [posSlug, posCode] of Object.entries(positions)) {
        const posPlural = POS_SLUG_TO_PLURAL[posSlug] ?? posSlug + "s";
        const posLabel = POSITION_LABEL_MAP[leagueSlug]?.[posCode] ?? posCode;
        const groupMembers = leagueGroups[posCode] ?? [posCode];
        const matching = posCurves.filter(c =>
          c.league_slug === leagueSlug && groupMembers.includes(c.position) && c.sample_size >= 30
        );

        // Group by injury type
        const byInjury = new Map();
        for (const c of matching) {
          const key = c.injury_type_slug;
          if (!byInjury.has(key)) {
            byInjury.set(key, { injury_type: c.injury_type, sample_size: 0, recovery_avg: null, game10: null, _recovSum: 0, _recovCount: 0, _g10Sum: 0, _g10Count: 0 });
          }
          const agg = byInjury.get(key);
          agg.sample_size += c.sample_size;
          if (c.recovery_days_avg != null) { agg._recovSum += c.recovery_days_avg * c.sample_size; agg._recovCount += c.sample_size; }
          const g10 = Array.isArray(c.median_pct_recent) ? c.median_pct_recent[9] : null;
          if (g10 != null) { agg._g10Sum += g10 * c.sample_size; agg._g10Count += c.sample_size; }
        }

        for (const [injSlug, agg] of byInjury) {
          if (agg.sample_size < 30) continue;
          const injLabel = injSlug.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
          const recovAvg = agg._recovCount > 0 ? Math.round(agg._recovSum / agg._recovCount) : null;
          const g10Pct = agg._g10Count > 0 ? Math.round((agg._g10Sum / agg._g10Count) * 100) : null;
          const urlPath = `/${leagueSlug}/${posPlural}/${injSlug}-recovery`;
          const year = new Date().getFullYear();

          let content = `<h1>${esc(label)} ${esc(posLabel)} ${esc(injLabel)} Recovery (${year})</h1>`;
          content += `<p>${esc(injLabel)} recovery data for ${esc(label)} ${esc(posLabel.toLowerCase())}. ${agg.sample_size} cases analyzed.</p>`;
          content += `<ul>`;
          content += `<li>Sample size: ${agg.sample_size}</li>`;
          if (recovAvg != null) content += `<li>Median recovery: ${recovAvg} days</li>`;
          if (g10Pct != null) content += `<li>G10 performance: ${g10Pct}% of baseline</li>`;
          content += `</ul>`;
          content += `<nav><a href="/${leagueSlug}/${posSlug}-injuries">${esc(label)} ${esc(posLabel)} Injuries</a>`;
          content += ` | <a href="/${leagueSlug}/${injSlug}-injury-performance">${esc(injLabel)} Performance in ${esc(label)}</a>`;
          content += ` | <a href="/injuries/${injSlug}/compare">${esc(injLabel)} Cross-League Comparison</a></nav>`;

          writePage(urlPath, {
            title: `${label} ${posLabel} ${injLabel} Recovery (${year})`,
            description: `${injLabel} recovery data for ${label} ${posLabel.toLowerCase()}. ${agg.sample_size} cases.${g10Pct != null ? ` G10: ${g10Pct}%.` : ""}${recovAvg != null ? ` ~${recovAvg} day recovery.` : ""}`,
            content,
          });
          pageCount++;
        }
      }
    }
    console.log(`Prerender: Position injury recovery pages generated`);
  }

  // 13. Seasonal injury analysis pages
  {
    const SEASON_RANGES = {
      nba:              (y) => ({ start: `${y-1}-10-01`, end: `${y}-06-30`, label: `${y-1}-${String(y).slice(2)}` }),
      nhl:              (y) => ({ start: `${y-1}-10-01`, end: `${y}-06-30`, label: `${y-1}-${String(y).slice(2)}` }),
      nfl:              (y) => ({ start: `${y-1}-09-01`, end: `${y}-02-28`, label: `${y-1}-${String(y).slice(2)}` }),
      mlb:              (y) => ({ start: `${y}-03-01`,   end: `${y}-10-31`, label: `${y}` }),
      "premier-league": (y) => ({ start: `${y-1}-08-01`, end: `${y}-05-31`, label: `${y-1}-${String(y).slice(2)}` }),
    };
    const years = [2020, 2021, 2022, 2023, 2024, 2025, 2026];
    for (const [slug, label] of Object.entries(LEAGUE_LABELS)) {
      const full = LEAGUE_FULL[slug] ?? label;
      const rangeFn = SEASON_RANGES[slug];
      if (!rangeFn) continue;
      for (const yr of years) {
        const { start: sStart, end: sEnd, label: sLabel } = rangeFn(yr);
        const urlPath = `/${slug}/${yr}-season-injuries`;
        const title = `${label} ${yr} Season Injuries`;
        const desc = `${full} ${sLabel} season injury analysis. Breakdown by injury type, average recovery times, and return rates for the ${label} ${sLabel} season.`;

        let h = `<div style="max-width:48rem;margin:0 auto;padding:1rem">`;
        h += `<nav><a href="/">Home</a> / <a href="/${slug}-injuries">${esc(label)} Injuries</a> / ${yr} Season</nav>`;
        h += `<h1>${esc(label)} ${esc(sLabel)} Season Injury Analysis</h1>`;
        h += `<p>${esc(desc)}</p>`;
        h += `<p>Season: ${sStart.slice(0,7).replace("-","/")} — ${sEnd.slice(0,7).replace("-","/")}</p>`;

        h += `<h3>Other Seasons</h3><ul>`;
        for (const oy of years) {
          if (oy !== yr) h += `<li><a href="/${slug}/${oy}-season-injuries">${label} ${oy} Season</a></li>`;
        }
        h += `</ul>`;

        h += `<h3>Related</h3><ul>`;
        h += `<li><a href="/${slug}-injuries">${esc(label)} Injury Report</a></li>`;
        h += `<li><a href="/${slug}/recovery-stats">${esc(label)} Recovery Stats</a></li>`;
        h += `<li><a href="/${slug}-injury-performance">${esc(label)} Injury Performance</a></li>`;
        h += `</ul></div>`;

        writePage(urlPath, { title, description: desc, content: h });
        pageCount++;
      }
    }
    console.log(`Prerender: Seasonal injury analysis pages generated`);
  }

  console.log(`Prerender: Generated ${pageCount} pages`);

  // 14. Generate segmented sitemaps
  const sitemapUrls = {
    core: [
      { loc: "/", priority: "1.0", changefreq: "hourly" },
      { loc: "/returning-today", priority: "0.8", changefreq: "daily" },
      { loc: "/players-returning-from-injury-this-week", priority: "0.8", changefreq: "daily" },
      { loc: "/performance-curves", priority: "0.7", changefreq: "weekly" },
      { loc: "/recovery-stats", priority: "0.7", changefreq: "weekly" },
      { loc: "/minutes-restriction-after-injury", priority: "0.7", changefreq: "weekly" },
    ],
    leagues: [],
    teams: [],
    injuries: [],
    performance: [],
    players: [],
  };

  // League pages
  for (const [slug, label] of Object.entries(LEAGUE_LABELS)) {
    sitemapUrls.core.push({ loc: `/${slug}/returning-today`, priority: "0.7", changefreq: "daily" });
    sitemapUrls.core.push({ loc: `/${slug}/players-returning-from-injury-this-week`, priority: "0.7", changefreq: "daily" });
    sitemapUrls.core.push({ loc: `/${slug}/minutes-restriction-after-injury`, priority: "0.7", changefreq: "weekly" });
    sitemapUrls.core.push({ loc: `/${slug}/recovery-stats`, priority: "0.7", changefreq: "weekly" });
    sitemapUrls.leagues.push({ loc: `/${slug}-injuries`, priority: "0.9", changefreq: "hourly" });
    sitemapUrls.leagues.push({ loc: `/${slug}-injury-performance`, priority: "0.7", changefreq: "weekly" });
    sitemapUrls.leagues.push({ loc: `/${slug}-injury-analysis`, priority: "0.7", changefreq: "weekly" });
    sitemapUrls.leagues.push({ loc: `/${slug}-injury-report`, priority: "0.9", changefreq: "hourly" });
    // Position injury hub pages
    for (const posSlug of Object.keys(POSITION_SLUG_MAP[slug] ?? {})) {
      sitemapUrls.leagues.push({ loc: `/${slug}/${posSlug}-injuries`, priority: "0.6", changefreq: "weekly" });
    }
    // Seasonal injury analysis pages
    for (const yr of [2020, 2021, 2022, 2023, 2024, 2025, 2026]) {
      sitemapUrls.leagues.push({ loc: `/${slug}/${yr}-season-injuries`, priority: "0.6", changefreq: "weekly" });
    }
  }

  // League + injury type performance pages + recovery pages
  for (const c of curveSummaries) {
    const typeSlug = slugify(c.injury_type);
    if (typeSlug && typeSlug !== "other" && typeSlug !== "unknown") {
      sitemapUrls.performance.push({ loc: `/${c.league_slug}/${typeSlug}-injury-performance`, priority: "0.6", changefreq: "weekly" });
      sitemapUrls.injuries.push({ loc: `/${c.league_slug}/${typeSlug}-recovery`, priority: "0.6", changefreq: "weekly" });
    }
  }

  // Position + injury recovery pages in sitemap (e.g., /nba/guards/acl-recovery)
  {
    const POS_PLURAL_SM = {
      guard: "guards", forward: "forwards", center: "centers",
      quarterback: "quarterbacks", "running-back": "running-backs",
      "wide-receiver": "wide-receivers", "tight-end": "tight-ends",
      "offensive-line": "offensive-linemen", "defensive-line": "defensive-linemen",
      linebacker: "linebackers", "defensive-back": "defensive-backs", kicker: "kickers",
      pitcher: "pitchers", infielder: "infielders", outfielder: "outfielders",
      catcher: "catchers", "designated-hitter": "designated-hitters",
      defenseman: "defensemen", goalie: "goalies",
      defender: "defenders", midfielder: "midfielders", goalkeeper: "goalkeepers",
    };
    const GROUPS_SM = {
      nba: { G: ["G", "PG", "SG"], F: ["F", "PF", "SF"] },
      nhl: { W: ["W", "LW", "RW"], D: ["D", "LD", "RD"] },
      nfl: { QB: ["QB", "Quarterback"], RB: ["RB", "Running Back", "FB"], WR: ["WR", "Wide Receiver"], TE: ["TE", "Tight End"], OL: ["OL", "OT", "G", "C"], DL: ["DL", "DE", "DT"], LB: ["LB", "ILB", "OLB"], DB: ["CB", "S", "SS", "FS"], K: ["K", "P"] },
      mlb: { P: ["SP", "RP", "LHP", "RHP"], IF: ["1B", "2B", "3B", "SS"], OF: ["OF", "LF", "CF", "RF"] },
      "premier-league": { DEF: ["CB", "DF", "DEF"], MID: ["CM", "MID"], FWD: ["FWD", "RW", "LW"] },
    };
    const pcForSm = posCurves.filter(c => c.sample_size >= 30);
    const seenLocs = new Set();
    for (const [ls, positions] of Object.entries(POSITION_SLUG_MAP)) {
      const lg = GROUPS_SM[ls] ?? {};
      for (const [ps, pc] of Object.entries(positions)) {
        const plural = POS_PLURAL_SM[ps] ?? ps + "s";
        const members = lg[pc] ?? [pc];
        const byInj = new Map();
        for (const c of pcForSm) {
          if (c.league_slug !== ls || !members.includes(c.position)) continue;
          byInj.set(c.injury_type_slug, (byInj.get(c.injury_type_slug) ?? 0) + c.sample_size);
        }
        for (const [injSlug, total] of byInj) {
          if (total < 30) continue;
          const loc = `/${ls}/${plural}/${injSlug}-recovery`;
          if (!seenLocs.has(loc)) { seenLocs.add(loc); sitemapUrls.performance.push({ loc, priority: "0.5", changefreq: "weekly" }); }
        }
      }
    }
  }

  // Team pages
  for (const league of leagues) {
    const leagueTeams = allTeams.filter(t => t.league_id === league.league_id);
    for (const t of leagueTeams) {
      sitemapUrls.teams.push({ loc: `/${league.slug}/${slugify(t.team_name)}-injuries`, priority: "0.8", changefreq: "daily" });
    }
  }

  // Injury type pages
  for (const [typeSlug] of injuryTypeMap) {
    sitemapUrls.injuries.push({ loc: `/injuries/${typeSlug}`, priority: "0.6", changefreq: "weekly" });
  }

  // Cross-league compare pages
  for (const [typeSlug] of crossLeagueTypes) {
    sitemapUrls.injuries.push({ loc: `/injuries/${typeSlug}/compare`, priority: "0.6", changefreq: "weekly" });
  }

  // Player pages
  for (const [, player] of playerById) {
    const injuries = injByPlayer.get(player.player_id) ?? allInjByPlayer.get(player.player_id) ?? [];
    const realInj = injuries.filter(i => i.status !== "active");
    const isNotable = player.is_star || player.is_starter || (player.league_rank && player.league_rank <= 200);
    if (realInj.length === 0 && !isNotable) continue;
    sitemapUrls.players.push({ loc: `/player/${player.slug}`, priority: "0.7", changefreq: "daily" });
    if (realInj.length > 0 || isNotable) {
      sitemapUrls.players.push({ loc: `/${player.slug}-return-date`, priority: "0.8", changefreq: "daily" });
    }
  }

  // Write segment files
  const segments = [];
  for (const [name, urls] of Object.entries(sitemapUrls)) {
    if (urls.length === 0) continue;
    const filename = `sitemap-${name}.xml`;
    fs.writeFileSync(path.join(DIST, filename), generateSitemapSegment(urls));
    segments.push({ file: filename });
  }

  // Write sitemap index
  fs.writeFileSync(path.join(DIST, "sitemap.xml"), generateSitemapIndex(segments));
  const totalUrls = Object.values(sitemapUrls).reduce((s, u) => s + u.length, 0);
  console.log(`Prerender: Sitemap index with ${segments.length} segments, ${totalUrls} total URLs`);
}

main().catch((err) => {
  console.error("Prerender error:", err);
  // Don't fail the build — the SPA still works without prerendering
  process.exit(0);
});
