/**
 * UTC-safe date helpers.
 *
 * All date comparisons against Supabase date columns (stored as `date` type,
 * i.e. calendar dates without time) must use UTC boundaries so the result
 * is the same regardless of the user's local timezone.
 *
 * `Date.toISOString()` always emits UTC, so `.split("T")[0]` is always the
 * UTC calendar date — no manual offset arithmetic needed.
 */

/** Returns today's date as a UTC ISO string, e.g. "2026-03-10". */
export function todayUTC(): string {
  return new Date().toISOString().split("T")[0];
}

/** Returns the date `days` from now as a UTC ISO string. */
export function futureDateUTC(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().split("T")[0];
}

/**
 * Format a YYYY-MM-DD string for display in the user's locale,
 * always interpreted as a UTC calendar date to avoid off-by-one shifts.
 */
export function formatDateUTC(dateStr: string): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
