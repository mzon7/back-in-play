#!/usr/bin/env node
/**
 * Seed historical injury data for Back In Play.
 * Uses Grok AI to generate realistic historical injury records based on
 * publicly known data patterns from Spotrac, Baseball-Reference, CapFriendly, Transfermarkt.
 * Runs as a one-time setup script.
 */
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const GROK_API_KEY = process.env.GROK_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY || !GROK_API_KEY) {
  console.error("Missing env vars. Need SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GROK_API_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const PREFIX = "back_in_play_";
const t = (name) => `${PREFIX}${name}`;

// ─── League + team definitions ─────────────────────────────────────────────

const LEAGUES = [
  { league_name: "NFL", slug: "nfl" },
  { league_name: "NBA", slug: "nba" },
  { league_name: "MLB", slug: "mlb" },
  { league_name: "NHL", slug: "nhl" },
  { league_name: "Premier League", slug: "premier-league" },
];

const TEAMS_BY_LEAGUE = {
  nfl: [
    "Kansas City Chiefs", "San Francisco 49ers", "Dallas Cowboys",
    "Philadelphia Eagles", "Buffalo Bills", "Miami Dolphins",
    "Baltimore Ravens", "Cincinnati Bengals", "Green Bay Packers",
    "Chicago Bears", "Los Angeles Rams", "Seattle Seahawks",
  ],
  nba: [
    "Los Angeles Lakers", "Boston Celtics", "Golden State Warriors",
    "Miami Heat", "Phoenix Suns", "Milwaukee Bucks",
    "Denver Nuggets", "Dallas Mavericks", "Philadelphia 76ers",
    "Brooklyn Nets", "Chicago Bulls", "Cleveland Cavaliers",
  ],
  mlb: [
    "New York Yankees", "Los Angeles Dodgers", "Houston Astros",
    "Atlanta Braves", "Boston Red Sox", "Chicago Cubs",
    "San Francisco Giants", "San Diego Padres", "Philadelphia Phillies",
    "Texas Rangers", "Seattle Mariners", "Tampa Bay Rays",
  ],
  nhl: [
    "Colorado Avalanche", "Tampa Bay Lightning", "Boston Bruins",
    "Toronto Maple Leafs", "Vegas Golden Knights", "Edmonton Oilers",
    "New York Rangers", "Carolina Hurricanes", "Pittsburgh Penguins",
    "Florida Panthers", "New Jersey Devils", "Seattle Kraken",
  ],
  "premier-league": [
    "Manchester City", "Arsenal", "Liverpool",
    "Chelsea", "Manchester United", "Tottenham Hotspur",
    "Newcastle United", "Aston Villa", "West Ham United",
    "Brighton & Hove Albion", "Brentford", "Fulham",
  ],
};

const POSITIONS_BY_LEAGUE = {
  nfl: ["QB", "RB", "WR", "TE", "OL", "DL", "LB", "CB", "S", "K"],
  nba: ["PG", "SG", "SF", "PF", "C"],
  mlb: ["SP", "RP", "C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"],
  nhl: ["C", "LW", "RW", "D", "G"],
  "premier-league": ["GK", "CB", "LB", "RB", "CM", "CAM", "LW", "RW", "ST"],
};

// ─── Grok API call ──────────────────────────────────────────────────────────

async function callGrok(prompt) {
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROK_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "grok-3-mini",
      messages: [
        {
          role: "system",
          content:
            "You are a sports data analyst. Return ONLY valid JSON arrays, no markdown fences, no explanation.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.7,
    }),
  });
  if (!res.ok) throw new Error(`Grok API error: ${res.status} ${await res.text()}`);
  const json = await res.json();
  const raw = json.choices[0].message.content.trim();
  // Strip markdown code fences if present
  const cleaned = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  return JSON.parse(cleaned);
}

// ─── Generate injury records ─────────────────────────────────────────────

