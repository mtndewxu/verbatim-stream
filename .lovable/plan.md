

# Improve Translation Accuracy

## Problem

Both Monitor and Console modes currently translate each Deepgram `is_final` segment independently:

```
Segment 1: "I want to" -> translated alone -> "我想"
Segment 2: "go to the store" -> translated alone -> "去商店"
Result: "我想 去商店" (concatenated, no coherence)
```

Deepgram segments are often just 2-5 words -- far too short for GPT to produce natural, contextual translations. The translations are then naively concatenated with spaces, which further degrades quality for Chinese (which has no word spaces).

## Solution: Full-Context Re-translation

Instead of translating each segment in isolation, re-translate the **entire accumulated original text** each time a new `is_final` segment arrives. This gives GPT the full semantic context, producing a single coherent translation.

```
Segment 1 arrives: translate("I want to") -> "我想"
Segment 2 arrives: translate("I want to go to the store") -> "我想去商店"
```

This trades slightly more API calls (same number, but longer input) for dramatically better translation quality.

## Changes

### 1. Console Mode (`src/pages/Index.tsx`, lines ~148-164)

Replace segment-only translation with full-text re-translation:

- Instead of `translateText(segment, ...)`, call `translateText(consoleFinalRef.current, ...)`
- Replace `consoleTranslatedRef.current` entirely with the new result (not append)
- Cancel any in-flight translation when a new segment arrives (use an incrementing request ID to discard stale results)

### 2. Monitor Mode (`src/pages/Index.tsx`, lines ~252-267)

Same pattern:

- Instead of `translateText(segment, ...)`, call `translateText(activeFinalRef.current, ...)`
- Replace `activeTranslatedRef.current` entirely with the new result
- Use request ID to discard stale out-of-order responses

### 3. Stale Response Handling

Add a `useRef` counter (e.g., `consoleTranslationSeq` and `monitorTranslationSeq`) that increments on each translation request. When the response arrives, only apply it if the sequence number matches the latest. This prevents older, shorter translations from overwriting newer, longer ones.

### 4. Translation Prompt Tweak (`supabase/functions/translate/index.ts`)

Update the system prompt to better handle full utterances:

- Add: "Translate the complete utterance as a whole. Do not add spaces between Chinese characters."
- This reinforces coherent output now that we're sending complete text.

## Technical Details

```text
Before (segment-by-segment):
  Segment -> translateText(segment) -> append result

After (full-context):
  Segment -> accumulatedText += segment
          -> seqId++
          -> translateText(accumulatedText)
          -> if seqId matches latest, replace entire translation
```

No new dependencies. No database changes. The number of API calls stays the same (one per `is_final`), but each call sends the full accumulated text for maximum context.

