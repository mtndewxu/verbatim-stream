import { useCallback, useRef } from "react";

type TranscriptCallback = (text: string, isFinal: boolean) => void;

const PROXY_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/volcengine-proxy`;

/**
 * Volcengine 同声传译 hook.
 * Same interface as EL/DG hooks: start(langCode, onResult, onError).
 * Additionally exposes onTranslation callback for the built-in translation.
 */
export function useVolcengineTranscriber() {
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const onResultRef = useRef<TranscriptCallback | null>(null);
  const onErrorRef = useRef<((error: string) => void) | null>(null);
  const targetLangRef = useRef("en");
  const onTranslationRef = useRef<TranscriptCallback | null>(null);

  /** Set target language before calling start. */
  const setTargetLang = useCallback((lang: string) => {
    targetLangRef.current = lang;
  }, []);

  /** Set callback for receiving built-in translations from Volcengine. */
  const setOnTranslation = useCallback((cb: TranscriptCallback | null) => {
    onTranslationRef.current = cb;
  }, []);

  const start = useCallback(async (
    langCode: string,
    onResult: TranscriptCallback,
    onError?: (error: string) => void,
  ) => {
    onResultRef.current = onResult;
    onErrorRef.current = onError || null;

    // Map language codes: Volcengine uses "zh" / "en"
    const sourceLang = langCode.startsWith("zh") ? "zh" : langCode.startsWith("en") ? "en" : langCode.split("-")[0];
    const targetLang = targetLangRef.current;

    try {
      const wsUrl = PROXY_BASE
        .replace("https://", "wss://")
        .replace("http://", "ws://")
        + `?source=${sourceLang}&target=${targetLang}`;

      console.log("[Volc] Connecting to proxy:", wsUrl);
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Connection timeout")), 15000);

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data as string);
            if (msg.type === "ready") {
              clearTimeout(timeout);
              resolve();
            }
          } catch {}
        };

        ws.onerror = () => {
          clearTimeout(timeout);
          reject(new Error("WebSocket connection failed"));
        };

        ws.onclose = () => {
          clearTimeout(timeout);
          reject(new Error("WebSocket closed before ready"));
        };
      });

      console.log("[Volc] Proxy ready, starting mic…");

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      streamRef.current = stream;

      const audioContext = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioContext;

      await audioContext.audioWorklet.addModule("/deepgram-processor.js");
      const source = audioContext.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(audioContext, "deepgram-processor");
      workletRef.current = worklet;

      worklet.port.onmessage = (e: MessageEvent) => {
        if (ws.readyState === WebSocket.OPEN && e.data instanceof ArrayBuffer) {
          ws.send(e.data);
        }
      };

      source.connect(worklet);
      worklet.connect(audioContext.destination);

      // Setup message handler
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);
          if (msg.type === "partial") {
            // Source text (partial)
            onResultRef.current?.(msg.text, false);
          } else if (msg.type === "final") {
            // Source text (final)
            onResultRef.current?.(msg.text, true);
          } else if (msg.type === "translation_partial") {
            // Translation (partial)
            onTranslationRef.current?.(msg.translation, false);
          } else if (msg.type === "translation_final") {
            // Translation (final)
            onTranslationRef.current?.(msg.translation, true);
          } else if (msg.type === "error") {
            console.error("[Volc] Server error:", msg.message);
            onErrorRef.current?.(msg.message || "Volcengine error");
          }
        } catch {}
      };

      ws.onclose = () => console.log("[Volc] WebSocket closed");
      ws.onerror = () => onErrorRef.current?.("Volcengine connection error");

      console.log("[Volc] Streaming started ✓");
    } catch (e: any) {
      console.error("[Volc] Start error:", e);
      onError?.(e.message || "Failed to start Volcengine");
    }
  }, []);

  const stop = useCallback(() => {
    console.log("[Volc] Stopping…");

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "audio_end" }));
      setTimeout(() => {
        wsRef.current?.close(1000, "User stopped");
        wsRef.current = null;
      }, 500);
    }

    if (workletRef.current) { workletRef.current.disconnect(); workletRef.current = null; }
    if (audioContextRef.current) { audioContextRef.current.close(); audioContextRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }

    onResultRef.current = null;
    onErrorRef.current = null;
  }, []);

  const setLang = useCallback((_langCode: string) => {
    console.log("[Volc] Language change requires reconnection");
  }, []);

  return {
    start,
    stop,
    setLang,
    setTargetLang,
    setOnTranslation,
    isConnected: false,
    status: "disconnected" as const,
  };
}
