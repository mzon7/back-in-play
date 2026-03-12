# Known Patterns

## Edge Functions
- Edge functions return `{ data: T, error: string | null }`
- `supabase.functions.invoke()` wraps the response in another `{ data, error }` layer
- Always use `callEdgeFunction()` from the SDK — it unwraps automatically
- NEVER call `supabase.functions.invoke()` directly

## State Management
- State setters must guard against undefined: `setItems(data.items ?? [])`
- Always null-check nested properties before accessing: `if (!data?.project) return`
- Array methods (.filter, .map) crash on undefined — always provide fallback

## API Response Shapes
- Edge function → SDK unwraps → you get the inner `data` directly
- If you get `data.data.something`, the SDK unwrapping is broken or bypassed

## Learned: react-dom_client.js?v=70a232db (2026-03-12)
- The AI response indicates that a key prop was added to prevent reconciliation issues between components using different numbers of hooks, which directly addresses the original error.

## Learned: react-dom_client.js?v=70a232db (2026-03-12)
- The code diff shows that keys were added to the components, which addresses the issue of React rendering more hooks than during the previous render.

## Learned: react-dom_client.js?v=82e7d159 (2026-03-12)
- The code diff shows a change in the `HomePage.tsx` file where the key for the `LeagueInjuries` component was modified to a static value. This change addresses the issue of conditional rendering of hoo

## Learned: react-dom_client.js?v=82e7d159 (2026-03-12)
- The code diff includes the addition of a new `HooksErrorBoundary` component that catches and handles errors related to hooks being rendered inconsistently, which directly addresses the original error.

## Learned: react-dom_client.js?v=82e7d159 (2026-03-12)
- The code diff shows a change that introduces a `Fragment` with a dynamic `key` based on the current route, which addresses the issue of rendering more hooks than during the previous render by ensuring
