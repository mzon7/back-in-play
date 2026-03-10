/**
 * Self-heal error reporting utilities.
 *
 * The incubator SDK does not currently export installFrontendErrorCapture,
 * withDbErrorCapture, or reportSelfHealError, so equivalent implementations
 * live here. The interface is kept compatible so they can be swapped for SDK
 * exports if the SDK adds them in future.
 */

import { supabase } from "./supabase";

export const PROJECT_PREFIX = "back_in_play_";

export interface SelfHealErrorPayload {
  category: "frontend" | "database";
  source: string;
  errorMessage: string;
  projectPrefix?: string;
}

/**
 * Report an error to the incubator self-heal monitoring table (fire-and-forget).
 * Errors here are swallowed so reporting never breaks the calling code.
 */
export function reportSelfHealError(payload: SelfHealErrorPayload): void {
  if (import.meta.env.DEV) {
    console.error(
      `[self-heal:${payload.category}] ${payload.source}: ${payload.errorMessage}`,
    );
  }

  // Best-effort insert — silently ignored on failure to avoid recursion.
  void Promise.resolve(
    supabase.from("incubator_self_heal_errors").insert({
      category: payload.category,
      source: payload.source,
      error_message: payload.errorMessage,
      project_prefix: payload.projectPrefix ?? PROJECT_PREFIX,
    }),
  ).catch(() => {
    /* intentionally silent */
  });
}

/**
 * Wraps a Supabase query result: if an error is present, reports it to the
 * self-heal system before returning the result unchanged so the caller can
 * still handle it normally (throw, retry, etc.).
 */
export async function withDbErrorCapture<T>(
  query: PromiseLike<{ data: T | null; error: unknown }>,
  source: string,
): Promise<{ data: T | null; error: unknown }> {
  const result = await query;
  if (result.error) {
    reportSelfHealError({
      category: "database",
      source,
      errorMessage:
        (result.error as { message?: string })?.message ?? String(result.error),
    });
  }
  return result;
}

/**
 * Installs a global unhandledrejection + error listener that pipes uncaught
 * frontend errors into the self-heal monitoring system.
 * Call once in main.tsx; returns a cleanup function suitable for useEffect.
 */
export function installFrontendErrorCapture(): () => void {
  const onError = (event: ErrorEvent) => {
    reportSelfHealError({
      category: "frontend",
      source: event.filename ?? "window.onerror",
      errorMessage: event.message,
    });
  };

  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    reportSelfHealError({
      category: "frontend",
      source: "unhandledrejection",
      errorMessage: String(event.reason),
    });
  };

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);

  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
  };
}
