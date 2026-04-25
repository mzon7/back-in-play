import { lazy } from "react";
import type React from "react";

/**
 * Wraps React.lazy() so that chunk-load failures (stale deploy hashes after a
 * new deployment) trigger a hard page reload rather than leaving the user on a
 * broken blank screen.  Uses the same 30-second throttle as the index.html
 * inline handler so rapid reload loops are avoided.
 */
export function lazyWithReload<T extends React.ComponentType<unknown>>(
  factory: () => Promise<{ default: T }>,
) {
  return lazy(() =>
    factory().catch(() => {
      const key = "bip_chunk_reload";
      const last = sessionStorage.getItem(key);
      const now = Date.now();
      if (!last || now - parseInt(last, 10) > 30000) {
        sessionStorage.setItem(key, String(now));
        window.location.reload();
      }
      // Never resolves — reload fires before React needs the module.
      return new Promise<{ default: T }>(() => {});
    }),
  );
}
