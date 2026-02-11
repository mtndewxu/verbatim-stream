

# 🌐 Real-Time Voice Translator App

A beautifully designed, Apple-inspired voice translation app with real-time transcription, AI-powered translation, and ElevenLabs voice cloning.

---

## 1. App Layout & Design
- **Apple-minimalist aesthetic** with system sans-serif fonts, light gray (#F9F9F9) background
- **Two-panel split layout**: Monitor (60% top) + Console (40% bottom), full-screen mobile-native feel (`h-screen`, `overflow-hidden`)
- **Glassmorphism console panel** at bottom with backdrop blur and subtle shadow
- Fully responsive — looks and feels like a native iOS/Android app on mobile

## 2. Monitor Section (Top — Conversation History)
- Scrollable container showing all past transcription + translation pairs
- Each bubble displays: **[Speaker Name] Original text → Translated text** (bold, high-contrast)
- Auto-scrolls to latest message as new content arrives

## 3. Console Section (Bottom — Controls)
- **Row 1 — "My Speech"**: Editable text area with live transcription appearing word-by-word (Web Speech API)
- **Row 2 — "Translation"**: Read-only area showing translated result
- **Row 3 — Action Buttons**:
  - 🎤 **Record** (large, circular, pulsing animation when active, haptic feedback on tap)
  - 🔊 **Play** (sends translation to ElevenLabs voice cloning, plays audio)
  - 🗑️ **Clear** (resets current speech/translation fields)
- **Language Picker**: Pill-shaped selector with country flags (e.g., 🇨🇳 CN ⇄ EN 🇺🇸), supporting multiple language pairs (CN, EN, JP, KR, ES, FR, etc.)

## 4. Real-Time Transcription
- Uses the **Web Speech API** for instant, on-device speech-to-text
- Text appears word-by-word as the user speaks
- No network latency for the transcription step

## 5. AI Translation (Lovable AI via Cloud)
- When the user stops recording, the transcribed text is sent to a **Lovable Cloud edge function** that calls the AI gateway for translation
- Supports all configured language pairs with automatic direction detection
- Result populates the "Translation" area instantly

## 6. Voice Cloning Playback (ElevenLabs)
- **Play button** sends the translated text to an **ElevenLabs TTS edge function** using a configured Voice ID
- Audio streams back and plays in the browser
- API key and Voice ID stored securely as Cloud secrets

## 7. Global Monitor Mode
- A **toggle switch** at the top to enable continuous background listening
- When active, the mic stays on — continuously transcribing and translating everything heard
- Results feed into the Monitor (top section) conversation history automatically
- Visual indicator showing the monitor is active

## 8. Backend (Lovable Cloud Edge Functions)
- **translate** — Receives text + language pair, calls Lovable AI gateway, returns translation
- **elevenlabs-tts** — Receives translated text + Voice ID, calls ElevenLabs API, streams audio back
- Secrets managed securely: `ELEVENLABS_API_KEY`, `VOICE_ID`

