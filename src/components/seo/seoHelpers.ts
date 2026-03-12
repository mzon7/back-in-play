/** Build JSON-LD for a player injury page */
export function playerJsonLd(player: {
  name: string;
  team: string;
  league: string;
  status: string;
  injury: string;
  dateModified: string;
  url: string;
}) {
  return {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: `${player.name} Injury Status`,
    description: `${player.name} injury update - ${player.status}. ${player.injury}. ${player.team} (${player.league}).`,
    url: player.url,
    dateModified: player.dateModified,
    about: {
      "@type": "Person",
      name: player.name,
      memberOf: {
        "@type": "SportsTeam",
        name: player.team,
      },
    },
  };
}

/** Build JSON-LD for a team injury report page */
export function teamJsonLd(team: {
  name: string;
  league: string;
  injuredCount: number;
  dateModified: string;
  url: string;
}) {
  return {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: `${team.name} Injury Report`,
    description: `${team.name} injury report - ${team.injuredCount} players currently injured. ${team.league}.`,
    url: team.url,
    dateModified: team.dateModified,
    about: {
      "@type": "SportsTeam",
      name: team.name,
    },
  };
}