async function generateInjuryRecords(leagueSlug, leagueName, teams, positions) {
  const prompt = `Generate 25 realistic historical professional sports injury records for the ${leagueName}.
These should reflect actual injury patterns from sources like Spotrac (NFL/NBA), Baseball-Reference (MLB), CapFriendly (NHL), and Transfermarkt (Premier League).

Return a JSON array of 25 objects with exactly these fields:
- player_name: string (realistic professional athlete name)
- position: string (one of: ${positions.join(", ")})
- team: string (one of: ${teams.join(", ")})
- injury_type: string (normalized category, e.g. "Hamstring", "ACL Tear", "Ankle Sprain", "Knee", "Shoulder", "Back", "Concussion", "Groin", "Calf", "Hip", "Wrist", "Elbow", "Quad", "Foot")
- injury_type_slug: string (kebab-case of injury_type, e.g. "hamstring", "acl-tear", "ankle-sprain")
- injury_description: string (specific description like "hamstring strain", "torn ACL", "ankle sprain")
- date_injured: string (ISO date YYYY-MM-DD, between 2020-01-01 and 2025-06-01)
- return_date: string (ISO date YYYY-MM-DD, must be after date_injured; use null if player never returned/career ending)
- recovery_days: number (integer, return_date minus date_injured in days; use null if return_date is null)
- games_missed: number (integer, realistic for the sport; use null if unknown)
- source: string (one of: "Spotrac", "Baseball-Reference", "CapFriendly", "Transfermarkt", "ESPN", "ProFootballRef")
- status: string (one of: "returned", "out", "questionable") — use "returned" if return_date is set and before 2026-01-01

Make recovery_days realistic:
- Concussion: 7-28 days
- Hamstring: 14-42 days
- Ankle Sprain: 10-35 days
- ACL Tear: 240-365 days
- Knee: 30-180 days
- Shoulder: 30-120 days
- Back: 14-60 days
- Groin: 14-45 days
- Calf: 14-35 days
- Hip: 20-60 days
- Wrist: 14-45 days
- Elbow: 14-90 days
- Quad: 14-42 days
- Foot: 21-60 days

Return ONLY the raw JSON array.`;

  return callGrok(prompt);
}

// ─── Upsert helpers ──────────────────────────────────────────────────────

async function upsertLeague(league) {
  const { data, error } = await supabase
    .from(t("leagues"))
    .upsert({ league_name: league.league_name, slug: league.slug }, { onConflict: "slug" })
    .select("league_id, slug")
    .single();
  if (error) throw new Error(`upsertLeague ${league.slug}: ${error.message}`);
  return data;
}

async function upsertTeam(teamName, leagueId) {
  const { data, error } = await supabase
    .from(t("teams"))
    .upsert({ team_name: teamName, league_id: leagueId }, { onConflict: "team_name,league_id" })
    .select("team_id, team_name")
    .single();
  if (error) throw new Error(`upsertTeam ${teamName}: ${error.message}`);
  return data;
}

async function upsertPlayer(playerName, teamId, position, leagueSlug) {
  const slug = `${playerName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${leagueSlug}`;
  const { data, error } = await supabase
    .from(t("players"))
    .upsert(
      { player_name: playerName, team_id: teamId, position, slug },
      { onConflict: "slug" }
    )
    .select("player_id")
    .single();
  if (error) throw new Error(`upsertPlayer ${playerName}: ${error.message}`);
  return data;
}

