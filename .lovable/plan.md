

## Fix: "the string did not match expected pattern"

### Root Cause

The Deepgram API key returned from the backend function contains trailing whitespace (newline or space). When passed to `new WebSocket(url, ["token", key])`, the browser rejects it because WebSocket subprotocol strings cannot contain whitespace characters.

### Changes

**1. `src/lib/deepgram.ts` line 20** -- Trim the key on the client side:
```typescript
return data.key.trim();
```

**2. `supabase/functions/deepgram-token/index.ts`** -- Trim the key on the server side (defense in depth):
```typescript
return new Response(
  JSON.stringify({ key: DEEPGRAM_API_KEY.trim() }),
  ...
);
```

These two one-line changes fix the error. No other files need modification.

