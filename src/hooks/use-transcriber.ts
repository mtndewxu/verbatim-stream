import { useScribe, CommitStrategy } from "@elevenlabs/react";
import { useCallback, useRef } from "react";

type TranscriptCallback = (text: string, isFinal: boolean) => void;

const TOKEN_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/elevenlabs-scribe-token`;

// Token pre-cache (single-use tokens are valid ~15min, but we refresh every 10min)
let cachedToken: string | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 10 * 60 * 1000;

async function getScribeToken(): Promise<string> {
  if (cachedToken && Date.now() < cacheExpiry) {
    console.log("[Scribe] Using cached token");
    return cachedToken;
  }
  console.log("[Scribe] Fetching single-use token…");
  const resp = await fetch(TOKEN_URL, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
    },
  });
  if (!resp.ok) throw new Error("Failed to get Scribe token");
  const data = await resp.json();
  cachedToken = data.token;
  cacheExpiry = Date.now() + CACHE_TTL_MS;
  console.log("[Scribe] Token obtained ✓");
  return data.token;
}

/** Pre-warm the token cache on mount. */
export function prefetchScribeToken(): void {
  getScribeToken().catch(() => {});
}

export function useElevenLabsTranscriber() {
  const onResultRef = useRef<TranscriptCallback | null>(null);
  const onErrorRef = useRef<((error: string) => void) | null>(null);
  const langRef = useRef("en");

  const scribe = useScribe({
    modelId: "scribe_v2_realtime",
    commitStrategy: CommitStrategy.VAD,
    onPartialTranscript: (data) => {
      console.log("[Scribe] Partial:", data.text);
      onResultRef.current?.(data.text, false);
    },
    onCommittedTranscript: (data) => {
      console.log("[Scribe] Committed:", data.text);
      onResultRef.current?.(data.text, true);
    },
    onError: (error) => {
      const msg = error instanceof Error ? error.message : "Transcription error";
      console.error("[Scribe] Error:", msg);
      onErrorRef.current?.(msg);
    },
    onConnect: () => console.log("[Scribe] Connected ✓"),
    onDisconnect: () => console.log("[Scribe] Disconnected"),
  });

  const start = useCallback(async (
    langCode: string,
    onResult: TranscriptCallback,
    onError?: (error: string) => void,
  ) => {
    onResultRef.current = onResult;
    onErrorRef.current = onError || null;
    langRef.current = langCode;

    try {
      // Invalidate cache since single-use tokens can only be used once
      cachedToken = null;
      cacheExpiry = 0;
      const token = await getScribeToken();
      await scribe.connect({
        token,
        languageCode: langCode,
        microphone: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
    } catch (e: any) {
      console.error("[Scribe] Start error:", e);
      onError?.(e.message || "Failed to start transcription");
    }
  }, [scribe]);

  const stop = useCallback(() => {
    console.log("[Scribe] Stopping…");
    scribe.disconnect();
    onResultRef.current = null;
    onErrorRef.current = null;
  }, [scribe]);

  const setLang = useCallback(async (langCode: string) => {
    langRef.current = langCode;
    if (scribe.isConnected && onResultRef.current) {
      console.log("[Scribe] Language changed to", langCode, "— reconnecting");
      scribe.disconnect();
      cachedToken = null;
      cacheExpiry = 0;
      const token = await getScribeToken();
      await scribe.connect({
        token,
        languageCode: langCode,
        microphone: { echoCancellation: true, noiseSuppression: true },
      });
    }
  }, [scribe]);

  return { start, stop, setLang, isConnected: scribe.isConnected, status: scribe.status };
}
