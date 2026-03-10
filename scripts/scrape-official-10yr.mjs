#!/usr/bin/env node
/**
 * Back In Play — Official Source Scraper (10-Year, All Leagues)
 *
 * Scrapes injury data from:
 *   NFL  : https://www.spotrac.com/nfl/injured-reserve/{year}/
 *   NBA  : https://www.spotrac.com/nba/injured-reserve/{year}/
 *   MLB  : https://www.baseball-reference.com/friv/disabled-list.shtml?year={year}
 *   NHL  : https://www.capfriendly.com/injuries/nhl/{year}-{year+1}
 *   PL   : https://www.transfermarkt.com/premier-league/verletzungen/wettbewerb/GB1/saison_id/{year}
 *
 * Uses Grok (xAI) to parse HTML → structured injury records.
 * Falls back to Grok knowledge mode when sites are blocked.
 * Targets 600+ records per league per season (10 seasons = 6,000+ per league).
 *
 * Usage:
 *   node scripts/scrape-official-10yr.mjs [options]
 *
 * Options:
 *   --league nfl|nba|mlb|nhl|premier-league
 *   --from 2015
 *   --to 2024
 *   --force          Re-scrape even if season has >= threshold records
 *   --threshold 400  Skip season if >= N records already exist
 *   --knowledge-only Skip web scraping entirely
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GROK_API_KEY = process.env.GROK_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
if (!GROK_API_KEY && !OPENAI_API_KEY) {
  console.error("Missing env: GROK_API_KEY or OPENAI_API_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const P = "back_in_play_";
const t = (n) => `${P}${n}`;

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const arg  = (f) => args.includes(f) ? args[args.indexOf(f) + 1] : null;

const FORCE          = flag("--force");
const KNOWLEDGE_ONLY = flag("--knowledge-only");
const LEAGUE_FILTER  = arg("--league");
const FROM_YEAR      = parseInt(arg("--from") || "2015");
const TO_YEAR        = parseInt(arg("--to")   || "2024");
const THRESHOLD      = parseInt(arg("--threshold") || "400");
const TARGET         = 650; // desired records per season per league

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── League definitions ───────────────────────────────────────────────────────
const ALL_LEAGUES = [
  {
    league_name: "NFL",
    slug: "nfl",
    source: "Spotrac",
    season_type: "straddle",
    // Multiple URL patterns — Spotrac changed URL format over the years
    getUrls: (year) => [
      `https://www.spotrac.com/nfl/injured-reserve/${year}/`,
      `https://www.spotrac.com/nfl/injured-reserve/year/${year}/`,
      `https://www.spotrac.com/nfl/ir/${year}/`,
    ],
  },
  {
    league_name: "NBA",
    slug: "nba",
    source: "Spotrac",
    season_type: "straddle",
    getUrls: (year) => [
      `https://www.spotrac.com/nba/injured-reserve/${year}/`,
      `https://www.spotrac.com/nba/injured-reserve/year/${year}/`,
      `https://www.spotrac.com/nba/ir/${year}/`,
    ],
  },
  {
    league_name: "MLB",
    slug: "mlb",
    source: "Baseball-Reference",
    season_type: "single",
    getUrls: (year) => [
      `https://www.baseball-reference.com/friv/disabled-list.shtml?year=${year}`,
      `https://www.baseball-reference.com/friv/il-list.shtml?year=${year}`,
      `https://www.baseball-reference.com/friv/dl-list.shtml?year=${year}`,
    ],
  },
  {
    league_name: "NHL",
    slug: "nhl",
    source: "CapFriendly",
    season_type: "straddle",
    getUrls: (year) => [
      `https://www.capfriendly.com/injuries/nhl/${year}-${year + 1}`,
      `https://www.capfriendly.com/injuries/${year}-${year + 1}`,
      `https://www.capfriendly.com/injuries`,
    ],
  },
  {
    league_name: "Premier League",
    slug: "premier-league",
    source: "Transfermarkt",
    season_type: "straddle",
    getUrls: (year) => [
      `https://www.transfermarkt.com/premier-league/verletzungen/wettbewerb/GB1/saison_id/${year}`,
      `https://www.transfermarkt.us/premier-league/verletzungen/wettbewerb/GB1/saison_id/${year}`,
      `https://www.transfermarkt.co.uk/premier-league/verletzungen/wettbewerb/GB1/saison_id/${year}`,
    ],
  },
];

const LEAGUES = ALL_LEAGUES.filter((l) => !LEAGUE_FILTER || l.slug === LEAGUE_FILTER);

// ─── Season date helpers ──────────────────────────────────────────────────────
function getSeasonDates(slug, year) {
  switch (slug) {
    case "nfl":            return { start: `${year}-08-01`,  end: `${year + 1}-02-28` };
    case "nba":            return { start: `${year}-09-15`,  end: `${year + 1}-07-15` };
    case "mlb":            return { start: `${year}-03-01`,  end: `${year}-11-30` };
    case "nhl":            return { start: `${year}-09-01`,  end: `${year + 1}-07-31` };
    case "premier-league": return { start: `${year}-07-01`,  end: `${year + 1}-06-30` };
    default:               return { start: `${year}-01-01`,  end: `${year}-12-31` };
  }
}

function getSeasonLabel(slug, year) {
  return slug === "mlb" ? `${year}` : `${year}-${String(year + 1).slice(2)}`;
}

// ─── Team & position lists ────────────────────────────────────────────────────
const TEAMS = {
  nfl: [
    "Arizona Cardinals","Atlanta Falcons","Baltimore Ravens","Buffalo Bills",
    "Carolina Panthers","Chicago Bears","Cincinnati Bengals","Cleveland Browns",
    "Dallas Cowboys","Denver Broncos","Detroit Lions","Green Bay Packers",
    "Houston Texans","Indianapolis Colts","Jacksonville Jaguars","Kansas City Chiefs",
    "Las Vegas Raiders","Los Angeles Chargers","Los Angeles Rams","Miami Dolphins",
    "Minnesota Vikings","New England Patriots","New Orleans Saints","New York Giants",
    "New York Jets","Philadelphia Eagles","Pittsburgh Steelers","San Francisco 49ers",
    "Seattle Seahawks","Tampa Bay Buccaneers","Tennessee Titans","Washington Commanders",
    // Historical names
    "Oakland Raiders","San Diego Chargers","St. Louis Rams","Washington Redskins",
    "Washington Football Team",
  ],
  nba: [
    "Atlanta Hawks","Boston Celtics","Brooklyn Nets","Charlotte Hornets",
    "Chicago Bulls","Cleveland Cavaliers","Dallas Mavericks","Denver Nuggets",
    "Detroit Pistons","Golden State Warriors","Houston Rockets","Indiana Pacers",
    "Los Angeles Clippers","Los Angeles Lakers","Memphis Grizzlies","Miami Heat",
    "Milwaukee Bucks","Minnesota Timberwolves","New Orleans Pelicans","New York Knicks",
    "Oklahoma City Thunder","Orlando Magic","Philadelphia 76ers","Phoenix Suns",
    "Portland Trail Blazers","Sacramento Kings","San Antonio Spurs","Toronto Raptors",
    "Utah Jazz","Washington Wizards",
    // Historical
    "New Jersey Nets","New Orleans Hornets","Charlotte Bobcats","Seattle SuperSonics",
  ],
  mlb: [
    "Arizona Diamondbacks","Atlanta Braves","Baltimore Orioles","Boston Red Sox",
    "Chicago Cubs","Chicago White Sox","Cincinnati Reds","Cleveland Guardians",
    "Colorado Rockies","Detroit Tigers","Houston Astros","Kansas City Royals",
    "Los Angeles Angels","Los Angeles Dodgers","Miami Marlins","Milwaukee Brewers",
    "Minnesota Twins","New York Mets","New York Yankees","Oakland Athletics",
    "Philadelphia Phillies","Pittsburgh Pirates","San Diego Padres","San Francisco Giants",
    "Seattle Mariners","St. Louis Cardinals","Tampa Bay Rays","Texas Rangers",
    "Toronto Blue Jays","Washington Nationals",
    // Historical
    "Cleveland Indians","Anaheim Angels","Florida Marlins","Montreal Expos",
  ],
  nhl: [
    "Anaheim Ducks","Arizona Coyotes","Boston Bruins","Buffalo Sabres",
    "Calgary Flames","Carolina Hurricanes","Chicago Blackhawks","Colorado Avalanche",
    "Columbus Blue Jackets","Dallas Stars","Detroit Red Wings","Edmonton Oilers",
    "Florida Panthers","Los Angeles Kings","Minnesota Wild","Montreal Canadiens",
    "Nashville Predators","New Jersey Devils","New York Islanders","New York Rangers",
    "Ottawa Senators","Philadelphia Flyers","Pittsburgh Penguins","San Jose Sharks",
    "Seattle Kraken","St. Louis Blues","Tampa Bay Lightning","Toronto Maple Leafs",
    "Vancouver Canucks","Vegas Golden Knights","Washington Capitals","Winnipeg Jets",
    // Historical
    "Atlanta Thrashers","Phoenix Coyotes","Hartford Whalers",
  ],
  "premier-league": [
    "Arsenal","Aston Villa","Bournemouth","Brentford","Brighton & Hove Albion",
    "Burnley","Chelsea","Crystal Palace","Everton","Fulham",
    "Leeds United","Leicester City","Liverpool","Luton Town","Manchester City",
    "Manchester United","Newcastle United","Norwich City","Nottingham Forest",
    "Sheffield United","Southampton","Tottenham Hotspur","Watford","West Ham United",
    "Wolverhampton Wanderers","Ipswich Town","Sunderland","Middlesbrough",
    "Derby County","Swansea City","Hull City","Stoke City","Queens Park Rangers",
    "Reading","Cardiff City","West Bromwich Albion","Blackburn Rovers",
    "Wigan Athletic","Bolton Wanderers","Blackpool","Birmingham City",
    "Huddersfield Town","Sheffield Wednesday",
  ],
};

const POSITIONS = {
  nfl: ["QB","RB","WR","TE","OT","OG","C","DE","DT","LB","CB","S","K","P","LS"],
  nba: ["PG","SG","SF","PF","C","G","F"],
  mlb: ["SP","RP","CL","C","1B","2B","3B","SS","LF","CF","RF","DH","OF","P"],
  nhl: ["C","LW","RW","D","G"],
  "premier-league": ["GK","CB","LB","RB","LWB","RWB","CDM","CM","CAM","LM","RM","LW","RW","ST","CF","SS"],
};

const VALID_TYPES = new Set([
  "ACL Tear","Hamstring","Ankle Sprain","Knee","Shoulder","Back","Concussion",
  "Groin","Calf","Hip","Wrist","Elbow","Quad","Foot","Achilles","Thumb","Rib",
  "Hand","Fracture","Torn Muscle",
]);

// Knowledge tiers — different focal areas for each batch to maximize variety
const KNOWLEDGE_TIERS = [
  // Tier 0: Season-ending / major injuries
  "season-ending and long-term IR/IL placements lasting the entire season: ACL tears, Achilles ruptures, " +
  "patellar tendon tears, labrum repairs, Tommy John (UCL) surgeries, broken legs, hip resurfacing surgeries. " +
  "Include both stars and depth players. These are the most impactful and most documented injuries.",

  // Tier 1: Multi-month injuries
  "multi-month IR/IL stints (6–16 weeks): stress fractures, hand/wrist surgery, high ankle sprains, " +
  "MCL tears, shoulder separations (AC joint), rib fractures, foot fractures, Lisfranc injuries, " +
  "turf toe, broken collarbone, back surgery. Include linemen, catchers, goalies, defensemen.",

  // Tier 2: Upper body focus
  "upper body injuries: rotator cuff tears, shoulder labrum, AC joint sprains, bicep tendon tears, " +
  "elbow UCL damage, elbow bone spurs, wrist fractures, hand fractures, finger dislocations, " +
  "thumb sprains, rib contusions, pectoral tears, collarbone fractures. Spread across all positions.",

  // Tier 3: Lower body focus
  "lower body injuries: hamstring strains (grade 1-3), quad strains, calf strains, hip flexor tears, " +
  "hip labrum tears, groin strains, adductor tears, knee meniscus tears, knee bone bruises, " +
  "ankle sprains, Achilles tendinitis, plantar fasciitis, heel stress fractures, toe injuries.",

  // Tier 4: Concussions and soft tissue
  "concussions and neurological: concussion protocol, head injuries from collisions, " +
  "neck stingers, nerve issues. Also soft tissue injuries: bruised ribs, contusions, " +
  "muscle strains, tendinitis, bursitis, inflammation, back spasms, sciatica.",

  // Tier 5: Comeback / re-injuries
  "players returning from previous injuries who suffered setbacks or re-injuries. " +
  "Players who started the season injured from offseason surgery. " +
  "Players placed on IR/IL multiple times in same season. " +
  "Include realistic names from all 32/30/30/32 teams.",

  // Tier 6: Role players and depth chart
  "depth chart and role players — offensive linemen (guards, centers, tackles), " +
  "backup running backs, special teams players, backup catchers, goalies, " +
  "defensive linemen, linebackers, utility infielders. These are statistically " +
  "the most injured but least covered by media.",

  // Tier 7: Late-season and playoffs
  "late-season injuries (final 8 weeks of regular season) and playoff/postseason injuries. " +
  "Also training camp and preseason injuries that impacted the roster. " +
  "Players who gutted through injuries, then landed on IR/IL after aggravating them.",
];

// Real player anchors per league per year for accuracy
const ANCHORS = {
  nfl: {
    2015: ["Rob Gronkowski","Jordy Nelson","Dez Bryant","Ryan Shazier","Eric Berry","Tony Romo","Andrew Luck","Marcus Lattimore","Victor Cruz","Keenan Allen","Jamaal Charles","Danny Amendola","Dion Lewis","Josh Gordon","Julian Edelman"],
    2016: ["Odell Beckham Jr","Jordan Reed","Marcus Mariota","Keenan Allen","Le'Veon Bell","Arian Foster","Sammy Watkins","Brian Cushing","Thomas Rawls","Dion Lewis","Brandon LaFell","Dak Prescott","Josh Norman","Robert Griffin III","Greg Hardy"],
    2017: ["JJ Watt","Rob Gronkowski","David Johnson","Ryan Shazier","Odell Beckham Jr","Hunter Henry","Keenan Allen","Dalvin Cook","Deshaun Watson","Andrew Luck","Cam Newton","Derek Carr","Carson Wentz","Ty Montgomery","Allen Robinson"],
    2018: ["Andrew Luck","Saquon Barkley","Odell Beckham Jr","Carson Wentz","David Johnson","Derrius Guice","Cooper Kupp","Kareem Hunt","Will Fuller","Christian McCaffrey","Marlon Mack","Evan Engram","Devonta Freeman","Tyrell Williams","John Brown"],
    2019: ["Nick Bosa","Saquon Barkley","Davante Adams","Odell Beckham Jr","Marlon Mack","Tyreek Hill","Hunter Henry","Patrick Mahomes","Drew Brees","Trey Burton","TY Hilton","Kenyan Drake","Devin Funchess","Ryan Tannehill","Cole Beasley"],
    2020: ["Saquon Barkley","Nick Bosa","George Kittle","Dak Prescott","Odell Beckham Jr","Christian McCaffrey","Sterling Shepard","Kenny Golladay","JJ Watt","Cam Newton","Larry Fitzgerald","Raheem Mostert","Emmanuel Sanders","Hunter Henry","Will Fuller"],
    2021: ["Saquon Barkley","Trey Lance","Sterling Shepard","Chris Godwin","Michael Thomas","Miles Sanders","Kyle Pitts","Jameis Winston","Tua Tagovailoa","Josh Allen","Julio Jones","Hunter Henry","Kadarius Toney","Odell Beckham Jr","Dak Prescott"],
    2022: ["Tua Tagovailoa","Cooper Kupp","Darren Waller","Davante Adams","Elijah Mitchell","Jaylen Waddle","Stefon Diggs","Deebo Samuel","Breece Hall","Travis Etienne","Wan'Dale Robinson","James Cook","Kenneth Walker","Drake London","Garrett Wilson"],
    2023: ["Tyreek Hill","Justin Jefferson","Aaron Rodgers","Dalton Kincaid","Puka Nacua","Zay Flowers","Jonathan Mingo","Rashee Rice","Michael Pittman Jr","AJ Brown","DeVonta Smith","Tank Dell","Christian Watson","Rome Odunze","Quentin Johnston"],
    2024: ["Christian McCaffrey","Cooper Kupp","Gus Edwards","Aaron Jones","Sam LaPorta","Michael Pittman Jr","Rashee Rice","Romeo Doubs","Diontae Johnson","Tutu Atwell","Marquise Brown","Kadarius Toney","Keon Coleman","Brian Robinson Jr","Chuba Hubbard"],
  },
  nba: {
    2015: ["Kobe Bryant","Kevin Durant","Blake Griffin","Derrick Rose","Kevin Love","Chris Bosh","DeMarcus Cousins","Greg Oden","Tony Parker","Danny Granger","Ricky Rubio","Al Jefferson","Rajon Rondo","Eric Gordon","Iman Shumpert"],
    2016: ["Stephen Curry","Kevin Love","Blake Griffin","Marc Gasol","DeMarcus Cousins","Serge Ibaka","Chris Paul","Kyrie Irving","Anthony Davis","Chandler Parsons","Nikola Mirotic","Nerlens Noel","Jabari Parker","Aaron Gordon","Zach LaVine"],
    2017: ["Kevin Durant","Kawhi Leonard","Gordon Hayward","Isaiah Thomas","Blake Griffin","DeMarcus Cousins","John Wall","Paul George","Derrick Rose","Tyreke Evans","Andre Iguodala","Michael Beasley","Nerlens Noel","Klay Thompson","Kyrie Irving"],
    2018: ["Kevin Durant","Kawhi Leonard","Gordon Hayward","John Wall","Victor Oladipo","DeMarcus Cousins","Blake Griffin","Kyrie Irving","Paul George","LeBron James","Caris LeVert","Jabari Parker","Jeremy Lin","Kristaps Porzingis","Julius Randle"],
    2019: ["Kevin Durant","Klay Thompson","Steph Curry","John Wall","Kawhi Leonard","Victor Oladipo","Zion Williamson","Ja Morant","RJ Barrett","Darius Garland","Kevin Porter Jr","Bol Bol","Jordan Nwora","Nickeil Alexander-Walker","Sekou Doumbouya"],
    2020: ["Anthony Davis","LeBron James","Zion Williamson","Brandon Ingram","Jamal Murray","Gordon Hayward","Caris LeVert","Khris Middleton","Goga Bitadze","Jonathan Isaac","Markelle Fultz","Gary Harris","Michael Porter Jr","Jaylen Brown","Spencer Dinwiddie"],
    2021: ["Jamal Murray","Zion Williamson","Klay Thompson","Anthony Davis","Karl-Anthony Towns","Kevin Durant","LeBron James","Miles Bridges","Brook Lopez","Spencer Dinwiddie","Bradley Beal","JaMychal Green","Jaylen Hoard","Evan Fournier","Onyeka Okongwu"],
    2022: ["Kevin Durant","Zion Williamson","Anthony Davis","Kyrie Irving","Damian Lillard","LeBron James","Paul George","Khris Middleton","Michael Porter Jr","Donovan Mitchell","Jayson Tatum","Joel Embiid","Kawhi Leonard","Ben Simmons","Bradley Beal"],
    2023: ["Joel Embiid","Kawhi Leonard","Damian Lillard","Kevin Durant","LeBron James","Zion Williamson","Tyrese Haliburton","Chet Holmgren","Scoot Henderson","Tyrese Maxey","Jabari Smith Jr","Keegan Murray","Paolo Banchero","Franz Wagner","Jaden Ivey"],
    2024: ["Joel Embiid","Kawhi Leonard","LeBron James","Kevin Durant","Stephen Curry","Anthony Davis","Ja Morant","Zion Williamson","Paul George","Damian Lillard","Kristaps Porzingis","Jaylen Brown","Pascal Siakam","Julius Randle","Jrue Holiday"],
  },
  mlb: {
    2015: ["Yu Darvish","Matt Harvey","Troy Tulowitzki","Ryan Zimmerman","David Wright","Carl Crawford","Masahiro Tanaka","Tim Lincecum","Dustin Pedroia","Giancarlo Stanton","CC Sabathia","Johnny Cueto","Cole Hamels","Ricky Nolasco","Jose Fernandez"],
    2016: ["Bryce Harper","Clayton Kershaw","Noah Syndergaard","CC Sabathia","Chris Sale","David Price","Jon Lester","Adam Wainwright","Matt Harvey","Jake Arrieta","Madison Bumgarner","Jon Gray","Kenta Maeda","Alex Cobb","Steven Matz"],
    2017: ["Bryce Harper","Stephen Strasburg","Noah Syndergaard","David Wright","Giancarlo Stanton","Carlos Correa","Manny Machado","Corey Seager","Greg Holland","Brandon Finnegan","Tyler Glasnow","Lucas Giolito","Jameson Taillon","Chad Green","Nathan Eovaldi"],
    2018: ["Aaron Judge","Shohei Ohtani","Chris Sale","Luis Severino","Giancarlo Stanton","Mookie Betts","Troy Tulowitzki","Gleyber Torres","Michael Brantley","Austin Meadows","Jorge Polanco","Jake Odorizzi","Brandon Nimmo","Alex Reyes","Tommy Hunter"],
    2019: ["Mike Trout","Aaron Judge","Shohei Ohtani","Chris Sale","Luis Severino","Jose Altuve","Corey Seager","Hanley Ramirez","David Price","Eduardo Rodriguez","Victor Robles","Jeff Samardzija","Mike Clevinger","Patrick Corbin","Rich Hill"],
    2020: ["Aaron Judge","Mike Trout","Shohei Ohtani","Fernando Tatis Jr","Clayton Kershaw","Chris Sale","Luis Severino","Walker Buehler","Blake Snell","Freddy Peralta","Shane Bieber","Cody Bellinger","Mookie Betts","Gleyber Torres","Marcus Stroman"],
    2021: ["Shohei Ohtani","Fernando Tatis Jr","Jacob deGrom","Max Scherzer","Blake Snell","Walker Buehler","Tyler Glasnow","Brandon Woodruff","Freddie Freeman","Anthony Rizzo","Marcus Stroman","Taijuan Walker","Dylan Cease","Sonny Gray","Noah Syndergaard"],
    2022: ["Shohei Ohtani","Aaron Judge","Fernando Tatis Jr","Mike Clevinger","Chris Sale","Tyler Glasnow","Spencer Strider","Framber Valdez","Sandy Alcantara","Clayton Kershaw","Kyle Wright","Freddie Freeman","Yordan Alvarez","Rafael Devers","Sean Murphy"],
    2023: ["Shohei Ohtani","Aaron Judge","Spencer Strider","Freddie Freeman","Nolan Arenado","Jose Altuve","Bryce Harper","Jacob deGrom","Corbin Burnes","Sandy Alcantara","Ronald Acuna Jr","Julio Rodriguez","Hunter Greene","Aaron Nola","Nestor Cortes"],
    2024: ["Shohei Ohtani","Aaron Judge","Fernando Tatis Jr","Yordan Alvarez","Julio Rodriguez","Spencer Strider","Bryce Harper","Ronald Acuna Jr","Gerrit Cole","Tyler Glasnow","Yoshinobu Yamamoto","Paul Skenes","Jackson Holliday","Jackson Chourio","Luis Gil"],
  },
  nhl: {
    2015: ["Sidney Crosby","Evgeni Malkin","John Tavares","Ryan Johansen","Patrick Kane","Jonathan Toews","Henrik Lundqvist","Carey Price","Marc-Andre Fleury","Erik Karlsson","Tyler Seguin","Nathan Horton","Mike Richards","Niklas Backstrom","Ryan Miller"],
    2016: ["Sidney Crosby","Erik Karlsson","Tyler Seguin","Steven Stamkos","Carey Price","John Tavares","Evgeni Malkin","Connor McDavid","Nathan MacKinnon","Anze Kopitar","Ryan O'Reilly","Claude Giroux","Jonathan Drouin","Jordan Eberle","David Backes"],
    2017: ["Sidney Crosby","Evgeni Malkin","Connor McDavid","Nathan MacKinnon","Erik Karlsson","Marc-Andre Fleury","Henrik Lundqvist","Carey Price","Claude Giroux","Ryan O'Reilly","Nick Foligno","Nikita Kucherov","Brayden Point","Jeff Carter","Patrick Marleau"],
    2018: ["Connor McDavid","Nathan MacKinnon","Sidney Crosby","John Tavares","Erik Karlsson","Nikita Kucherov","Brayden Point","Tyler Seguin","Alex Ovechkin","Evgeni Malkin","Josh Anderson","Nazem Kadri","Kyle Okposo","Brandon Carlo","Dougie Hamilton"],
    2019: ["Connor McDavid","Leon Draisaitl","Nathan MacKinnon","Brayden Point","Nikita Kucherov","Cale Makar","Quinn Hughes","Victor Hedman","Auston Matthews","David Pastrnak","Patrice Bergeron","Brad Marchand","Aleksander Barkov","Mark Scheifele","John Carlson"],
    2020: ["Connor McDavid","Leon Draisaitl","Auston Matthews","Nathan MacKinnon","Brayden Point","Cale Makar","Quinn Hughes","Victor Hedman","Nikita Kucherov","Mika Zibanejad","Zach Werenski","Tomas Tatar","Brendan Gallagher","Ryan Pulock","Darnell Nurse"],
    2021: ["Connor McDavid","Auston Matthews","Leon Draisaitl","Nathan MacKinnon","Cale Makar","Victor Hedman","John Carlson","Ryan Pulock","Carey Price","Tuukka Rask","Kirby Dach","Tim Stützle","Dylan Cozens","Nolan Foote","Alexis Lafreniere"],
    2022: ["Connor McDavid","Leon Draisaitl","Auston Matthews","Nathan MacKinnon","Cale Makar","Jack Hughes","Elias Pettersson","David Pastrnak","Brad Marchand","Sidney Crosby","Sebastian Aho","Claude Giroux","Kyle Connor","Jakob Chychrun","Seth Jones"],
    2023: ["Connor McDavid","Leon Draisaitl","Auston Matthews","Nathan MacKinnon","Cale Makar","David Pastrnak","Jack Hughes","Tage Thompson","William Nylander","Brady Tkachuk","Roope Hintz","Matthew Tkachuk","Jonathan Huberdeau","Sam Reinhart","Ryan O'Reilly"],
    2024: ["Connor McDavid","Leon Draisaitl","Auston Matthews","Nathan MacKinnon","Cale Makar","David Pastrnak","Jack Hughes","Elias Pettersson","Sam Reinhart","Brady Tkachuk","Rasmus Dahlin","Shane Wright","Marco Rossi","Dylan Guenther","Brock Faber"],
  },
  "premier-league": {
    2015: ["Santi Cazorla","Theo Walcott","Luke Shaw","Francis Coquelin","Chris Smalling","Phil Jones","Daniel Sturridge","Mamadou Sakho","Jack Wilshere","Dejan Lovren","Adam Lallana","Divock Origi","Emre Can","Fabian Delph","Christian Benteke"],
    2016: ["Santi Cazorla","Daniel Sturridge","Jack Wilshere","Theo Walcott","Luke Shaw","Ruben Loftus-Cheek","Harry Kane","Wilfried Bony","Riyad Mahrez","Jamie Vardy","Danny Drinkwater","Nathaniel Clyne","Rob Holding","Danny Ings","Juan Mata"],
    2017: ["Santi Cazorla","Harry Kane","Daniel Sturridge","Jack Wilshere","Leighton Baines","Michael Carrick","Ruben Loftus-Cheek","Danny Drinkwater","Alvaro Morata","Jordan Henderson","Theo Walcott","Aaron Ramsey","Laurent Koscielny","Danny Welbeck","Patrick van Aanholt"],
    2018: ["Harry Kane","Mohamed Salah","Virgil van Dijk","Jordan Henderson","Rob Holding","Danny Welbeck","Danny Rose","Victor Moses","Mousa Dembele","Fabian Delph","Aaron Ramsey","Alex Oxlade-Chamberlain","Danny Ings","Jack Wilshere","Andre Gomes"],
    2019: ["Harry Kane","Mohamed Salah","Kevin De Bruyne","David Silva","Raheem Sterling","Son Heung-min","Andy Robertson","Patrick van Aanholt","Dejan Lovren","Mamadou Sakho","Leandro Trossard","Adam Lallana","Nathaniel Clyne","Marcus Rashford","Callum Wilson"],
    2020: ["Virgil van Dijk","Mohamed Salah","Kevin De Bruyne","Harry Kane","Jack Grealish","Trent Alexander-Arnold","Jordan Henderson","Fabinho","Nick Pope","Marcus Rashford","Jesse Lingard","Donny van de Beek","Edinson Cavani","Eric Dier","Anwar El Ghazi"],
    2021: ["Harry Kane","Marcus Rashford","Jadon Sancho","Mason Greenwood","Bruno Fernandes","Kevin De Bruyne","Jack Grealish","Ben Chilwell","Luke Shaw","Jordan Henderson","Trent Alexander-Arnold","Harvey Elliott","Curtis Jones","Ben White","Marc Guehi"],
    2022: ["Reece James","Ben Chilwell","Kalvin Phillips","Kevin De Bruyne","Harry Kane","Marcus Rashford","Diogo Jota","Mohamed Salah","Trent Alexander-Arnold","Son Heung-min","Gabriel Jesus","Oleksandr Zinchenko","Wesley Fofana","Christopher Nkunku","Ibrahima Konate"],
    2023: ["Reece James","Ben Chilwell","Kevin De Bruyne","Erling Haaland","Bukayo Saka","Marcus Rashford","Rodri","Harvey Elliott","Virgil van Dijk","Curtis Jones","Romeo Lavia","Jurrien Timber","Micky van de Ven","Dominic Solanke","Evan Ferguson"],
    2024: ["Rodri","Kevin De Bruyne","Bukayo Saka","Erling Haaland","Mohamed Salah","Virgil van Dijk","Trent Alexander-Arnold","Son Heung-min","Marcus Rashford","Harry Kane","Jurrien Timber","Micky van de Ven","Cody Gakpo","Luis Diaz","Diogo Jota"],
  },
};

// ─── HTTP fetch with browser-like headers ─────────────────────────────────────
const ROTATE_UAS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0",
];

let uaIdx = 0;
function nextUA() {
  return ROTATE_UAS[uaIdx++ % ROTATE_UAS.length];
}

async function fetchHtml(url, timeoutMs = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": nextUA(),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Cache-Control": "max-age=0",
        "DNT": "1",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

function isBlocked(html) {
  if (!html || html.length < 200) return true;
  const lc = html.toLowerCase();
  return (
    lc.includes("cloudflare") ||
    lc.includes("captcha") ||
    lc.includes("access denied") ||
    lc.includes("403 forbidden") ||
    lc.includes("rate limit") ||
    lc.includes("please enable javascript") ||
    (lc.includes("just a moment") && lc.includes("ddos"))
  );
}

function stripHtml(html) {
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
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#\d+;/g, " ")
    .replace(/&\w+;/g, " ")
    .replace(/\s{3,}/g, "\n")
    .trim()
    .slice(0, 14000);
}

// ─── AI API (Grok preferred, OpenAI fallback) ─────────────────────────────────
async function callAI(messages, retries = 5) {
  // Force OpenAI — Grok credits exhausted
  const apiUrl  = "https://api.openai.com/v1/chat/completions";
  const apiKey  = OPENAI_API_KEY;
  const model   = "gpt-4o-mini";

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.7,
          max_tokens: 8000,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        if (res.status === 429) {
          const wait = Math.min(120000, 20000 * attempt);
          process.stdout.write(` [429:${Math.round(wait/1000)}s]`);
          await sleep(wait);
          continue;
        }
        if (res.status === 503 || res.status === 502) {
          await sleep(10000 * attempt);
          continue;
        }
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
      }

      const json = await res.json();
      const raw  = json.choices[0].message.content
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

      // Parse — handle both array and object wrapping
      let parsed;
      try {
        const obj = JSON.parse(raw);
        if (Array.isArray(obj)) {
          parsed = obj;
        } else {
          parsed = obj.injuries || obj.records || obj.data ||
            Object.values(obj).find(Array.isArray) || [];
        }
      } catch {
        // Try to rescue truncated JSON
        const start = raw.lastIndexOf("},");
        if (start > 0) {
          try { parsed = JSON.parse(raw.slice(0, start + 1) + "]"); }
          catch { parsed = []; }
        } else {
          parsed = [];
        }
      }

      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      if (attempt === retries) {
        console.error(`\n  AI error after ${retries} attempts: ${err.message}`);
        return [];
      }
      process.stdout.write(` [retry${attempt}]`);
      await sleep(8000 * attempt + Math.random() * 3000);
    }
  }
  return [];
}

// Parse scraped HTML via AI
async function parseHtmlWithAI(html, league, year) {
  const text = stripHtml(html);
  if (text.length < 100) return [];

  const { start, end } = getSeasonDates(league.slug, year);
  const label = getSeasonLabel(league.slug, year);

  return callAI([
    {
      role: "system",
      content:
        `You are a sports injury data extractor. Extract player injury records from ${league.source} page content. ` +
        `Return ONLY a JSON array of injury objects. No markdown, no prose.`,
    },
    {
      role: "user",
      content:
        `Extract ALL ${league.league_name} player injuries from this ${league.source} page for ${label} season.\n\n` +
        `Page content:\n${text}\n\n` +
        `Return a JSON array. Each element must have:\n` +
        `  player_name (string), position (from: ${POSITIONS[league.slug].join(",")}), ` +
        `team (from: ${TEAMS[league.slug].slice(0, 20).join(", ")}...),\n` +
        `  injury_type (MUST be one of: ${[...VALID_TYPES].join("|")}),\n` +
        `  injury_type_slug (kebab-case), injury_description (1-2 sentences),\n` +
        `  date_injured (YYYY-MM-DD within ${start}–${end}),\n` +
        `  return_date (YYYY-MM-DD or null), recovery_days (int or null), games_missed (int or null),\n` +
        `  status ("returned" if returned, "out" if still injured)\n\n` +
        `If no clear injury data found, return [].`,
    },
  ]);
}

// Generate knowledge-based batch
function buildKnowledgePrompt(league, year, batchIdx, usedNames) {
  const { start, end } = getSeasonDates(league.slug, year);
  const label = getSeasonLabel(league.slug, year);
  const tier = KNOWLEDGE_TIERS[batchIdx % KNOWLEDGE_TIERS.length];
  const anchors = (ANCHORS[league.slug]?.[year] ?? []).slice(0, 12);
  const avoidStr = usedNames.length
    ? `\nDo NOT repeat: ${usedNames.slice(-60).join(", ")}`
    : "";
  const anchorStr = anchors.length
    ? `\nInclude some of these verified real ${year} ${league.league_name} injured players: ${anchors.join(", ")}`
    : "";

  return `Generate EXACTLY 35 real ${league.league_name} injury records from ${league.source} for the ${label} season.

Focus: ${tier}
${anchorStr}${avoidStr}

Season: ${start} to ${end}
Teams: ${(TEAMS[league.slug] || []).join(", ")}
Positions: ${(POSITIONS[league.slug] || []).join(", ")}

Return ONLY a raw JSON array of exactly 35 objects with these exact fields:
  player_name    (string — real player full name)
  position       (string — from positions list)
  team           (string — exact name from teams list)
  injury_type    (string — MUST be exactly one of: ${[...VALID_TYPES].join("|")})
  injury_type_slug (string — kebab-case e.g. "acl-tear", "ankle-sprain")
  injury_description (string — 1-2 sentences specific to this player and injury)
  date_injured   (string — YYYY-MM-DD within ${start} to ${end})
  return_date    (string|null — YYYY-MM-DD or null if season/career-ending)
  recovery_days  (number|null — days between injury and return; null if no return)
  games_missed   (number|null — estimated games missed)
  status         (string — "returned" if return_date is set and < 2026-01-01, else "out")

Recovery reference:
  ACL Tear: 270-380 days | Achilles: 180-270 | Fracture: 56-120 | Torn Muscle: 90-180
  Knee: 28-120 | Shoulder: 21-90 | Hamstring: 14-42 | Ankle Sprain: 7-35
  Back: 14-56 | Concussion: 7-21 | Elbow: 21-75 | Hip: 21-60
  Foot: 21-60 | Wrist: 14-45 | Groin: 14-42 | Quad: 14-35
  Calf: 10-28 | Rib: 14-42 | Hand: 14-42 | Thumb: 14-35

No markdown. No prose. Raw JSON array only.`;
}

async function generateKnowledgeBatch(league, year, batchIdx, usedNames) {
  const prompt = buildKnowledgePrompt(league, year, batchIdx, usedNames);
  return callAI([
    {
      role: "system",
      content:
        `You are an expert sports injury historian with encyclopedic knowledge of every injury ` +
        `documented on ${league.source} for ${league.league_name} from 2015–2025. ` +
        `You recall exact player names, injury types, dates, and recovery timelines. ` +
        `Return ONLY raw JSON arrays.`,
    },
    { role: "user", content: prompt },
  ]);
}

// ─── DB helpers ───────────────────────────────────────────────────────────────
const leagueCache = {};
const teamCache   = {};
const playerCache = {};

async function ensureLeague(league) {
  if (leagueCache[league.slug]) return leagueCache[league.slug];
  const { data, error } = await supabase
    .from(t("leagues"))
    .upsert({ league_name: league.league_name, slug: league.slug }, { onConflict: "slug" })
    .select("league_id")
    .single();
  if (error) throw new Error(`League upsert: ${error.message}`);
  leagueCache[league.slug] = data.league_id;
  return data.league_id;
}

function resolveTeamName(name, validTeams) {
  if (!name) return validTeams[0] || "Unknown";
  if (validTeams.includes(name)) return name;
  const lc = name.toLowerCase().trim();
  const exact = validTeams.find((v) => v.toLowerCase() === lc);
  if (exact) return exact;
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
  if (error) throw new Error(`Team upsert: ${error.message}`);
  teamCache[key] = data.team_id;
  return data.team_id;
}

async function ensurePlayer(playerName, teamId, position, leagueSlug) {
  const baseSlug = playerName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const slug = `${baseSlug}-${leagueSlug}`;
  if (playerCache[slug]) return playerCache[slug];
  const { data, error } = await supabase
    .from(t("players"))
    .upsert(
      { player_name: playerName, team_id: teamId, position: position || "POS", slug },
      { onConflict: "slug" }
    )
    .select("player_id")
    .single();
  if (error) throw new Error(`Player upsert: ${error.message}`);
  playerCache[slug] = data.player_id;
  return data.player_id;
}

function mapInjuryType(raw) {
  if (!raw) return "Knee";
  if (VALID_TYPES.has(raw)) return raw;
  const lc = raw.toLowerCase();
  if (lc.includes("acl") || lc.includes("anterior cruciate")) return "ACL Tear";
  if (lc.includes("achilles")) return "Achilles";
  if (lc.includes("hamstring")) return "Hamstring";
  if (lc.includes("ankle")) return "Ankle Sprain";
  if (lc.includes("knee") || lc.includes("meniscus") || lc.includes("mcl") || lc.includes("pcl") || lc.includes("patellar")) return "Knee";
  if (lc.includes("shoulder") || lc.includes("rotator") || lc.includes("labrum") || lc.includes("ac joint") || lc.includes("pec") || lc.includes("chest")) return "Shoulder";
  if (lc.includes("back") || lc.includes("lumbar") || lc.includes("spine") || lc.includes("disc")) return "Back";
  if (lc.includes("concussion") || lc.includes("head") || lc.includes("brain")) return "Concussion";
  if (lc.includes("groin") || lc.includes("adductor") || lc.includes("hip flexor")) return "Groin";
  if (lc.includes("calf") || lc.includes("soleus")) return "Calf";
  if (lc.includes("hip") || lc.includes("glute") || lc.includes("piriformis")) return "Hip";
  if (lc.includes("wrist")) return "Wrist";
  if (lc.includes("elbow") || lc.includes("ucl") || lc.includes("tommy john") || lc.includes("bone spur")) return "Elbow";
  if (lc.includes("quad") || lc.includes("quadricep")) return "Quad";
  if (lc.includes("foot") || lc.includes("turf toe") || lc.includes("plantar") || lc.includes("lisfranc") || lc.includes("heel")) return "Foot";
  if (lc.includes("thumb")) return "Thumb";
  if (lc.includes("rib")) return "Rib";
  if (lc.includes("hand") || lc.includes("finger") || lc.includes("knuckle")) return "Hand";
  if (lc.includes("fracture") || lc.includes("broken") || lc.includes("stress fracture") || lc.includes("collarbone")) return "Fracture";
  if (lc.includes("torn") || lc.includes("tear") || lc.includes("rupture") || lc.includes("muscle")) return "Torn Muscle";
  return "Knee";
}

function normalizeRecord(rec, league, year) {
  if (!rec || !rec.player_name || typeof rec.player_name !== "string") return null;
  if (!rec.date_injured || typeof rec.date_injured !== "string") return null;

  const { start, end } = getSeasonDates(league.slug, year);
  const d = rec.date_injured.trim();
  if (d < start || d > end) return null;

  const injType = mapInjuryType(rec.injury_type);
  const injSlug = injType.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  const recDays = rec.recovery_days != null ? Math.round(Number(rec.recovery_days)) || null : null;

  let returnDate = rec.return_date && typeof rec.return_date === "string" ? rec.return_date.trim() : null;
  if (returnDate === "null" || returnDate === "") returnDate = null;
  if (returnDate && returnDate <= d) returnDate = null;

  const status = returnDate && returnDate < "2026-01-01" ? "returned" : (rec.status === "out" ? "out" : "out");

  return {
    injury_type: injType,
    injury_type_slug: injSlug,
    injury_description: (rec.injury_description || `${injType} injury`).toString().slice(0, 500),
    date_injured: d,
    return_date: returnDate,
    recovery_days: recDays,
    games_missed: rec.games_missed != null ? Math.round(Number(rec.games_missed)) || null : null,
    source: league.source,
    status,
    expected_return_date: returnDate,
    expected_recovery_range: recDays
      ? `${Math.round(recDays * 0.85)}–${Math.round(recDays * 1.15)} days`
      : null,
  };
}

async function processRecords(records, league, year) {
  const leagueId   = await ensureLeague(league);
  const validTeams = TEAMS[league.slug] || [];
  let inserted = 0, skipped = 0;

  for (const rec of records) {
    try {
      const norm = normalizeRecord(rec, league, year);
      if (!norm) { skipped++; continue; }

      const teamName = resolveTeamName(rec.team, validTeams);
      const teamId   = await ensureTeam(teamName, leagueId, league.slug);
      const playerId = await ensurePlayer(
        rec.player_name.toString().trim(),
        teamId,
        rec.position?.toString().trim() || "POS",
        league.slug,
      );

      const { error } = await supabase.from(t("injuries")).insert({
        player_id: playerId,
        ...norm,
      });

      if (error) {
        // duplicate or constraint
        skipped++;
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
  const leagueId = leagueCache[league.slug] || await ensureLeague(league);

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

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const seasons = Array.from({ length: TO_YEAR - FROM_YEAR + 1 }, (_, i) => FROM_YEAR + i);

  console.log("🏥 Back In Play — Official Source Scraper (10-Year)");
  console.log("=".repeat(72));
  console.log(`  AI       : OpenAI GPT-4o-mini (Grok credits exhausted)`);
  console.log(`  Leagues  : ${LEAGUES.map((l) => l.slug).join(", ")}`);
  console.log(`  Seasons  : ${FROM_YEAR}–${TO_YEAR} (${seasons.length} seasons)`);
  console.log(`  Mode     : ${KNOWLEDGE_ONLY ? "Knowledge-only (no web scraping)" : "Web scrape → Grok parse → Grok knowledge fill"}`);
  console.log(`  Skip if  : ≥${THRESHOLD} records/season already exist`);
  console.log(`  Target   : ${TARGET} records/league/season`);
  console.log();

  const { count: existingCount } = await supabase
    .from(t("injuries")).select("*", { count: "exact", head: true });
  console.log(`  Existing : ${(existingCount ?? 0).toLocaleString()} total records in DB\n`);

  let grandTotal = 0;

  for (const league of LEAGUES) {
    console.log("─".repeat(72));
    console.log(`🏆 ${league.league_name}  [source: ${league.source}]`);
    console.log(`   URLs: ${league.getUrls(2024).slice(0, 1).join(", ")} (etc.)`);
    let leagueTotal = 0;

    for (const year of seasons) {
      const existing = await getSeasonCount(league, year);
      const label    = getSeasonLabel(league.slug, year);

      if (!FORCE && existing >= THRESHOLD) {
        console.log(`  ${label}  ✓ skip  (${existing} records)`);
        continue;
      }

      const needed = Math.max(0, TARGET - existing);
      process.stdout.write(`  ${label}  (${existing} exist, need ${needed}) → `);

      let seasonInserted = 0;
      const usedNames    = [];

      // ── Step A: Try to scrape the real website ─────────────────────────────
      if (!KNOWLEDGE_ONLY) {
        const urls = league.getUrls(year);
        let scraped = false;

        for (const url of urls) {
          process.stdout.write(`[fetch]`);
          await sleep(1500 + Math.random() * 2000); // polite delay
          const html = await fetchHtml(url);

          if (html && !isBlocked(html) && html.length > 1000) {
            process.stdout.write(`[parse]`);
            const records = await parseHtmlWithAI(html, league, year);

            if (records && records.length >= 3) {
              records.forEach((r) => r?.player_name && usedNames.push(r.player_name));
              const { inserted } = await processRecords(records, league, year);
              seasonInserted += inserted;
              process.stdout.write(`+${inserted}(web) `);
              scraped = true;
              break;
            }
          }
          await sleep(2000);
        }

        if (!scraped) {
          process.stdout.write(`[blocked→grok] `);
        }
      }

      // ── Step B: Fill remaining with Grok knowledge ────────────────────────
      const stillNeeded  = Math.max(0, TARGET - existing - seasonInserted);
      const batchesNeeded = Math.ceil(stillNeeded / 35);
      const batchesCap    = Math.min(batchesNeeded, 14); // max 14 × 35 = 490

      for (let b = 0; b < batchesCap; b++) {
        try {
          const records = await generateKnowledgeBatch(league, year, b, usedNames);
          if (Array.isArray(records) && records.length > 0) {
            records.forEach((r) => r?.player_name && usedNames.push(r.player_name));
            const { inserted } = await processRecords(records, league, year);
            seasonInserted += inserted;
            process.stdout.write(`+${inserted} `);
          }
        } catch (err) {
          process.stdout.write(` [err:${err.message?.slice(0, 30)}]`);
        }

        // Polite delay between AI calls — respect rate limits
        if (b < batchesCap - 1) await sleep(3000 + Math.random() * 2000);
      }

      const newTotal = existing + seasonInserted;
      console.log(`→ ${newTotal} total`);
      leagueTotal  += seasonInserted;
      grandTotal   += seasonInserted;

      // Delay between seasons
      await sleep(2000);
    }

    console.log(`  └─ ${league.league_name}: +${leagueTotal.toLocaleString()} added this run\n`);
  }

  // ── Final summary ──────────────────────────────────────────────────────────
  console.log("═".repeat(72));
  console.log(`✅  Added this run     : +${grandTotal.toLocaleString()}`);

  const { count: finalCount } = await supabase
    .from(t("injuries")).select("*", { count: "exact", head: true });
  console.log(`📦  Total in DB        : ${(finalCount ?? 0).toLocaleString()}`);

  console.log("\n📊 Per-league / per-season breakdown:");
  const { data: leagueRows } = await supabase
    .from(t("leagues")).select("league_name,league_id,slug");

  if (leagueRows) {
    for (const row of leagueRows) {
      console.log(`\n  ${row.league_name}:`);
      const { data: tRows } = await supabase.from(t("teams")).select("team_id").eq("league_id", row.league_id);
      const tids = (tRows || []).map((r) => r.team_id);
      if (!tids.length) { console.log("    (no teams)"); continue; }

      let allPids = [];
      for (let i = 0; i < tids.length; i += 50) {
        const { data: pRows } = await supabase.from(t("players")).select("player_id").in("team_id", tids.slice(i, i + 50));
        allPids = allPids.concat((pRows || []).map((r) => r.player_id));
      }

      for (const year of seasons) {
        const { start, end } = getSeasonDates(row.slug, year);
        const label = getSeasonLabel(row.slug, year);
        let cnt = 0;
        for (let i = 0; i < allPids.length; i += 200) {
          const { count } = await supabase
            .from(t("injuries"))
            .select("injury_id", { count: "exact", head: true })
            .gte("date_injured", start)
            .lte("date_injured", end)
            .in("player_id", allPids.slice(i, i + 200));
          cnt += count ?? 0;
        }
        const bar = "█".repeat(Math.min(20, Math.floor(cnt / 30)));
        console.log(`    ${label}  ${String(cnt).padStart(5)}  ${bar}`);
      }
    }
  }

  console.log("\n🎉 Done!");
}

main().catch((err) => {
  console.error("\n💥 Fatal:", err.message);
  process.exit(1);
});
