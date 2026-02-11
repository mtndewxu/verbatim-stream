const TOKEN_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/deepgram-token`;

type TranscriptCallback = (text: string, isFinal: boolean) => void;

let cachedKey: string | null = null;

async function getDeepgramKey(): Promise<string> {
  if (cachedKey) return cachedKey;
  const resp = await fetch(TOKEN_URL, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
    },
  });
  if (!resp.ok) throw new Error("Failed to get Deepgram token");
  const data = await resp.json();
  cachedKey = data.key;
  return data.key;
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
    console.log("[Deepgram] Starting transcriber, lang:", this.lang);

    try {
      // Acquire mic once and keep it for the session
      if (!this.mediaStream) {
        console.log("[Deepgram] Requesting microphone access…");
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
        console.log("[Deepgram] Microphone acquired, tracks:", this.mediaStream.getAudioTracks().length);
      }

      await this.setupAudioWorklet();
      await this.connectWebSocket();
    } catch (e: any) {
      console.error("[Deepgram] Start error:", e);
      this.running = false;
      this.onError?.(e.message || "Failed to start transcription");
    }
  }

  private async setupAudioWorklet() {
    if (this.workletNode) return; // already set up

    console.log("[Deepgram] Setting up AudioWorklet…");
    this.audioCtx = new AudioContext({ sampleRate: 16000 });
    await this.audioCtx.audioWorklet.addModule("/deepgram-processor.js");

    const source = this.audioCtx.createMediaStreamSource(this.mediaStream!);
    this.workletNode = new AudioWorkletNode(this.audioCtx, "deepgram-processor");

    this.workletNode.port.onmessage = (event: MessageEvent) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(event.data);
      }
    };

    source.connect(this.workletNode);
    // Connect to destination to keep the graph alive (silent output)
    this.workletNode.connect(this.audioCtx.destination);
    console.log("[Deepgram] AudioWorklet pipeline ready (sampleRate: 16000)");
  }

  private async connectWebSocket() {
    const key = await getDeepgramKey();
    const dgLang = this.mapLang(this.lang);
    const wsUrl = `wss://api.deepgram.com/v1/listen?model=nova-2&language=${dgLang}&punctuate=true&interim_results=true&endpointing=300&smart_format=true`;

    console.log("[Deepgram] Opening WebSocket to", dgLang);
    this.ws = new WebSocket(wsUrl, ["token", key]);

    this.ws.onopen = () => {
      console.log("[Deepgram] WebSocket connected ✓ (attempt", this.reconnectAttempts, ")");
      this.reconnectAttempts = 0; // reset on success
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
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
      console.error("[Deepgram] WebSocket error:", event);
    };

    this.ws.onclose = (event) => {
      console.log(`[Deepgram] WebSocket closed — code: ${event.code}, reason: "${event.reason}", clean: ${event.wasClean}`);
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

    const delay = this.RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempts) + Math.random() * 500;
    this.reconnectAttempts++;
    console.log(`[Deepgram] Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS})…`);

    this.reconnectTimer = setTimeout(async () => {
      if (!this.running) return;
      try {
        await this.connectWebSocket();
      } catch (e: any) {
        console.error("[Deepgram] Reconnect failed:", e);
        this.scheduleReconnect();
      }
    }, delay);
  }

  private reconnectWebSocket() {
    // Close current WS and reconnect with new lang
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
    // onclose handler will trigger scheduleReconnect
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

  private mapLang(speechCode: string): string {
    const map: Record<string, string> = {
      "zh-CN": "zh",
      "zh-TW": "zh-TW",
      "en-US": "en",
      "en-GB": "en",
      "ja": "ja",
      "ko": "ko",
      "es-ES": "es",
      "fr-FR": "fr",
      "de-DE": "de",
      "pt-BR": "pt-BR",
      "ru-RU": "ru",
      "ar-SA": "ar",
      "hi-IN": "hi",
      "it-IT": "it",
    };
    return map[speechCode] || speechCode.split("-")[0];
  }

  get supported() {
    return true;
  }
}
