import { toast } from "@/hooks/use-toast";

const PROXY_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/deepgram-proxy`;

type TranscriptCallback = (text: string, isFinal: boolean) => void;

/** Pre-warm is no longer needed (no token fetch), but keep export for compat. */
export function prefetchDeepgramToken(): void {
  // No-op: proxy handles auth server-side
}

export class DeepgramTranscriber {
  private ws: WebSocket | null = null;
  private mediaStream: MediaStream | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private audioCtx: AudioContext | null = null;
  private running = false;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 10;
  private readonly RECONNECT_BASE_DELAY = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private retryToastShown = false;
  private preConnectBuffer: ArrayBuffer[] = [];

  constructor(
    private lang: string,
    private onResult: TranscriptCallback,
    private onEnd?: () => void,
    private onError?: (error: string) => void
  ) {}

  setLang(lang: string) {
    this.lang = lang;
    if (this.running) {
      console.log("[Deepgram] Language changed to", lang, "— reconnecting WebSocket");
      this.reconnectWebSocket();
    }
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.reconnectAttempts = 0;
    this.retryToastShown = false;
    this.preConnectBuffer = [];
    console.log("[Deepgram] Starting transcriber, lang:", this.lang);

    try {
      if (!this.mediaStream) {
        console.log("[Deepgram] Requesting microphone access…");
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
        console.log("[Deepgram] Microphone acquired, tracks:", this.mediaStream.getAudioTracks().length);
      }

      await this.setupAudioWorklet();
      this.connectToProxy();
    } catch (e: any) {
      console.error("[Deepgram] Start error:", e);
      this.running = false;
      this.onError?.(e.message || "Failed to start transcription");
    }
  }

  private async setupAudioWorklet() {
    if (this.workletNode) return;

    console.log("[Deepgram] Setting up AudioWorklet…");
    this.audioCtx = new AudioContext({ sampleRate: 16000 });
    console.log("[Deepgram] AudioContext created, actual sampleRate:", this.audioCtx.sampleRate);
    await this.audioCtx.audioWorklet.addModule("/deepgram-processor.js");

    const source = this.audioCtx.createMediaStreamSource(this.mediaStream!);
    this.workletNode = new AudioWorkletNode(this.audioCtx, "deepgram-processor");

    this.workletNode.port.onmessage = (event: MessageEvent) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(event.data);
      } else {
        // Buffer audio while WebSocket is still connecting
        this.preConnectBuffer.push(event.data as ArrayBuffer);
      }
    };

    source.connect(this.workletNode);
    this.workletNode.connect(this.audioCtx.destination);
    console.log("[Deepgram] AudioWorklet pipeline ready (linear16, 16kHz)");
  }

  private connectToProxy() {
    const dgLang = this.mapLang(this.lang);

    // Connect to our server-side proxy instead of directly to Deepgram
    const wsUrl = PROXY_BASE
      .replace("https://", "wss://")
      .replace("http://", "ws://")
      + `?language=${dgLang}`;

    console.log("[Deepgram] Connecting to proxy:", wsUrl);
    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      console.log("[Deepgram] Proxy WebSocket connected ✓");
      // Don't flush yet — wait for proxy_ready signal
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string);

        // Proxy ready signal — flush buffered audio
        if (data.type === "proxy_ready") {
          console.log("[Deepgram] Proxy ready, flushing", this.preConnectBuffer.length, "buffered chunks");
          this.reconnectAttempts = 0;
          this.retryToastShown = false;
          for (const chunk of this.preConnectBuffer) {
            this.ws!.send(chunk);
          }
          this.preConnectBuffer = [];
          return;
        }

        if (data.type === "error") {
          console.error("[Deepgram] Proxy error:", data.message);
          return;
        }

        // Standard Deepgram responses
        if (data.type === "Metadata") {
          console.log("[Deepgram] Metadata received — request_id:", data.request_id, "model:", data.model_info?.name);
          return;
        }
        const alt = data.channel?.alternatives?.[0];
        if (alt?.transcript) {
          const isFinal = data.is_final === true;
          console.log(`[Deepgram] Transcript (${isFinal ? "FINAL" : "interim"}):`, alt.transcript);
          this.onResult(alt.transcript, isFinal);
        }
      } catch {
        // ignore parse errors
      }
    };

    this.ws.onerror = (event) => {
      console.error("[Deepgram] Proxy WebSocket error:", event);
    };

    this.ws.onclose = (event) => {
      console.log(`[Deepgram] Proxy WebSocket closed — code: ${event.code}, reason: "${event.reason}"`);
      if (this.running) {
        this.scheduleReconnect();
      } else {
        this.onEnd?.();
      }
    };
  }

  private scheduleReconnect() {
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      console.error(`[Deepgram] Max reconnect attempts (${this.MAX_RECONNECT_ATTEMPTS}) reached — stopping`);
      this.onError?.("Deepgram connection lost after multiple retries");
      this.running = false;
      this.onEnd?.();
      return;
    }

    if (!this.retryToastShown) {
      this.retryToastShown = true;
      toast({ title: "Connection retrying…", description: "Deepgram WebSocket reconnecting" });
    }

    const delay = this.RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempts) + Math.random() * 500;
    this.reconnectAttempts++;
    console.log(`[Deepgram] Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS})…`);

    this.reconnectTimer = setTimeout(() => {
      if (!this.running) return;
      try {
        this.connectToProxy();
      } catch (e: any) {
        console.error("[Deepgram] Reconnect failed:", e);
        this.scheduleReconnect();
      }
    }, delay);
  }

  private reconnectWebSocket() {
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
  }

  stop() {
    console.log("[Deepgram] Stopping transcriber");
    this.running = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.workletNode?.disconnect();
    this.workletNode = null;

    if (this.audioCtx?.state !== "closed") {
      this.audioCtx?.close().catch(() => {});
    }
    this.audioCtx = null;

    this.mediaStream?.getTracks().forEach((t) => t.stop());
    this.mediaStream = null;

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "CloseStream" }));
      this.ws.close();
    }
    this.ws = null;
    console.log("[Deepgram] Transcriber stopped ✓");
  }

  /**
   * Graceful stop: stops audio input, sends CloseStream, and waits for
   * Deepgram to flush remaining finals before resolving.
   */
  stopGracefully(timeoutMs = 3000): Promise<void> {
    return new Promise<void>((resolve) => {
      console.log("[Deepgram] Graceful stop initiated…");
      this.running = false;

      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      this.workletNode?.disconnect();
      this.workletNode = null;

      if (this.audioCtx?.state !== "closed") {
        this.audioCtx?.close().catch(() => {});
      }
      this.audioCtx = null;

      this.mediaStream?.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;

      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.ws = null;
        console.log("[Deepgram] No open WS, resolving immediately");
        resolve();
        return;
      }

      const timer = setTimeout(() => {
        console.log("[Deepgram] Graceful stop timed out, forcing close");
        this.ws?.close();
        this.ws = null;
        resolve();
      }, timeoutMs);

      const origOnClose = this.ws.onclose;
      this.ws.onclose = (event) => {
        clearTimeout(timer);
        console.log("[Deepgram] WS closed gracefully after flush");
        if (origOnClose) origOnClose.call(this.ws, event);
        this.ws = null;
        resolve();
      };

      this.ws.send(JSON.stringify({ type: "CloseStream" }));
    });
  }

  private mapLang(speechCode: string): string {
    const map: Record<string, string> = {
      "zh-CN": "zh", "zh-TW": "zh-TW", "en-US": "en", "en-GB": "en",
      "ja": "ja", "ko": "ko", "es-ES": "es", "fr-FR": "fr",
      "de-DE": "de", "pt-BR": "pt-BR", "ru-RU": "ru", "ar-SA": "ar",
      "hi-IN": "hi", "it-IT": "it",
    };
    return map[speechCode] || speechCode.split("-")[0];
  }

  get supported() { return true; }
}
