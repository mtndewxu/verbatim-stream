

# Fix: Refinement Converting Chinese Back to English

## Root Cause

In `addEntry` (Index.tsx, lines 109-111), the refinement language direction is calculated with a speaker-based swap that is **incorrect**:

```typescript
const srcLang = speaker === "Speaker" ? to.name : from.name;
const tgtLang = speaker === "Speaker" ? from.name : to.name;
```

The callers already pass `from` and `to` in the correct semantic order:
- Console/You: `addEntry(text, result, fromLang, toLang, "You")` -- from=Chinese, to=English
- Monitor/Speaker: `addEntry(text, translated, toLang, fromLang, "Speaker")` -- from=English, to=Chinese

So `from.name` is always the source language and `to.name` is always the target language. The ternary swap reverses them for Speaker, causing the refinement prompt to say "Chinese to English" when it should say "English to Chinese". The LLM then "refines" the Chinese translations back into English.

## Fix

In `src/pages/Index.tsx`, replace lines 109-111:

```typescript
// Before (wrong):
const srcLang = speaker === "Speaker" ? to.name : from.name;
const tgtLang = speaker === "Speaker" ? from.name : to.name;

// After (correct):
const srcLang = from.name;
const tgtLang = to.name;
```

One file, two lines changed.