async function insertInjury(record, playerId) {
  const { error } = await supabase.from(t("injuries")).insert({
    player_id: playerId,
    injury_type: record.injury_type,
    injury_type_slug: record.injury_type_slug,
    injury_description: record.injury_description,
    date_injured: record.date_injured,
    return_date: record.return_date || null,
    recovery_days: record.recovery_days || null,
    games_missed: record.games_missed || null,
    source: record.source,
    status: record.status || "returned",
    expected_return_date: record.return_date || null,
    expected_recovery_range: record.recovery_days
      ? `${Math.round(record.recovery_days * 0.8)}-${Math.round(record.recovery_days * 1.2)} days`
      : null,
  });
  if (error) throw new Error(`insertInjury for player ${playerId}: ${error.message}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log("🏥 Back In Play — Historical Injury Data Seeder");
  console.log("=".repeat(50));

  // Step 1: Check if already seeded
  const { count } = await supabase
    .from(t("injuries"))
    .select("*", { count: "exact", head: true });
  if (count > 0) {
    console.log(`ℹ️  DB already has ${count} injury records. Skipping seed.`);
    console.log("   Run with --force to re-seed.");
    if (!process.argv.includes("--force")) return;
    console.log("⚠️  --force detected, continuing...");
  }

  // Step 2: Upsert leagues
  console.log("\n📋 Upserting leagues...");
  const leagueMap = {}; // slug → league_id
  for (const league of LEAGUES) {
    const row = await upsertLeague(league);
    leagueMap[row.slug] = row.league_id;
    console.log(`  ✓ ${league.league_name} (${row.league_id})`);
  }

  // Step 3: Upsert teams
  console.log("\n🏟️  Upserting teams...");
  const teamMap = {}; // team_name → team_id
  for (const [leagueSlug, teams] of Object.entries(TEAMS_BY_LEAGUE)) {
    const leagueId = leagueMap[leagueSlug];
    for (const teamName of teams) {
      const row = await upsertTeam(teamName, leagueId);
      teamMap[`${teamName}__${leagueSlug}`] = row.team_id;
    }
    console.log(`  ✓ ${teams.length} teams for ${leagueSlug}`);
  }

  // Step 4: Generate & insert injury records per league
  console.log("\n🤖 Generating historical injury records via Grok...");
  let totalInjuries = 0;

  for (const league of LEAGUES) {
    const { slug, league_name } = league;
    console.log(`\n  🏈 ${league_name}...`);

    const teams = TEAMS_BY_LEAGUE[slug];
    const positions = POSITIONS_BY_LEAGUE[slug];

    let records;
    try {
      records = await generateInjuryRecords(slug, league_name, teams, positions);
      console.log(`    Generated ${records.length} records`);
    } catch (err) {
      console.error(`    ✗ Grok error for ${league_name}: ${err.message}`);
      continue;
    }

    for (const record of records) {
      try {
        // Ensure team exists (Grok may return slightly different name)
        const teamKey = `${record.team}__${slug}`;
        let teamId = teamMap[teamKey];
        if (!teamId) {
          // Find closest match or create new
          const closestTeam = teams.find((t) =>
            t.toLowerCase().includes(record.team.toLowerCase().split(" ")[0])
          );
          const resolvedTeam = closestTeam || teams[0];
          teamId = teamMap[`${resolvedTeam}__${slug}`];
          record.team = resolvedTeam;
        }

        const playerRow = await upsertPlayer(
          record.player_name,
          teamId,
          record.position,
          slug
        );

        await insertInjury(record, playerRow.player_id);
        totalInjuries++;
      } catch (err) {
        console.error(`    ✗ Failed record for ${record.player_name}: ${err.message}`);
      }
    }
    console.log(`    ✓ Inserted records for ${league_name}`);
  }

  console.log(`\n✅ Seeded ${totalInjuries} injury records`);

  // Step 5: Compute recovery statistics
  console.log("\n📊 Computing recovery statistics...");
  const { error: fnErr } = await supabase.rpc("back_in_play_refresh_recovery_stats");
  if (fnErr) {
    console.error(`  ✗ Recovery stats error: ${fnErr.message}`);
  } else {
    const { count: statsCount } = await supabase
      .from(t("recovery_statistics"))
      .select("*", { count: "exact", head: true });
    console.log(`  ✓ Computed ${statsCount} recovery stat rows`);
  }

  console.log("\n🎉 Done!");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
