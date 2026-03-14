const SITE_URL = "https://backinplay.app";

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

/** Build BreadcrumbList JSON-LD */
export function breadcrumbJsonLd(items: { name: string; path: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: `${SITE_URL}${item.path}`,
    })),
  };
}

/** Build Dataset JSON-LD for performance/statistical pages */
export function datasetJsonLd(params: {
  name: string;
  description: string;
  url: string;
  sampleSize: number;
  keywords?: string[];
}) {
  return {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: params.name,
    description: params.description,
    url: `${SITE_URL}${params.url}`,
    creator: { "@type": "Organization", name: "Back In Play", url: SITE_URL },
    variableMeasured: [
      "games_missed",
      "recovery_days",
      "performance_pct_of_baseline",
    ],
    measurementTechnique: "Game log statistical analysis",
    keywords: params.keywords ?? [
      "injury recovery",
      "player performance",
      "sports analytics",
    ],
    size: `${params.sampleSize} injury return cases`,
  };
}

/** Build FAQPage JSON-LD */
export function faqJsonLd(items: { question: string; answer: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
    })),
  };
}

/** Combine multiple JSON-LD objects into a graph */
export function jsonLdGraph(...items: Record<string, unknown>[]) {
  return {
    "@context": "https://schema.org",
    "@graph": items.map(({ "@context": _, ...rest }) => rest),
  };
}
