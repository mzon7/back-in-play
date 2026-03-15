/** Slugs that are not real injuries — exclude from analytics views */
const EXCLUDE_SLUGS = new Set([
  "other", "unknown", "personal", "personal-matter", "not-injury-related",
  "suspension", "rest", "rest-day", "illness", "coach-decision",
  "undisclosed", "not-specified", "load-management", "disciplinary",
]);

/** Keywords in injury_type name that indicate non-injury entries */
const EXCLUDE_KEYWORDS = [
  "personal", "suspension", "rest", "illness", "coach", "undisclosed",
  "not injury", "non-injury", "load management", "disciplinary",
];

/** Returns true if the injury slug + name represents a real injury */
export function isRealInjury(slug: string, name?: string): boolean {
  if (EXCLUDE_SLUGS.has(slug)) return false;
  if (name) {
    const lower = name.toLowerCase();
    if (EXCLUDE_KEYWORDS.some((kw) => lower.includes(kw))) return false;
  }
  return true;
}
