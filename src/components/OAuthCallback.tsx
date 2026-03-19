import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

/**
 * Handles OAuth callback for both PKCE (?code=) and implicit (#access_token=) flows.
 * Supabase JS v2 defaults to PKCE — Google redirects back with ?code= in the query string.
 * The SDK's onAuthStateChange fires SIGNED_IN once the code is exchanged for a session.
 */
export function OAuthCallback() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const redirectTo = params.get("redirect") || "/";

    // Listen for auth state changes — works for both PKCE and implicit flows.
    // Supabase JS v2 auto-detects ?code= or #access_token= and exchanges them.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if ((event === "SIGNED_IN" || event === "TOKEN_REFRESHED") && session) {
        navigate(redirectTo, { replace: true });
      }
    });

    // Also check if session is already set (e.g., the SDK processed tokens before mount)
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        navigate(redirectTo, { replace: true });
      }
    });

    // If there's a code param, explicitly exchange it (handles email confirmation
    // and cases where the SDK didn't auto-process it)
    const code = params.get("code");
    if (code) {
      supabase.auth.exchangeCodeForSession(code).then(({ error: err }) => {
        if (err) {
          // "code already used" means the SDK already processed it — check session
          if (err.message.includes("already") || err.message.includes("expired")) {
            supabase.auth.getSession().then(({ data: { session } }) => {
              if (session) navigate(redirectTo, { replace: true });
              else setError("Authentication link expired. Please try again.");
            });
          } else {
            setError(err.message);
          }
        }
      });
    }

    // Timeout fallback
    const timeout = setTimeout(() => {
      supabase.auth.getSession().then(({ data: { session } }) => {
        if (!session) setError("Authentication timed out. Please try again.");
      });
    }, 15000);

    return () => {
      subscription.unsubscribe();
      clearTimeout(timeout);
    };
  }, [navigate]);

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen flex-col gap-4">
        <p className="text-red-400">{error}</p>
        <a href="/login" className="text-blue-400 hover:text-blue-300 underline">Back to login</a>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center min-h-screen">
      <p className="text-white/50">Signing you in...</p>
    </div>
  );
}
