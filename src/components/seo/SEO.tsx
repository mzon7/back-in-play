import { Helmet } from "react-helmet-async";

interface SEOProps {
  title: string;
  description: string;
  path: string;
  type?: "website" | "article";
  dateModified?: string;
  jsonLd?: Record<string, unknown>;
}

const SITE_URL = "https://backinplay.app";
const SITE_NAME = "Back In Play";

export function SEO({ title, description, path, type = "website", dateModified, jsonLd }: SEOProps) {
  const fullTitle = `${title} | ${SITE_NAME}`;
  const url = `${SITE_URL}${path}`;

  return (
    <Helmet>
      <title>{fullTitle}</title>
      <meta name="description" content={description} />
      <link rel="canonical" href={url} />

      {/* Open Graph */}
      <meta property="og:title" content={fullTitle} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={url} />
      <meta property="og:type" content={type} />
      <meta property="og:site_name" content={SITE_NAME} />

      {/* Twitter */}
      <meta name="twitter:card" content="summary" />
      <meta name="twitter:title" content={fullTitle} />
      <meta name="twitter:description" content={description} />

      {dateModified && <meta property="article:modified_time" content={dateModified} />}

      {jsonLd && (
        <script type="application/ld+json">
          {JSON.stringify(jsonLd)}
        </script>
      )}
    </Helmet>
  );
}

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
