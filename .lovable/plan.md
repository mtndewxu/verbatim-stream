

# Rolling Refinement: Dual-Pass Translation Strategy

## Overview

Add a second translation pass that refines the last 2 finalized message blocks together for better contextual accuracy. The first pass remains instant for real-time responsiveness; the second pass silently upgrades translations in-place with a subtle visual transition.

## Architecture

```text
isFinal segment arrives
  |
  v
Pass 1: translateText(fullAccumulatedText) --> immediate UI update (text-muted-foreground)
  |
  v
Pass 2: refineTranslation(last 2 entries) --> silent UI update (transition to text-foreground)
```

## Changes

### 1. New Edge Function: `supabase/functions/refine-translation/index.ts`

Create a dedicated refinement endpoint. Its system prompt instructs the LLM to review two consecutive sentences together for professional context, terminology consistency (CPO, OCS, etc.), and natural flow. Accepts `{ sentences: string[], fromLang, toLang }` and returns `{ refinements: string[] }` -- one refined translation per input sentence.

### 2. New Client Helper: `src/lib/refine.ts`

A thin wrapper (`refineTranslations(sentences, fromLang, toLang) => Promise<string[]>`) that calls the new edge function, mirroring the pattern in `src/lib/translate.ts`.

### 3. Track Refinement State on Entries

Extend `ConversationEntry` in `MonitorSection.tsx`:

- Add `refined?: boolean` field (default `false`).

When an entry is first created (from Pass 1), `refined` is `false`. After Pass 2 returns, update the specific entries in state and set `refined: true`.

### 4. Monitor Mode Changes (`src/pages/Index.tsx`)

**Current behavior**: Each `isFinal` triggers a full-context re-translation of the single active block. When monitoring stops, the block is finalized into `entries`.

**New behavior -- per-message blocks instead of one giant block**:

- Each time Deepgram delivers a natural pause / new utterance boundary (the existing `isFinal` segments), accumulate into the current active block as before.
- When the monitor stops, finalize as before.

**Rolling Refinement logic** (added after Pass 1 translation resolves):

- Maintain a `refinementQueue` ref holding the IDs of the last 2 finalized entries.
- After a new entry is added to `entries` (on monitor stop or on block finalization), trigger Pass 2:
  - Gather the last 2 entries from state.
  - Call `refineTranslations([entry1.translated, entry2.translated], ...)`.
  - On success, update those entries in `setEntries` with the refined text and set `refined: true`.
- Use a sequence counter to discard stale refinement responses.

**On stop**: Before the session fully closes, ensure the final refinement pass completes for the last remaining block(s). The existing `waitForTranslations` pattern will be extended to also wait for any pending refinement call.

### 5. Console Mode Changes (`src/pages/Index.tsx`)

Same pattern: after recording stops and the entry is added, trigger refinement on the last 2 console entries if available.

### 6. Visual Feedback (`src/components/MonitorSection.tsx`)

- Entries with `refined: false` render their translated text in `text-muted-foreground` (draft appearance).
- Entries with `refined: true` render in `text-foreground` with a CSS `transition-colors duration-700` for a smooth color shift.
- This gives users a subtle but clear signal that the translation has been quality-checked.

### 7. Stop Behavior

When `isMonitoring` or `isRecording` is toggled off:

1. Gracefully stop Deepgram (existing).
2. Wait for pending Pass 1 translations (existing).
3. Finalize the active block into entries (existing).
4. Trigger the final refinement pass for the last 2 entries.
5. Wait for the refinement response before fully resolving the stop handler.

This ensures no translation is left in "draft" state after a session ends.

## Technical Details

**Edge function prompt** (refine-translation):
```
"You are a professional translation reviewer. You are given two consecutive translated sentences from a live conversation. Review them together for:
- Professional terminology consistency (e.g., CPO, OCS, technical terms)
- Natural flow and coherence between sentences
- Accuracy of meaning
Return only the refined translations, one per line, with no explanations."
```

**Stale response handling**: A `refinementSeq` ref increments on each refinement call. Responses are only applied if `seqId === refinementSeq.current`.

**Entry update pattern**:
```typescript
setEntries(prev => prev.map(e =>
  targetIds.includes(e.id)
    ? { ...e, translated: refinedMap[e.id], refined: true }
    : e
));
```

No new dependencies. No database changes. One new edge function to deploy.

