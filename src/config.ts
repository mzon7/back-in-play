/**
 * Application-wide configuration defaults.
 * Values can be overridden at runtime via URL query params where noted.
 */
export const config = {
  /**
   * Default look-ahead window (days) for the "Returning Soon" section.
   * Override per-request with ?windowDays=<n> in the URL.
   */
  returningSoonWindowDays: 14,
} as const;
