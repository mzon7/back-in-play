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
