/**
 * Self-heal error reporting utilities.
 *
 * The incubator SDK does not currently export installFrontendErrorCapture,
 * withDbErrorCapture, or reportSelfHealError, so equivalent implementations
 * live here. The interface is kept compatible so they can be swapped for SDK
 * exports if the SDK adds them in future.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase as defaultSupabase } from "./supabase";

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
export function reportSelfHealError(
  supabase: SupabaseClient,
  payload: SelfHealErrorPayload,
): void {
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
  supabase: SupabaseClient,
  tableName: string,
  query: PromiseLike<{ data: T | null; error: unknown }>,
  projectPrefix = PROJECT_PREFIX,
): Promise<{ data: T | null; error: unknown }> {
  const result = await query;
  if (result.error) {
    reportSelfHealError(supabase, {
      category: "database",
      source: tableName,
      errorMessage:
        (result.error as { message?: string })?.message ?? String(result.error),
      projectPrefix,
    });
  }
  return result;
}

/**
 * Installs global error + unhandledrejection listeners that pipe uncaught
 * frontend errors into the self-heal monitoring system.
 * Call once in main.tsx with the supabase client and project prefix.
 * Returns a cleanup function suitable for useEffect.
 */
export function installFrontendErrorCapture(
  supabase: SupabaseClient,
  projectPrefix = PROJECT_PREFIX,
): () => void {
  const onError = (event: ErrorEvent) => {
    // React Fast Refresh (HMR) triggers hooks-count errors when modules are patched
    // in-place during development. These are caught by HooksErrorBoundary and do
    // not affect production — skip them to avoid false-positive monitoring alerts.
    if (
      event.message?.includes("Rendered more hooks") ||
      event.message?.includes("Rendered fewer hooks")
    ) return;
    // Service worker script load failures (stale SW registrations trying to update)
    // are browser-side artifacts, not application errors — suppress them.
    // The app no longer uses a service worker, so ANY error mentioning sw.js
    // (in the message or filename) is a stale-registration artifact.
    const msg = event.message ?? "";
    const filename = event.filename ?? "";
    if (msg.includes("sw.js") || filename.includes("sw.js")) return;
    // Chunk load failures (stale deploy hashes) are handled by lazyWithReload which
    // triggers a hard reload. Suppress them here to avoid false-positive self-heal alerts.
    // Note: some browsers emit an empty message for cross-origin module load failures,
    // so we suppress any error from a /assets/ file when the message is empty or
    // contains load/fetch/import/module keywords.
    if (
      msg.includes("Importing a module script failed") ||
      msg.includes("error loading dynamically imported module") ||
      msg.includes("Failed to fetch dynamically imported module") ||
      msg.includes("Failed to load module script") ||
      msg.includes("Module script load failed") ||
      msg.includes("Unable to preload CSS") ||
      (filename.includes("/assets/") && (
        msg === "" ||
        msg.toLowerCase().includes("load") ||
        msg.toLowerCase().includes("fetch") ||
        msg.toLowerCase().includes("import") ||
        msg.toLowerCase().includes("module")
      ))
    ) return;
    reportSelfHealError(supabase, {
      category: "frontend",
      source: event.filename ?? "window.onerror",
      errorMessage: event.message,
      projectPrefix,
    });
  };

  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    // Earliest possible check: stringify the raw reason object and look for "sw.js".
    // This catches browsers where reason.message is unavailable or non-standard
    // (e.g., DOMException, non-Error objects) but String(reason) still contains the URL.
    try {
      const rawReason = event.reason != null ? String(event.reason) : "";
      if (rawReason.toLowerCase().includes("sw.js") || rawReason.toLowerCase().includes("registersw")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
    } catch (_) { /* ignore */ }

    // Fast-path: Chrome/Chromium emits "Script <url> load failed" for SW update failures.
    // Safari emits "Load failed" (bare TypeError). Both are browser-internal SW artifacts.
    // Check these FIRST before any other logic so they are always suppressed.
    //
    // IMPORTANT: always prefer event.reason.message over String(event.reason).
    // When reason is a DOMException, String(reason) gives "[object DOMException]"
    // in some browsers and strips the actual message text. Using .message directly
    // ensures the regex fast-path correctly matches "Script <url> load failed".
    const rawMessage: string =
      event.reason?.message != null
        ? String(event.reason.message)
        : String(event.reason ?? "");
    if (
      // Chrome: "Script https://backinplay.ai/sw.js load failed"
      /^Script\s+https?:\/\/\S+\s+load\s+failed$/i.test(rawMessage) ||
      // Safari: bare "Load failed" TypeError from SW fetch
      rawMessage === "Load failed" ||
      // Belt-and-suspenders: any rawMessage mentioning sw.js is a SW artifact
      rawMessage.toLowerCase().includes("sw.js")
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    // Same filter as onError — React re-dispatches caught hooks errors as rejections too.
    const message = String(event.reason?.message ?? event.reason ?? "");
    if (
      message.includes("Rendered more hooks") ||
      message.includes("Rendered fewer hooks")
    ) return;
    // Browsers with stale service worker registrations emit "sw.js load failed"
    // unhandled rejections while trying to update. This is a browser-side
    // artifact of old SW registrations — not an application error.
    // The app no longer uses a service worker, so ANY rejection that mentions
    // sw.js is a stale-registration artifact and should be suppressed regardless
    // of the exact message format (varies across browsers/versions).
    const reason = event.reason;
    const reasonStr = String(reason ?? "");
    // Also check filename/url/stack/name properties present on some browser error objects.
    const reasonUrl = String((reason as any)?.filename ?? (reason as any)?.url ?? "");
    const reasonStack = String((reason as any)?.stack ?? "");
    const reasonName = String((reason as any)?.name ?? "");
    const allText = (message + " " + reasonStr + " " + reasonUrl + " " + reasonStack + " " + reasonName).toLowerCase();
    if (
      allText.includes("sw.js") ||
      allText.includes("registersw") ||
      allText.includes("workbox") ||
      allText.includes("serviceworker") ||
      allText.includes("service-worker") ||
      // "Load failed" (Safari) or "Script ... load failed" (Chrome/Firefox) for SW update checks
      /load\s+failed/.test(allText) ||
      // "Failed to update a ServiceWorker" (Chrome verbose message)
      /failed.*update.*service\s*worker/i.test(allText) ||
      // "Failed to register a ServiceWorker" — Safari/Firefox where String(DOMException)
      // doesn't include the full message so "sw.js" may not appear in allText
      /failed.*register.*service\s*worker/i.test(allText) ||
      // "An unknown error occurred when fetching the script" — Safari generic SW fetch error
      allText.includes("unknown error occurred when fetching the script") ||
      // "A bad HTTP response code (404) was received when fetching the script"
      /bad\s+http\s+response.*fetching.*script/i.test(allText) ||
      // Chunk load failures (stale deploy hashes) handled by lazyWithReload
      allText.includes("importing a module script failed") ||
      allText.includes("error loading dynamically imported module") ||
      allText.includes("failed to fetch dynamically imported module") ||
      allText.includes("unable to preload css")
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    // Suppress null/undefined rejections — typically browser-internal SW update artifacts
    // that produce no useful error info. Real app promise rejections always have a reason.
    if (event.reason == null) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    // Explicit guard for the exact Chrome/Chromium pattern: "Script <url> load failed"
    // where the URL contains sw.js. Belt-and-suspenders on top of the allText check above.
    if (/script\s+https?:\/\/[^\s]*sw\.js\s+load\s+failed/i.test(message)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    reportSelfHealError(supabase, {
      category: "frontend",
      source: "unhandledrejection",
      errorMessage: message,
      projectPrefix,
    });
  };

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);

  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
  };
}

// Re-export a convenience singleton bound to the default client for internal use
export { defaultSupabase };
