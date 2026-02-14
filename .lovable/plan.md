

## Fix: Restore Streaming Translation Subtitles in Conversation

### Problem
Two issues are causing translations to not appear in the conversation box:

1. **Translation gap on finals**: When a `isFinal` segment arrives, the code clears `interimTranslation` to `""` and sets `translated` to `activeTranslatedRef.current` (which hasn't been updated yet). This causes the translation line to disappear until the async translation completes.

2. **Overly restrictive throttle**: The interim throttle requires `fullInterimText.length > 5`, which may skip short initial utterances. Combined with the 1000ms / 10-char-growth condition, translations fire less frequently than the old debounce approach.

### Changes

#### 1. `src/pages/Index.tsx` - Fix the `isFinal` handler (Monitor)

In the `isFinal` block (around line 349), preserve existing translations instead of clearing them:

```typescript
// BEFORE (clears translation):
setActiveMessage({
  original: finalSoFar,
  interimSuffix: "",
  translated: activeTranslatedRef.current,
  interimTranslation: "",
  ...
});

// AFTER (preserves existing translation):
setActiveMessage((prev) => ({
  original: finalSoFar,
  interimSuffix: "",
  translated: activeTranslatedRef.current || prev?.translated || "",
  interimTranslation: prev?.interimTranslation || "",
  sourceFlag: toLangRef.current.flag,
  targetFlag: fromLangRef.current.flag,
}));
```

This ensures the old interim/final translation stays visible until the new final translation replaces it.

#### 2. `src/pages/Index.tsx` - Relax throttle conditions (Monitor interim block)

Lower the thresholds so interim translations fire more frequently:

```typescript
// BEFORE:
const shouldTranslate = (timeElapsed > 1000 || textGrew) && fullInterimText.length > 5;

// AFTER:
const shouldTranslate = (timeElapsed > 600 || textGrew) && fullInterimText.length > 3;
```

Also reduce the text growth threshold from 10 to 6 characters:
```typescript
const textGrew = Math.abs(fullInterimText.length - lastInterimTextLengthRef.current) > 6;
```

#### 3. `src/pages/Index.tsx` - Apply same fixes to Console interim block

Apply the same relaxed throttle conditions to the console interim translation block (around line 248-249):

```typescript
const textGrew = Math.abs(fullInterim.length - lastConsoleInterimTextLengthRef.current) > 6;
const shouldTranslate = (timeElapsed > 600 || textGrew) && fullInterim.length > 3;
```

### Summary of Threshold Changes

| Parameter | Old Value | New Value |
|-----------|-----------|-----------|
| Time throttle | 1000ms | 600ms |
| Text growth threshold | 10 chars | 6 chars |
| Minimum text length | 5 chars | 3 chars |

These changes ensure translations appear more frequently during speech and never "flash away" when a final segment arrives.

