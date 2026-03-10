# Architecture

## Stack
- **Frontend**: React + Vite (TypeScript)
- **Backend**: Supabase (shared instance, table prefix: back_in_play_)
- **Edge Functions**: Deno runtime, deployed via incubator daemon
- **SDK**: @mzon7/zon-incubator-sdk (provides supabase client, callEdgeFunction, error reporting)

## Data Flow
1. User action → React component → callEdgeFunction(supabase, functionName, body)
2. Edge function processes request → returns { data, error }
3. SDK unwraps response → component receives typed data
4. On error: SDK logs to incubator_self_heal_errors → daemon auto-fixes

## Key Files
- `src/lib/supabase.ts` — Supabase client + dbTable helper
- `src/features/` — Feature modules (components, lib, tests)
- `supabase/functions/` — Edge functions
- `CLAUDE.md` — Agent rules
