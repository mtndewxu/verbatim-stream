

## Change Deepgram Model from Nova-2 to Nova-3

### What
Update the transcription model from `nova-2` to `nova-3` in the WebSocket connection URL.

### Change

**File: `src/lib/deepgram.ts` (line 118)**

Replace `model=nova-2` with `model=nova-3` in the WebSocket URL:

```typescript
// Before
const wsUrl = `wss://api.deepgram.com/v1/listen?model=nova-2&language=...`;

// After
const wsUrl = `wss://api.deepgram.com/v1/listen?model=nova-3&language=...`;
```

### Note
Nova-3 is Deepgram's latest model with improved accuracy. All other parameters (encoding, sample rate, punctuation, interim results, endpointing) remain unchanged.

