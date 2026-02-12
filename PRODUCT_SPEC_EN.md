# Verbatim Stream — Real-Time Voice Translation App

## Product Overview

Verbatim Stream is a mobile-first real-time voice translation web app. Users select a source and target language, then the app listens to speech, transcribes, and translates in real time, displaying results as conversation bubbles. It uses a "Rolling Refinement" dual-pass strategy: Pass 1 delivers instant translations for responsiveness; Pass 2 silently refines the last two finalized translations for professional terminology consistency and natural flow.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + TypeScript + Vite |
| Styling | Tailwind CSS + shadcn/ui |
| Routing | react-router-dom v6 |
| Backend | Supabase Edge Functions (Deno) |
| STT | ElevenLabs Scribe v2 (primary) / Deepgram Nova-2 (secondary) |
| Translation | OpenAI GPT-5-nano |
| TTS | ElevenLabs eleven_turbo_v2_5 |

---

## Supported Languages

| Code | Language | Flag |
|------|----------|------|
| en | English | 🇺🇸 |
| zh | 中文 | 🇨🇳 |
| ja | 日本語 | 🇯🇵 |
| ko | 한국어 | 🇰🇷 |
| es | Español | 🇪🇸 |
| fr | Français | 🇫🇷 |
| de | Deutsch | 🇩🇪 |
| pt | Português | 🇧🇷 |
| ru | Русский | 🇷🇺 |
| ar | العربية | 🇸🇦 |

---

## App Structure

Single-page app (SPA) with one main route `/` containing two core modes:

### Mode 1: Monitor (Passive Listening)

- **Purpose**: Passively listen to others speaking and translate in real time
- **Interaction**: Tap "Monitor" button to start/stop
- **Behavior**:
  1. Open microphone, STT engine continuously transcribes
  2. On each `isFinal` segment, append to the current text block
  3. Re-translate the entire accumulated block (full-context re-translation for coherence)
  4. Show translation in an active bubble in real time
  5. On stop, finalize the active block as a `ConversationEntry`
  6. Trigger Pass 2 refinement

### Mode 2: Console (Active Speaking)

- **Purpose**: User speaks actively, gets translation with optional TTS playback
- **Interaction**: Hold record button to speak, release to stop
- **Behavior**:
  1. Real-time transcription and translation while recording (same as Monitor)
  2. On release, finalize and trigger refinement
  3. Each translation has a play button to invoke TTS
  4. Tap again to stop playback

---

## Core Mechanism: Rolling Refinement

```
isFinal segment arrives
  │
  ▼
Pass 1: translateText(fullAccumulatedText) → immediate UI update (text-muted-foreground)
  │
  ▼
Pass 2: refineTranslation(last 2 entries) → silent UI update (transition to text-foreground, 700ms)
```

### Pass 1 (Instant Translation)
- Triggered on each `isFinal` segment
- Translates the full accumulated text block via `translate` endpoint
- Displayed immediately in `text-muted-foreground` (draft appearance)

### Pass 2 (Contextual Refinement)
- Triggered after a new entry is finalized
- Takes the last 2 `ConversationEntry` translations
- Calls `refine-translation` endpoint
- Replaces translations with refined versions, sets `refined: true`
- Text color transitions to `text-foreground` with 700ms animation
- Uses sequence counter (`refinementSeq`) to discard stale responses

### Stop Behavior
1. Stop STT
2. Wait for all pending Pass 1 translations
3. Finalize active block
4. Trigger final refinement pass
5. Wait for refinement to complete before fully resolving

---

## Data Model

```typescript
interface ConversationEntry {
  id: string;           // crypto.randomUUID()
  original: string;     // Original transcription
  translated: string;   // Translation result
  timestamp: Date;
  refined: boolean;     // false=draft, true=refined
}
```

---

## Backend Edge Functions

### 1. `translate`
- **Method**: POST
- **Body**: `{ text: string, fromLang: string, toLang: string }`
- **Response**: `{ translation: string }`
- **Model**: GPT-5-nano
- **Prompt**: System prompt instructs to return only the translation with no explanation

### 2. `refine-translation`
- **Method**: POST
- **Body**: `{ sentences: string[], fromLang: string, toLang: string }`
- **Response**: `{ refinements: string[] }`
- **Model**: GPT-5-nano
- **Prompt**: Review two consecutive translated sentences for terminology consistency, natural flow, and accuracy

### 3. `elevenlabs-tts`
- **Method**: POST
- **Body**: `{ text: string }`
- **Response**: Audio binary stream (audio/mpeg)
- **Model**: eleven_turbo_v2_5

### 4. `elevenlabs-scribe-token`
- **Method**: GET
- **Response**: `{ signed_url: string }`
- **Purpose**: Generate temporary auth URL for client-side ElevenLabs STT

### 5. `deepgram-token`
- **Method**: GET
- **Response**: `{ token: string }`
- **Purpose**: Generate temporary API key for client-side Deepgram STT (50s TTL)

---

## STT Engine Switching

Two STT engines, switchable via UI toggle in the header:

### ElevenLabs Scribe v2 (Default)
- WebSocket: `wss://api.elevenlabs.io/v1/speech-to-text/ws`
- Built-in VAD (Voice Activity Detection)
- Language codes: ISO 639-1 (e.g., `zh`, `en`)

### Deepgram Nova-2
- WebSocket: `wss://api.deepgram.com/v1/listen`
- Audio captured via AudioWorklet (PCM)
- Language codes: BCP 47 (e.g., `zh-CN`, `en-US`)

Both engines share the same hook interface:
```typescript
interface TranscriberHook {
  start(langCode: string): Promise<void>;
  stop(): void;
  transcript: string;
  isFinal: boolean;
  listening: boolean;
}
```

---

## UI Layout

### Overall Structure
- Mobile-first design, `max-w-md`, centered
- Top: App title + language picker + STT engine toggle
- Middle: Scrollable conversation area
- Bottom: Mode tabs (Monitor / Console) + action buttons

### Language Picker
- Two pill-shaped buttons (source, target)
- Display flag emoji + language name
- Tap to open dropdown
- Swap button between them

### Conversation Bubbles
- Original text above (smaller font, `text-muted-foreground`)
- Translation below (normal font)
- Unrefined translations appear lighter
- Refined translations transition to full color with smooth animation

### Console Mode Extras
- Play button per entry to invoke TTS
- Spinning animation during playback

---

## Concurrency Control

### Translation Sequence (`translationSeq`)
- Increments on each translation request
- Stale responses discarded by comparing sequence IDs

### Refinement Sequence (`refinementSeq`)
- Same pattern for refinement requests
- Ensures only the latest refinement is applied

### Token Pre-caching
- STT tokens prefetched on app mount
- ElevenLabs: cached `signed_url`, single-use
- Deepgram: cached token, 50s TTL

---

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `VITE_SUPABASE_URL` | Backend project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Backend anon key |
| `OPENAI_API_KEY` (server) | OpenAI API key for translation & refinement |
| `ELEVENLABS_API_KEY` (server) | ElevenLabs API key for TTS & STT tokens |
| `DEEPGRAM_API_KEY` (server) | Deepgram API key for STT tokens |

---

## Design Specs

- **Theme**: Dark mode primary, HSL semantic CSS variables
- **Typography**: System font stack
- **Border radius**: Unified `--radius` design token
- **Animations**: Refinement transition uses `transition-colors duration-700`
- **Component library**: shadcn/ui (Radix UI based)

---

## Not Included

- No user authentication / login
- No database persistence (conversations exist only in current session)
- No multi-device sync
- No offline support
- No conversation export
