import { useCallback, useRef } from "react";
import { DeepgramTranscriber, prefetchDeepgramToken } from "@/lib/deepgram";

type TranscriptCallback = (text: string, isFinal: boolean) => void;

export { prefetchDeepgramToken };

export function useDeepgramTranscriber() {
  const instanceRef = useRef<DeepgramTranscriber | null>(null);

  const start = useCallback(async (
    langCode: string,
    onResult: TranscriptCallback,
    onError?: (error: string) => void,
  ) => {
    // Clean up any existing instance
    if (instanceRef.current) {
      instanceRef.current.stop();
    }

    const transcriber = new DeepgramTranscriber(
      langCode,
      onResult,
      undefined,
      onError,
    );
    instanceRef.current = transcriber;
    await transcriber.start();
  }, []);

  const stop = useCallback(() => {
    if (instanceRef.current) {
      instanceRef.current.stop();
      instanceRef.current = null;
    }
  }, []);

  const setLang = useCallback((langCode: string) => {
    if (instanceRef.current) {
      instanceRef.current.setLang(langCode);
    }
  }, []);

  return {
    start,
    stop,
    setLang,
    isConnected: false, // Deepgram class manages its own connection state
    status: "disconnected" as const,
  };
}
