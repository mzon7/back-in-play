# Project Rules

## Database Rules
- Shared Supabase — ALL table names prefixed with "back_in_play_"
- Use `dbTable(name)` and `supabase` from `src/lib/supabase.ts` (provided by @mzon7/zon-incubator-sdk) for all table references
- Create/alter tables via Management API (env vars $SUPABASE_PROJECT_REF and $SUPABASE_MGMT_TOKEN are ALREADY SET — just use them directly):
  ```
  curl -s -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
    -H "Authorization: Bearer $SUPABASE_MGMT_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"query": "..."}'
  ```
- To CHECK if tables exist:
  ```
  curl -s -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
    -H "Authorization: Bearer $SUPABASE_MGMT_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"query": "SELECT tablename FROM pg_tables WHERE schemaname='"'"'public'"'"' AND tablename LIKE '"'"'back_in_play_%'"'"';"}'
  ```
- Enable RLS on every new table
- ALWAYS add a SELECT policy whenever you add any other policy — never add INSERT/UPDATE/DELETE without SELECT or data will silently disappear on refresh
- Server-side API routes MUST use the service-role/admin Supabase client, NOT the anon client — this bypasses RLS and avoids policy gaps
- Client-side (browser) code may use the anon client — ensure matching RLS policies exist for every operation

## Auth Rules
- Auth components are provided by @mzon7/zon-incubator-sdk/auth: AuthProvider, useAuth, ProtectedRoute, AuthCallback
- Email confirmations are ENABLED — signUp() returns null session until user confirms email
- The /auth/callback route uses the AuthCallback component to exchange codes for sessions
- Built-in Supabase mailer: 4 emails/hour limit (dev only — configure SMTP for production)

## AI API Rules
- Only use AI/LLM APIs for which API keys are available in .env.local
- Use OpenAI (GPT) via $OPENAI_API_KEY or xAI (Grok) via $GROK_API_KEY
- Do NOT use Anthropic SDK or any other AI provider — no ANTHROPIC_API_KEY is available
- Default to Grok (xAI) unless the user specifies GPT

## Architecture: Frontend/Backend Separation
- NEVER call external APIs (AI, payment, etc.) directly from browser/client code
- All external API calls MUST go through server-side routes (Supabase Edge Functions)
- Use `callEdgeFunction()` from @mzon7/zon-incubator-sdk to call edge functions
- API keys must NEVER be exposed client-side (no VITE_ prefix for secrets)
- For long-running operations (AI calls, processing): write a task row to DB, process server-side, client polls for results
- DB writes that must not be lost should go through API routes, not direct client Supabase calls

## SDK Usage
- This project uses `@mzon7/zon-incubator-sdk` — import from it, do NOT rewrite these utilities:
  - `import { createProjectClient, dbTable, validateEnv, callEdgeFunction } from '@mzon7/zon-incubator-sdk'`
  - `import { AuthProvider, useAuth, ProtectedRoute, AuthCallback } from '@mzon7/zon-incubator-sdk/auth'`
- The Supabase client and dbTable helper are already configured in `src/lib/supabase.ts`