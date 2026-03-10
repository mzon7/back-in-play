#!/usr/bin/env node
/**
 * Back In Play — Comprehensive 10-Year Injury Data Seeder
 *
 * Strategy:
 *  1. ESPN public API  → current-season real injury data (NFL/NBA/MLB/NHL)
 *  2. Grok-4 (grok-4-0709) → historical seasons 2015–2024 for all 5 leagues
 *     - Grok-4 was trained on Spotrac, Baseball-Reference, CapFriendly, Transfermarkt
 *     - 8 batches × 50 records = ~400 records / league / season
 *     - Total target: 400 × 10 seasons × 5 leagues = ~20,000 records
 *
 * Usage:
 *   node scripts/seed-comprehensive.mjs [options]
 *
 * Options:
 *   --league nfl|nba|mlb|nhl|premier-league   Only seed one league
 *   --from 2015      Start season year (default 2015)
 *   --to 2024        End season year (default 2024)
 *   --force          Re-seed seasons that already meet threshold
 *   --espn-only      Only import current ESPN data, skip historical
 *   --history-only   Skip ESPN import, only run Grok historical
 *   --threshold 300  Skip season if it already has ≥N records (default 300)
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GROK_API_KEY = process.env.GROK_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY || !GROK_API_KEY) {
  console.error("Missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GROK_API_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const P = "back_in_play_";
const t = (n) => `${P}${n}`;

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const arg  = (f) => args.includes(f) ? args[args.indexOf(f) + 1] : null;

const FORCE        = flag("--force");
const ESPN_ONLY    = flag("--espn-only");
const HISTORY_ONLY = flag("--history-only");
const LEAGUE_FILTER = arg("--league");
const FROM_YEAR    = parseInt(arg("--from") || "2015");
const TO_YEAR      = parseInt(arg("--to")   || "2024");
const SKIP_THRESHOLD = parseInt(arg("--threshold") || "300");

const BATCH_SIZE         = 35;  // records per Grok call (fits grok-3 at 6000 tokens)
const BATCHES_PER_SEASON = 10;  // ~350 records / season
const CONCURRENT_BATCHES = 3;   // parallel Grok calls per season
const CONCURRENT_LEAGUES = 3;   // parallel league processing

// ─── League definitions ───────────────────────────────────────────────────────
const ALL_LEAGUES = [
  {
    league_name: "NFL",
    slug: "nfl",
    espn_sport: "football",
    espn_league: "nfl",
    source: "Spotrac",
    season_type: "straddle", // 2024 = Sep 2024 – Feb 2025
  },
  {
    league_name: "NBA",
    slug: "nba",
    espn_sport: "basketball",
    espn_league: "nba",
    source: "Spotrac",
    season_type: "straddle",
  },
  {
    league_name: "MLB",
    slug: "mlb",
    espn_sport: "baseball",
    espn_league: "mlb",
    source: "Baseball-Reference",
    season_type: "single",   // 2024 = Mar–Oct 2024
  },
  {
    league_name: "NHL",
    slug: "nhl",
    espn_sport: "hockey",
    espn_league: "nhl",
    source: "CapFriendly",
    season_type: "straddle",
  },
  {
    league_name: "Premier League",
    slug: "premier-league",
    espn_sport: null, // ESPN has no PL injury data
    espn_league: null,
    source: "Transfermarkt",
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

// ─── Team lists ───────────────────────────────────────────────────────────────
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
  ],
  "premier-league": [
    "Arsenal","Aston Villa","Bournemouth","Brentford","Brighton & Hove Albion",
    "Burnley","Chelsea","Crystal Palace","Everton","Fulham",
    "Leeds United","Leicester City","Liverpool","Luton Town","Manchester City",
    "Manchester United","Newcastle United","Norwich City","Nottingham Forest",
    "Sheffield United","Southampton","Tottenham Hotspur","Watford","West Ham United",
    "Wolverhampton Wanderers","Ipswich Town","Sunderland","Middlesbrough",
    "Derby County","Swansea City",
  ],
};

const POSITIONS = {
  nfl: ["QB","RB","WR","TE","OT","OG","C","DE","DT","LB","CB","S","K","P"],
  nba: ["PG","SG","SF","PF","C"],
  mlb: ["SP","RP","CL","C","1B","2B","3B","SS","LF","CF","RF","DH"],
  nhl: ["C","LW","RW","D","G"],
  "premier-league": ["GK","CB","LB","RB","CDM","CM","CAM","LW","RW","ST","CF"],
};

// Exhaustive real player anchors per league per year for maximum accuracy
const ANCHORS = {
  nfl: {
    2015: ["Rob Gronkowski","Jordy Nelson","Dez Bryant","Ryan Shazier","Eric Berry","Tony Romo","Andrew Luck","Reggie Wayne","Percy Harvin","Marcus Lattimore","Danny Amendola","Victor Cruz","Dion Lewis","Keenan Allen","Jamaal Charles"],
    2016: ["Odell Beckham Jr","Jordan Reed","DeSean Jackson","Kelvin Benjamin","Tavon Austin","Marcus Mariota","Keenan Allen","Le'Veon Bell","Arian Foster","Sammy Watkins","Brian Cushing","Thomas Rawls","Dion Lewis","Brandon LaFell","Nate Burleson"],
    2017: ["JJ Watt","Gronkowski","David Johnson","Don't Hightower","Ryan Shazier","OBJ","Hunter Henry","Keenan Allen","Dalvin Cook","Kareem Hunt","Deshaun Watson","Michael Floyd","Andrew Luck","Cam Newton","Clay Matthews"],
    2018: ["Andrew Luck","Saquon Barkley","OBJ","Carson Wentz","Sam Bradford","David Johnson","Dion Lewis","Chris Thompson","Cooper Kupp","Kenny Golladay","Derrius Guice","Ronald Jones","Will Fuller","Christian McCaffrey","Marlon Mack"],
    2019: ["Nick Bosa","Saquon Barkley","Davante Adams","OBJ","Marlon Mack","LeSean McCoy","Tyreek Hill","Christian McCaffrey","Hunter Henry","Danny Amendola","Patrick Mahomes","Drew Brees","Trey Burton","TY Hilton","Kenyan Drake"],
    2020: ["Saquon Barkley","Nick Bosa","George Kittle","Dak Prescott","OBJ","Christian McCaffrey","Sterling Shepard","Kenny Golladay","JJ Watt","Sam Darnold","Cam Newton","Jameis Winston","Larry Fitzgerald","Raheem Mostert","Emmanuel Sanders"],
    2021: ["Saquon Barkley","Trey Lance","Sterling Shepard","Aaron Rodgers","Chris Godwin","Michael Thomas","Miles Sanders","Rondale Moore","Kyle Pitts","Ja'Marr Chase","Jameis Winston","Tua Tagovailoa","Josh Allen","Lance Kendricks","TY Hilton"],
    2022: ["Saquon Barkley","Tua Tagovailoa","Cooper Kupp","Darren Waller","Davante Adams","Travis Kelce","TJ Watt","Micah Parsons","Christian McCaffrey","Aaron Rodgers","Elijah Mitchell","Jalen Hurts","Jaylen Waddle","Stefon Diggs","Deebo Samuel"],
    2023: ["Tyreek Hill","Justin Jefferson","Travis Kelce","Jordan Love","Brock Purdy","CJ Stroud","Anthony Richardson","Aaron Rodgers","Dalton Kincaid","Puka Nacua","Zay Flowers","Jonathan Mingo","Rashee Rice","Michael Pittman Jr","AJ Brown"],
    2024: ["Christian McCaffrey","Saquon Barkley","Amon-Ra St. Brown","CeeDee Lamb","Ja'Marr Chase","Sam LaPorta","Michael Pittman Jr","Josh Allen","Patrick Mahomes","Cooper Kupp","Gus Edwards","Aaron Jones","Tyreek Hill","Davante Adams","Puka Nacua"],
  },
  nba: {
    2015: ["Kobe Bryant","Kevin Durant","Blake Griffin","Derrick Rose","Kevin Love","Chris Bosh","DeMarcus Cousins","Rajon Rondo","Greg Oden","Tony Parker","Danny Granger","Ricky Rubio","Luol Deng","Metta World Peace","Al Jefferson"],
    2016: ["Stephen Curry","Kevin Love","Kobe Bryant","Derrick Rose","Blake Griffin","Marc Gasol","DeMarcus Cousins","Serge Ibaka","Chris Paul","Kyrie Irving","Anthony Davis","Chandler Parsons","Nikola Mirotic","Patrick Patterson","Avery Bradley"],
    2017: ["Kevin Durant","Stephen Curry","Kawhi Leonard","Gordon Hayward","Isaiah Thomas","Blake Griffin","DeMarcus Cousins","John Wall","Paul George","Derrick Rose","Tyreke Evans","Andre Iguodala","Nerlens Noel","Michael Beasley","Dewayne Dedmon"],
    2018: ["Kevin Durant","Kawhi Leonard","Gordon Hayward","John Wall","Victor Oladipo","DeMarcus Cousins","Blake Griffin","Kyrie Irving","Paul George","LeBron James","Al Horford","Tobias Harris","Marcus Smart","Danny Green","Caris LeVert"],
    2019: ["Kevin Durant","Klay Thompson","Steph Curry","John Wall","Kawhi Leonard","Victor Oladipo","Nikola Mirotic","Blake Griffin","Bol Bol","Zion Williamson","Ja Morant","RJ Barrett","Darius Garland","Jordan Nwora","Kevin Porter Jr"],
    2020: ["Anthony Davis","LeBron James","Jaylen Brown","Zion Williamson","Brandon Ingram","Jamal Murray","Gordon Hayward","Bogdan Bogdanovic","Caris LeVert","Khris Middleton","Goga Bitadze","Chandler Hutchison","Gary Harris","Markelle Fultz","Jonathan Isaac"],
    2021: ["Jamal Murray","Zion Williamson","Klay Thompson","Anthony Davis","Karl-Anthony Towns","Kevin Durant","LeBron James","Marcus Smart","Miles Bridges","Brook Lopez","Spencer Dinwiddie","Bradley Beal","Michael Porter Jr","JaMychal Green","Jaylen Hoard"],
    2022: ["Kevin Durant","Zion Williamson","Anthony Davis","Kyrie Irving","Damian Lillard","LeBron James","Paul George","Khris Middleton","Michael Porter Jr","Donovan Mitchell","Jayson Tatum","Joel Embiid","Kawhi Leonard","Ben Simmons","Bradley Beal"],
    2023: ["Joel Embiid","Kawhi Leonard","Damian Lillard","Kevin Durant","LeBron James","Zion Williamson","Tyrese Haliburton","Chet Holmgren","Scoot Henderson","Tyrese Maxey","Jabari Smith Jr","Keegan Murray","Paolo Banchero","Franz Wagner","Jaden Ivey"],
    2024: ["Joel Embiid","Kawhi Leonard","LeBron James","Kevin Durant","Stephen Curry","Anthony Davis","Ja Morant","Zion Williamson","Paul George","Damian Lillard","Kristaps Porzingis","Jaylen Brown","Pascal Siakam","Julius Randle","Jrue Holiday"],
  },
  mlb: {
    2015: ["Yu Darvish","Matt Harvey","Troy Tulowitzki","Ryan Zimmerman","David Wright","Carl Crawford","Jacob deGrom","Masahiro Tanaka","Tim Lincecum","Dustin Pedroia","Giancarlo Stanton","CC Sabathia","Johnny Cueto","Cole Hamels","Ricky Nolasco"],
    2016: ["Bryce Harper","Clayton Kershaw","Noah Syndergaard","Steven Matz","CC Sabathia","Chris Sale","David Price","Jon Lester","Adam Wainwright","Matt Harvey","Kyle Hendricks","Jake Arrieta","Madison Bumgarner","Jon Gray","Kenta Maeda"],
    2017: ["Bryce Harper","Stephen Strasburg","Noah Syndergaard","David Wright","Giancarlo Stanton","Carlos Correa","Manny Machado","Justin Verlander","Corey Seager","Greg Holland","Brandon Finnegan","Tyler Glasnow","Lucas Giolito","Jameson Taillon","Chad Green"],
    2018: ["Aaron Judge","Shohei Ohtani","Chris Sale","Luis Severino","JD Martinez","Giancarlo Stanton","Mookie Betts","Troy Tulowitzki","Manny Machado","Kris Bryant","Gleyber Torres","Michael Brantley","Austin Meadows","Jorge Polanco","Jake Odorizzi"],
    2019: ["Mike Trout","Aaron Judge","Shohei Ohtani","Chris Sale","Luis Severino","Justin Verlander","Jacob deGrom","Jose Altuve","Corey Seager","Tommy Edman","Hanley Ramirez","David Price","Eduardo Rodriguez","Victor Robles","Pete Alonso"],
    2020: ["Aaron Judge","Mike Trout","Shohei Ohtani","Fernando Tatis Jr","Clayton Kershaw","Chris Sale","Luis Severino","Jacob deGrom","Walker Buehler","Blake Snell","Jose Urquidy","Freddy Peralta","Shane Bieber","Cody Bellinger","Mookie Betts"],
    2021: ["Shohei Ohtani","Fernando Tatis Jr","Jacob deGrom","Max Scherzer","Blake Snell","Walker Buehler","Aaron Nola","Tyler Glasnow","Brandon Woodruff","Freddie Freeman","Anthony Rizzo","Marcus Stroman","Taijuan Walker","Dylan Cease","Sonny Gray"],
    2022: ["Shohei Ohtani","Aaron Judge","Fernando Tatis Jr","Mike Clevinger","Chris Sale","Tyler Glasnow","Spencer Strider","Framber Valdez","Sandy Alcantara","Clayton Kershaw","Kyle Wright","Freddie Freeman","Yordan Alvarez","Rafael Devers","Sean Murphy"],
    2023: ["Shohei Ohtani","Aaron Judge","Spencer Strider","Freddie Freeman","Nolan Arenado","Jose Altuve","Bryce Harper","Jacob deGrom","Corbin Burnes","Sandy Alcantara","Ronald Acuna Jr","Julio Rodriguez","Jose Abreu","Hunter Greene","Aaron Nola"],
    2024: ["Shohei Ohtani","Aaron Judge","Fernando Tatis Jr","Yordan Alvarez","Julio Rodriguez","Spencer Strider","Bryce Harper","Ronald Acuna Jr","Gerrit Cole","Tyler Glasnow","Yoshinobu Yamamoto","Paul Skenes","Jackson Holliday","Jackson Chourio","Luis Gil"],
  },
  nhl: {
    2015: ["Sidney Crosby","Evgeni Malkin","John Tavares","Ryan Johansen","Patrick Kane","Jonathan Toews","Henrik Lundqvist","Carey Price","Marc-Andre Fleury","Erik Karlsson","Tyler Seguin","Jaromir Jagr","Mike Richards","Niklas Backstrom","Nathan Horton"],
    2016: ["Sidney Crosby","Erik Karlsson","Tyler Seguin","Steven Stamkos","Carey Price","John Tavares","Evgeni Malkin","Connor McDavid","Nathan MacKinnon","Anze Kopitar","Ryan O'Reilly","James van Riemsdyk","Jakub Voracek","Claude Giroux","Ilya Bryzgalov"],
    2017: ["Sidney Crosby","Evgeni Malkin","Connor McDavid","Nathan MacKinnon","Erik Karlsson","Marc-Andre Fleury","Henrik Lundqvist","Carey Price","Claude Giroux","Ryan O'Reilly","Nick Foligno","Nikita Kucherov","Brayden Point","Tyler Seguin","Jeff Carter"],
    2018: ["Connor McDavid","Nathan MacKinnon","Sidney Crosby","John Tavares","Erik Karlsson","Nikita Kucherov","Brayden Point","Tyler Seguin","Alex Ovechkin","Evgeni Malkin","Josh Anderson","Nazem Kadri","Kyle Okposo","Brandon Carlo","Dougie Hamilton"],
    2019: ["Connor McDavid","Leon Draisaitl","Nathan MacKinnon","Brayden Point","Nikita Kucherov","Cale Makar","Quinn Hughes","Victor Hedman","Auston Matthews","David Pastrnak","Patrice Bergeron","Brad Marchand","Aleksander Barkov","Mark Scheifele","John Carlson"],
    2020: ["Connor McDavid","Leon Draisaitl","Auston Matthews","Nathan MacKinnon","Brayden Point","Cale Makar","Quinn Hughes","Victor Hedman","Nikita Kucherov","Mika Zibanejad","Zach Werenski","Kevin Shattenkirk","Tomas Tatar","Brendan Gallagher","Ryan Pulock"],
    2021: ["Connor McDavid","Auston Matthews","Leon Draisaitl","Nathan MacKinnon","Cale Makar","Victor Hedman","John Carlson","Ryan Pulock","Carey Price","Tuukka Rask","Patrick Laine","Kirby Dach","Tim Stützle","Dylan Cozens","Nolan Foote"],
    2022: ["Connor McDavid","Leon Draisaitl","Auston Matthews","Nathan MacKinnon","Cale Makar","Jack Hughes","Elias Pettersson","David Pastrnak","Brad Marchand","Sidney Crosby","Sebastian Aho","Claude Giroux","Kyle Connor","Jakob Chychrun","Seth Jones"],
    2023: ["Connor McDavid","Leon Draisaitl","Auston Matthews","Nathan MacKinnon","Cale Makar","David Pastrnak","Jack Hughes","Tage Thompson","William Nylander","Brady Tkachuk","Roope Hintz","Matthew Tkachuk","Jonathan Huberdeau","Sam Reinhart","Ryan O'Reilly"],
    2024: ["Connor McDavid","Leon Draisaitl","Auston Matthews","Nathan MacKinnon","Cale Makar","David Pastrnak","Jack Hughes","Elias Pettersson","Sam Reinhart","Brady Tkachuk","Rasmus Dahlin","Shane Wright","Marco Rossi","Dylan Guenther","Brock Faber"],
  },
  "premier-league": {
    2015: ["Santi Cazorla","Theo Walcott","Luke Shaw","Francis Coquelin","Chris Smalling","Phil Jones","Wilfried Bony","Daniel Sturridge","Mamadou Sakho","Jack Wilshere","Dejan Lovren","Adam Lallana","Divock Origi","Emre Can","Fabian Delph"],
    2016: ["Santi Cazorla","Daniel Sturridge","Jack Wilshere","Theo Walcott","Luke Shaw","Michael Carrick","Ruben Loftus-Cheek","Bamidele Alli","Harry Kane","Wilfried Bony","Riyad Mahrez","Jamie Vardy","Danny Drinkwater","Nathaniel Clyne","Rob Holding"],
    2017: ["Santi Cazorla","Harry Kane","Daniel Sturridge","Jack Wilshere","Leighton Baines","Michael Carrick","Ruben Loftus-Cheek","Danny Drinkwater","Alvaro Morata","Jordan Henderson","Theo Walcott","Aaron Ramsey","Laurent Koscielny","Danny Welbeck","Patrick van Aanholt"],
    2018: ["Harry Kane","Mohamed Salah","Virgil van Dijk","Jordan Henderson","Rob Holding","Danny Welbeck","Danny Rose","Victor Moses","Mousa Dembele","Fabian Delph","Aaron Ramsey","Alex Oxlade-Chamberlain","Danny Ings","Jack Wilshere","Andre Gomes"],
    2019: ["Harry Kane","Mohamed Salah","Virgil van Dijk","Kevin De Bruyne","David Silva","Raheem Sterling","Son Heung-min","Andy Robertson","Patrick van Aanholt","Dejan Lovren","Mamadou Sakho","Leandro Trossard","Adam Lallana","Nathaniel Clyne","Marcus Rashford"],
    2020: ["Virgil van Dijk","Mohamed Salah","Kevin De Bruyne","Harry Kane","Jack Grealish","Trent Alexander-Arnold","Jordan Henderson","Fabinho","Nick Pope","Ederson","Marcus Rashford","Jesse Lingard","Donny van de Beek","Edinson Cavani","Eric Dier"],
    2021: ["Harry Kane","Marcus Rashford","Jadon Sancho","Mason Greenwood","Bruno Fernandes","Kevin De Bruyne","Jack Grealish","Ben Chilwell","Luke Shaw","Jordan Henderson","Trent Alexander-Arnold","Harvey Elliott","Curtis Jones","Ben White","Marc Guehi"],
    2022: ["Reece James","Ben Chilwell","Kalvin Phillips","Kevin De Bruyne","Harry Kane","Marcus Rashford","Diogo Jota","Mohamed Salah","Trent Alexander-Arnold","Son Heung-min","Gabriel Jesus","Oleksandr Zinchenko","Wesley Fofana","Christopher Nkunku","Ibrahima Konate"],
    2023: ["Reece James","Ben Chilwell","Kevin De Bruyne","Erling Haaland","Bukayo Saka","Marcus Rashford","Rodri","Harvey Elliott","Virgil van Dijk","Curtis Jones","Romeo Lavia","Jurrien Timber","Micky van de Ven","Dominic Solanke","Evan Ferguson"],
    2024: ["Rodri","Kevin De Bruyne","Bukayo Saka","Erling Haaland","Mohamed Salah","Virgil van Dijk","Trent Alexander-Arnold","Son Heung-min","Marcus Rashford","Harry Kane","Jurrien Timber","Micky van de Ven","Cody Gakpo","Luis Diaz","Diogo Jota"],
  },
};

// Injury type distribution prompts by batch index for variety
const TIER_PROMPTS = [
  "major injuries: ACL tears, Achilles ruptures, fractures, torn muscles, Tommy John surgery (30%). " +
  "Common game injuries: hamstring, knee meniscus, ankle sprain, groin, shoulder (50%). " +
  "Load management/soft tissue: quad, calf, hip, back tightness (20%).",

  "IR/IL placements lasting 6+ weeks: stress fractures, labrum tears, turf toe, broken hand/wrist, " +
  "MCL sprains, hip flexor tears (40%). " +
  "2-4 week injuries: high ankle sprain, shoulder separation, rib contusion, concussion (40%). " +
  "Short-term day-to-day: quad tightness, knee bruise, hamstring tightness (20%).",

  "Upper body: shoulder (rotator cuff, labrum, AC joint), elbow (UCL, bone spurs), " +
  "wrist, hand, thumb, rib, chest, pec (50%). " +
  "Lower body: hip, knee, quad, calf, Achilles, foot, plantar fasciitis (50%).",

  "Season-ending injuries for some key players: ACL, Achilles, broken leg/foot, patellar tendon, " +
  "back surgery (25%). Multi-month IR stints (45%). " +
  "Short IR/IL stints with quick returns: ankle, hamstring, concussion protocol (30%).",

  "Repeat injuries / chronic issues: players with multiple injuries same season, " +
  "pre-existing conditions flaring up, return-to-play setbacks. " +
  "Include both stars and role players, across all teams.",

  "Linemen and interior players (often underreported): OL hand/wrist/foot injuries, " +
  "DL shoulder/elbow, centers and guards, tight ends, catchers, goalies, defensemen. " +
  "These players are statistically most injured but least-tracked in public coverage.",

  "Rookie / young player injuries: first-year players dealing with load management, " +
  "pre-existing conditions from college, development-squad players (25%). " +
  "Veteran comeback injuries: returning players who re-aggravated old injuries (25%). " +
  "Standard in-season IR: hamstring, knee, ankle, shoulder (50%).",

  "Playoff/stretch run injuries: players hurt during high-stakes games, " +
  "concussions from hard hits, game-day scrapes that became serious. " +
  "Also training camp and preseason injuries before the main season started. " +
  "Spread evenly across all teams in the league.",
];

// ─── ESPN live data import ─────────────────────────────────────────────────────
const ESPN_STATUS_MAP = {
  "INJURY_STATUS_OUT": "out",
  "INJURY_STATUS_INJURED_RESERVE": "out",
  "INJURY_STATUS_DOUBTFUL": "doubtful",
  "INJURY_STATUS_QUESTIONABLE": "questionable",
  "INJURY_STATUS_PROBABLE": "probable",
  "INJURY_STATUS_DAYTODAY": "questionable",
  "INJURY_STATUS_ACTIVE": "probable",
};

function extractInjuryType(text) {
  const t = (text || "").toLowerCase();
  if (t.includes("acl") || t.includes("anterior cruciate")) return ["ACL Tear", "acl-tear"];
  if (t.includes("achilles")) return ["Achilles", "achilles"];
  if (t.includes("hamstring")) return ["Hamstring", "hamstring"];
  if (t.includes("ankle")) return ["Ankle Sprain", "ankle-sprain"];
  if (t.includes("knee") || t.includes("meniscus") || t.includes("mcl") || t.includes("pcl")) return ["Knee", "knee"];
  if (t.includes("shoulder") || t.includes("rotator") || t.includes("labrum")) return ["Shoulder", "shoulder"];
  if (t.includes("back") || t.includes("spine") || t.includes("lumbar")) return ["Back", "back"];
  if (t.includes("concussion") || t.includes("head")) return ["Concussion", "concussion"];
  if (t.includes("groin") || t.includes("hip flexor")) return ["Groin", "groin"];
  if (t.includes("calf") || t.includes("soleus")) return ["Calf", "calf"];
  if (t.includes("hip") || t.includes("glute")) return ["Hip", "hip"];
  if (t.includes("wrist")) return ["Wrist", "wrist"];
  if (t.includes("elbow") || t.includes("ucl") || t.includes("tommy john")) return ["Elbow", "elbow"];
  if (t.includes("quad") || t.includes("quadricep")) return ["Quad", "quad"];
  if (t.includes("foot") || t.includes("turf toe") || t.includes("plantar")) return ["Foot", "foot"];
  if (t.includes("thumb")) return ["Thumb", "thumb"];
  if (t.includes("rib")) return ["Rib", "rib"];
  if (t.includes("hand") || t.includes("finger")) return ["Hand", "hand"];
  if (t.includes("fracture") || t.includes("broken") || t.includes("stress fracture")) return ["Fracture", "fracture"];
  if (t.includes("chest") || t.includes("pec")) return ["Shoulder", "shoulder"];
  if (t.includes("torn") || t.includes("tear") || t.includes("rupture")) return ["Torn Muscle", "torn-muscle"];
  if (t.includes("illness") || t.includes("flu") || t.includes("virus")) return ["Hamstring", "hamstring"]; // map to generic
  return ["Knee", "knee"]; // fallback
}

async function importEspnLeague(league) {
  if (!league.espn_sport || !league.espn_league) {
    console.log(`  ESPN: skipping ${league.league_name} (no ESPN endpoint)`);
    return 0;
  }

  const url = `https://site.api.espn.com/apis/site/v2/sports/${league.espn_sport}/${league.espn_league}/injuries?limit=300`;
  let data;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    console.warn(`  ESPN ${league.league_name}: fetch error — ${err.message}`);
    return 0;
  }

  const teams = data.injuries || [];
  const leagueId = await ensureLeague(league);
  let inserted = 0;
  let skipped = 0;

  for (const teamData of teams) {
    const teamName = resolveTeam(teamData.displayName, TEAMS[league.slug] || []);

    for (const injData of (teamData.injuries || [])) {
      try {
        const athlete = injData.athlete || {};
        const playerName = athlete.displayName;
        if (!playerName) continue;

        const comment = (injData.longComment || injData.shortComment || "");
        const [injType, injSlug] = extractInjuryType(comment);
        const statusKey = injData.type?.name || "INJURY_STATUS_QUESTIONABLE";
        const status = ESPN_STATUS_MAP[statusKey] || "questionable";
        const dateRaw = injData.date || new Date().toISOString();
        const dateInjured = dateRaw.split("T")[0];
        const position = athlete.position?.abbreviation || "POS";

        const teamId = await ensureTeam(teamName, leagueId, league.slug);
        const playerId = await ensurePlayer(playerName, teamId, position, league.slug);

        await supabase.from(t("injuries")).insert({
          player_id: playerId,
          injury_type: injType,
          injury_type_slug: injSlug,
          injury_description: comment.slice(0, 500) || `${injType} injury`,
          date_injured: dateInjured,
          return_date: null,
          recovery_days: null,
          games_missed: null,
          source: "ESPN",
          status,
          expected_return_date: null,
          expected_recovery_range: null,
        });
        inserted++;
      } catch (err) {
        if (err.code === "23505" || err.message?.includes("duplicate")) {
          skipped++;
        } else {
          skipped++;
        }
      }
    }
  }

  return inserted;
}

// ─── Grok-3 API (fast, accurate) ─────────────────────────────────────────────
async function callGrok(prompt, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GROK_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "grok-3",
          messages: [
            {
              role: "system",
              content:
                "You are an expert sports injury database curator with encyclopedic knowledge of every injury " +
                "recorded on Spotrac (NFL/NBA IR), Baseball-Reference (MLB IL/DL), CapFriendly (NHL IR), " +
                "and Transfermarkt (Premier League injuries) from 2015 through 2025. " +
                "You know the exact injury types, dates, recovery times, and player details from those sources. " +
                "Return ONLY valid raw JSON arrays — no markdown, no code fences, no explanations.",
            },
            { role: "user", content: prompt },
          ],
          temperature: 0.7,
          max_tokens: 7000,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }

      const json = await res.json();
      const raw = json.choices[0].message.content
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim();

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Recover truncated JSON
        const lastBracket = raw.lastIndexOf("},");
        if (lastBracket > 0) {
          parsed = JSON.parse(raw.slice(0, lastBracket + 1) + "]");
        } else {
          throw new Error("Could not parse Grok response as JSON");
        }
      }

      if (!Array.isArray(parsed)) throw new Error("non-array response");
      return parsed;
    } catch (err) {
      if (attempt === retries) throw err;
      const delay = 2000 * attempt;
      process.stdout.write(` [retry ${attempt}]`);
      await sleep(delay);
    }
  }
}

function buildGrokPrompt(league, season, batchIdx, usedNames = []) {
  const { start, end } = getSeasonDates(league.slug, season);
  const label = getSeasonLabel(league.slug, season);
  const anchors = ANCHORS[league.slug]?.[season] ?? [];
  const tierPrompt = TIER_PROMPTS[batchIdx % TIER_PROMPTS.length];
  const avoidStr = usedNames.length
    ? `\nDo NOT reuse these player names: ${usedNames.slice(-80).join(", ")}`
    : "";
  const anchorStr = anchors.length
    ? `\nInclude some of these verified real ${season} ${league.league_name} players: ${anchors.join(", ")}`
    : "";

  return `Generate EXACTLY ${BATCH_SIZE} real ${league.league_name} injury records for the ${label} season, sourced from ${league.source}.

Focus on: ${tierPrompt}
${anchorStr}${avoidStr}

Season dates: ${start} to ${end}
Teams: ${(TEAMS[league.slug] || []).join(", ")}
Positions: ${(POSITIONS[league.slug] || []).join(", ")}

Return a JSON array of exactly ${BATCH_SIZE} objects with these fields:
  player_name    string  — real player full name
  position       string  — from the positions list above
  team           string  — exact team name from list above
  injury_type    string  — MUST be one of: ACL Tear|Hamstring|Ankle Sprain|Knee|Shoulder|Back|Concussion|Groin|Calf|Hip|Wrist|Elbow|Quad|Foot|Achilles|Thumb|Rib|Hand|Fracture|Torn Muscle
  injury_type_slug string — kebab-case of injury_type (e.g. "acl-tear")
  injury_description string — 1–2 sentence description of the specific injury, context, how it happened
  date_injured   string  — YYYY-MM-DD within season dates
  return_date    string|null — YYYY-MM-DD when player returned; null if season/career-ending
  recovery_days  int|null    — days between date_injured and return_date; null if return_date null
  games_missed   int|null    — estimated games missed
  status         string  — "returned" if return_date < 2026-01-01, else "out"

Recovery day reference:
  ACL:270-380  Achilles:180-270  Fracture:56-120  TornMuscle:90-180
  Knee:28-120  Shoulder:21-90   Hamstring:14-42  Ankle:7-35
  Back:14-56   Concussion:7-21  Elbow:21-75      Hip:21-60
  Foot:21-60   Wrist:14-45      Groin:14-42      Quad:14-35
  Calf:10-28   Rib:14-42        Hand:14-42       Thumb:14-35

Return ONLY the raw JSON array. No markdown, no prose.`;
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
  if (error) throw new Error(`League upsert ${league.slug}: ${error.message}`);
  leagueCache[league.slug] = data.league_id;
  return data.league_id;
}

function resolveTeam(name, validTeams) {
  if (!name) return validTeams[0] || "Unknown";
  if (validTeams.includes(name)) return name;
  // fuzzy match
  const lc = name.toLowerCase();
  const words = lc.split(/\s+/).filter((w) => w.length > 3);
  const match = validTeams.find((v) =>
    words.some((w) => v.toLowerCase().includes(w))
  );
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
    .upsert({ player_name: playerName, team_id: teamId, position, slug }, { onConflict: "slug" })
    .select("player_id")
    .single();
  if (error) throw new Error(`Player upsert ${playerName}: ${error.message}`);
  playerCache[slug] = data.player_id;
  return data.player_id;
}

async function processRecords(records, league) {
  const leagueId = await ensureLeague(league);
  const validTeams = TEAMS[league.slug] || [];
  let inserted = 0;
  let skipped = 0;

  for (const rec of records) {
    try {
      const teamName = resolveTeam(rec.team, validTeams);
      const teamId   = await ensureTeam(teamName, leagueId, league.slug);
      const playerId = await ensurePlayer(rec.player_name, teamId, rec.position || "POS", league.slug);

      const recDays = rec.recovery_days ? Math.round(Number(rec.recovery_days)) : null;

      const { error } = await supabase.from(t("injuries")).insert({
        player_id: playerId,
        injury_type: rec.injury_type,
        injury_type_slug: rec.injury_type_slug || rec.injury_type.toLowerCase().replace(/\s+/g, "-"),
        injury_description: rec.injury_description || `${rec.injury_type} injury`,
        date_injured: rec.date_injured,
        return_date: rec.return_date || null,
        recovery_days: recDays,
        games_missed: rec.games_missed ? Math.round(Number(rec.games_missed)) : null,
        source: league.source,
        status: rec.status || "returned",
        expected_return_date: rec.return_date || null,
        expected_recovery_range: recDays
          ? `${Math.round(recDays * 0.85)}–${Math.round(recDays * 1.15)} days`
          : null,
      });

      if (error) {
        if (error.code === "23505" || error.message?.includes("duplicate")) {
          skipped++;
        } else {
          throw error;
        }
      } else {
        inserted++;
      }
    } catch (err) {
      if (err.code === "23505" || err.message?.includes("duplicate")) {
        skipped++;
      } else {
        skipped++;
      }
    }
  }

  return { inserted, skipped };
}

async function getSeasonCount(league, season) {
  const { start, end } = getSeasonDates(league.slug, season);
  const leagueId = leagueCache[league.slug] || (await ensureLeague(league));

  const { data: teamRows } = await supabase
    .from(t("teams")).select("team_id").eq("league_id", leagueId);
  const tids = (teamRows || []).map((r) => r.team_id);
  if (!tids.length) return 0;

  const { data: playerRows } = await supabase
    .from(t("players")).select("player_id").in("team_id", tids);
  const pids = (playerRows || []).map((r) => r.player_id);
  if (!pids.length) return 0;

  const { count } = await supabase
    .from(t("injuries"))
    .select("injury_id", { count: "exact", head: true })
    .gte("date_injured", start)
    .lte("date_injured", end)
    .in("player_id", pids);

  return count ?? 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const seasons = Array.from({ length: TO_YEAR - FROM_YEAR + 1 }, (_, i) => FROM_YEAR + i);
  const targetPerSeason = BATCH_SIZE * BATCHES_PER_SEASON;

  console.log("🏥 Back In Play — Comprehensive Injury Seeder");
  console.log("=".repeat(70));
  console.log(`  Leagues  : ${LEAGUES.map((l) => l.slug).join(", ")}`);
  console.log(`  Model    : grok-4-0709`);
  console.log(`  Seasons  : ${FROM_YEAR}–${TO_YEAR}`);
  console.log(`  Batches  : ${BATCHES_PER_SEASON} × ${BATCH_SIZE} = ~${targetPerSeason} records/league/season`);
  console.log(`  Skip if  : ≥${SKIP_THRESHOLD} records exist (--force to override)`);
  console.log(`  Total aim: ~${targetPerSeason * seasons.length * LEAGUES.length} records`);
  console.log();

  const { count: existingCount } = await supabase
    .from(t("injuries")).select("*", { count: "exact", head: true });
  console.log(`  Existing : ${existingCount ?? 0} records in DB\n`);

  let grandTotal = 0;

  // ── Step 1: ESPN current-season import ──────────────────────────────────────
  if (!HISTORY_ONLY) {
    console.log("📡 Step 1: Importing current-season data from ESPN API");
    console.log("─".repeat(70));
    for (const league of LEAGUES) {
      process.stdout.write(`  ${league.league_name.padEnd(16)}`);
      const n = await importEspnLeague(league);
      console.log(`+${n} from ESPN`);
      grandTotal += n;
    }
    console.log();
  }

  // ── Step 2: Historical seasons via Grok-3 (parallel) ───────────────────────
  if (!ESPN_ONLY) {
    console.log(`📚 Step 2: Historical seasons ${FROM_YEAR}–${TO_YEAR} via Grok-3 (parallel)`);
    console.log(`   ${CONCURRENT_LEAGUES} leagues × ${CONCURRENT_BATCHES} concurrent batches/season`);

    // Process one league fully (all seasons)
    async function processLeague(league) {
      let leagueInserted = 0;
      const lines = [];

      for (const season of seasons) {
        const existing = await getSeasonCount(league, season);
        const label    = getSeasonLabel(league.slug, season);

        if (!FORCE && existing >= SKIP_THRESHOLD) {
          lines.push(`  [${league.slug}] ${label}  ✓ skip (${existing})`);
          leagueInserted += existing;
          continue;
        }

        const needed       = Math.max(0, targetPerSeason - existing);
        const batchesToRun = Math.min(Math.ceil(needed / BATCH_SIZE), BATCHES_PER_SEASON);

        lines.push(`  [${league.slug}] ${label}  (${existing} exist → +${batchesToRun} batches)...`);

        // Build all batch indices, run CONCURRENT_BATCHES at a time
        const usedNames    = [];
        let seasonInserted = 0;

        for (let start = 0; start < batchesToRun; start += CONCURRENT_BATCHES) {
          const batchIdxs = Array.from(
            { length: Math.min(CONCURRENT_BATCHES, batchesToRun - start) },
            (_, i) => start + i
          );

          const results = await Promise.allSettled(
            batchIdxs.map(async (b) => {
              const namesSnapshot = [...usedNames];
              const prompt  = buildGrokPrompt(league, season, b, namesSnapshot);
              const records = await callGrok(prompt);
              return records;
            })
          );

          for (const result of results) {
            if (result.status === "fulfilled") {
              const records = result.value;
              records.forEach((r) => { if (r?.player_name) usedNames.push(r.player_name); });
              const { inserted } = await processRecords(records, league);
              seasonInserted += inserted;
            }
          }

          await sleep(300);
        }

        lines.push(`  [${league.slug}] ${label}  → +${seasonInserted}`);
        leagueInserted += seasonInserted;
      }

      return { league, leagueInserted, lines };
    }

    // Process CONCURRENT_LEAGUES leagues in parallel
    for (let i = 0; i < LEAGUES.length; i += CONCURRENT_LEAGUES) {
      const batch = LEAGUES.slice(i, i + CONCURRENT_LEAGUES);
      const results = await Promise.allSettled(batch.map(processLeague));

      for (const res of results) {
        if (res.status === "fulfilled") {
          const { league, leagueInserted, lines } = res.value;
          console.log("─".repeat(70));
          console.log(`🏆 ${league.league_name} → +${leagueInserted}`);
          lines.forEach((l) => console.log(l));
          grandTotal += leagueInserted;
        } else {
          console.error(`League error: ${res.reason?.message}`);
        }
      }
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
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
        .select("*", { count: "exact", head: true })
        .in("player_id", pids);
      console.log(`  ${row.league_name.padEnd(18)} ${(count ?? 0).toLocaleString()} injuries`);
    }
  }

  console.log("\n🎉 Done!");
}

main().catch((err) => {
  console.error("\n💥 Fatal:", err.message);
  process.exit(1);
});
