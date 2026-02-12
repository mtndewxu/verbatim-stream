import { useCallback, useRef } from "react";

type TranscriptCallback = (text: string, isFinal: boolean) => void;

const PROXY_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/volcengine-proxy`;

/**
 * Volcengine 同声传译 hook.
 * Features:
 * - Auto language detection (zh↔en)
 * - Audio buffering during initialization
 * - Separate callbacks for source text and translation
 */
export function useVolcengineTranscriber() {
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const onResultRef = useRef<TranscriptCallback | null>(null);
  const onErrorRef = useRef<((error: string) => void) | null>(null);
  const onTranslationRef = useRef<TranscriptCallback | null>(null);
  const onLangDetectedRef = useRef<((lang: string) => void) | null>(null);

  // Audio buffer for pre-ready period
  const audioBufferRef = useRef<ArrayBuffer[]>([]);
  const isReadyRef = useRef(false);

  // Current connection params for auto-reconnect
  const currentSourceRef = useRef("zh");
  const currentTargetRef = useRef("en");
  const hasReconnectedRef = useRef(false);

  /** Set callback for receiving built-in translations from Volcengine. */
  const setOnTranslation = useCallback((cb: TranscriptCallback | null) => {
    onTranslationRef.current = cb;
  }, []);

  /** Set callback for language detection notifications. */
  const setOnLangDetected = useCallback((cb: ((lang: string) => void) | null) => {
    onLangDetectedRef.current = cb;
  }, []);

  const connectWebSocket = useCallback((
    sourceLang: string,
    targetLang: string,
  ) => {
    const wsUrl = PROXY_BASE
      .replace("https://", "wss://")
      .replace("http://", "ws://")
      + `?source=${sourceLang}&target=${targetLang}`;

    console.log(`[Volc] Connecting: source=${sourceLang} target=${targetLang}`);
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    isReadyRef.current = false;
    currentSourceRef.current = sourceLang;
    currentTargetRef.current = targetLang;

    return new Promise<WebSocket>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Connection timeout")), 15000);

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);
          if (msg.type === "ready") {
            clearTimeout(timeout);
            isReadyRef.current = true;
            // Flush buffered audio
            const buffered = audioBufferRef.current;
            console.log(`[Volc] Ready! Flushing ${buffered.length} buffered chunks`);
            for (const chunk of buffered) {
              if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
            }
            audioBufferRef.current = [];
            resolve(ws);
          }
        } catch {}
      };

      ws.onerror = () => { clearTimeout(timeout); reject(new Error("WebSocket connection failed")); };
      ws.onclose = () => { clearTimeout(timeout); reject(new Error("WebSocket closed before ready")); };
    });
  }, []);

  const setupMessageHandler = useCallback((ws: WebSocket) => {
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        if (msg.type === "partial") {
          onResultRef.current?.(msg.text, false);
        } else if (msg.type === "final") {
          onResultRef.current?.(msg.text, true);
          if (msg.detected_lang) {
            if (msg.detected_lang !== currentSourceRef.current && !hasReconnectedRef.current) {
              console.log(`[Volc] Language mismatch: expected ${currentSourceRef.current}, detected ${msg.detected_lang}. Auto-reconnecting…`);
              hasReconnectedRef.current = true;
              onLangDetectedRef.current?.(msg.detected_lang);
              autoReconnect();
            } else if (msg.detected_lang === currentSourceRef.current && hasReconnectedRef.current) {
              // Confirmed correct language after reconnect — allow future switches
              hasReconnectedRef.current = false;
            }
          }
        } else if (msg.type === "translation_partial") {
          onTranslationRef.current?.(msg.translation, false);
        } else if (msg.type === "translation_final") {
          onTranslationRef.current?.(msg.translation, true);
        } else if (msg.type === "error") {
          console.error("[Volc] Server error:", msg.message);
          onErrorRef.current?.(msg.message || "Volcengine error");
        }
      } catch {}
    };
    ws.onclose = () => console.log("[Volc] WebSocket closed");
    ws.onerror = () => onErrorRef.current?.("Volcengine connection error");
  }, []);

  const autoReconnect = useCallback(async () => {
    const oldWs = wsRef.current;
    const swappedSource = currentTargetRef.current;
    const swappedTarget = currentSourceRef.current;

    try {
      // Close old connection gracefully
      if (oldWs && oldWs.readyState === WebSocket.OPEN) {
        oldWs.send(JSON.stringify({ type: "audio_end" }));
        setTimeout(() => { try { oldWs.close(1000); } catch {} }, 200);
      }

      // Open new connection with swapped languages
      const newWs = await connectWebSocket(swappedSource, swappedTarget);
      setupMessageHandler(newWs);
      console.log(`[Volc] Reconnected with source=${swappedSource} target=${swappedTarget} ✓`);
    } catch (e: any) {
      console.error("[Volc] Auto-reconnect failed:", e);
    }
  }, [connectWebSocket, setupMessageHandler]);

  const start = useCallback(async (
    langCode: string,
    onResult: TranscriptCallback,
    onError?: (error: string) => void,
  ) => {
    onResultRef.current = onResult;
    onErrorRef.current = onError || null;
    hasReconnectedRef.current = false;
    audioBufferRef.current = [];

    // Default: zh→en, but use langCode to determine initial direction
    const sourceLang = langCode.startsWith("en") ? "en" : "zh";
    const targetLang = sourceLang === "zh" ? "en" : "zh";

    try {
      // Start mic BEFORE WebSocket is ready (to buffer audio)
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;

      const audioContext = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioContext;

      await audioContext.audioWorklet.addModule("/deepgram-processor.js");
      const source = audioContext.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(audioContext, "deepgram-processor");
      workletRef.current = worklet;

      // Audio data handler — buffers until ready, then sends directly
      worklet.port.onmessage = (e: MessageEvent) => {
        if (e.data instanceof ArrayBuffer) {
          const ws = wsRef.current;
          if (isReadyRef.current && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(e.data);
          } else {
            // Buffer audio while connecting
            audioBufferRef.current.push(e.data);
          }
        }
      };

      source.connect(worklet);
      worklet.connect(audioContext.destination);

      // Now connect WebSocket (mic is already recording & buffering)
      const ws = await connectWebSocket(sourceLang, targetLang);
      setupMessageHandler(ws);

      console.log("[Volc] Streaming started ✓");
    } catch (e: any) {
      console.error("[Volc] Start error:", e);
      onError?.(e.message || "Failed to start Volcengine");
    }
  }, [connectWebSocket, setupMessageHandler]);

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

    audioBufferRef.current = [];
    isReadyRef.current = false;
    onResultRef.current = null;
    onErrorRef.current = null;
  }, []);

  const setLang = useCallback((_langCode: string) => {
    console.log("[Volc] Language change requires reconnection");
  }, []);

  // Keep for backward compat but not used in auto-detect mode
  const setTargetLang = useCallback((_lang: string) => {}, []);

  return {
    start, stop, setLang, setTargetLang, setOnTranslation, setOnLangDetected,
    isConnected: false, status: "disconnected" as const,
  };
}
