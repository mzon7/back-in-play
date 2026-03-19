import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

/**
 * Handles both OAuth (hash fragment tokens) and email confirmation (code param).
 * Supabase OAuth implicit flow returns tokens in the URL hash (#access_token=...).
 * The Supabase JS client auto-detects the hash and sets the session via onAuthStateChange.
 */
export function OAuthCallback() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Check for PKCE code param (email confirmation)
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");

    if (code) {
      // Email confirmation flow
      supabase.auth.exchangeCodeForSession(code).then(({ error: err }) => {
        if (err) setError(err.message);
        else navigate("/", { replace: true });
      });
      return;
    }

    // OAuth implicit flow — tokens are in the hash fragment.
    // Supabase JS client auto-detects and sets session via onAuthStateChange.
    // Just wait for session to be set.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN" && session) {
        navigate("/", { replace: true });
      }
    });

    // Also check if session is already set (e.g. hash was processed before this mounted)
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        navigate("/", { replace: true });
      } else if (!window.location.hash) {
        // No hash and no code — invalid callback
        setError("Authentication failed. Please try again.");
      }
    });

    // Timeout fallback
    const timeout = setTimeout(() => {
      supabase.auth.getSession().then(({ data: { session } }) => {
        if (!session) setError("Authentication timed out. Please try again.");
      });
    }, 10000);

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
