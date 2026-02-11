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
  private processor: ScriptProcessorNode | null = null;
  private audioCtx: AudioContext | null = null;
  private running = false;

  constructor(
    private lang: string,
    private onResult: TranscriptCallback,
    private onEnd?: () => void,
    private onError?: (error: string) => void
  ) {}

  setLang(lang: string) {
    this.lang = lang;
    // If running, restart with new lang
    if (this.running) {
      this.stop();
      this.start();
    }
  }

  async start() {
    if (this.running) return;
    this.running = true;

    try {
      const key = await getDeepgramKey();

      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });

      // Map speech codes to Deepgram language codes
      const dgLang = this.mapLang(this.lang);

      const wsUrl = `wss://api.deepgram.com/v1/listen?model=nova-2&language=${dgLang}&punctuate=true&interim_results=true&endpointing=300&smart_format=true`;

      this.ws = new WebSocket(wsUrl, ["token", key]);

      this.ws.onopen = () => {
        console.log("Deepgram connected");
        this.startStreaming();
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          const alt = data.channel?.alternatives?.[0];
          if (alt?.transcript) {
            const isFinal = data.is_final === true;
            this.onResult(alt.transcript, isFinal);
          }
        } catch {
          // ignore parse errors
        }
      };

      this.ws.onerror = (event) => {
        console.error("Deepgram WebSocket error:", event);
        this.onError?.("Deepgram connection error");
      };

      this.ws.onclose = () => {
        console.log("Deepgram disconnected");
        if (this.running) {
          // Auto-reconnect
          setTimeout(() => {
            if (this.running) this.start();
          }, 1000);
        } else {
          this.onEnd?.();
        }
      };
    } catch (e: any) {
      console.error("Deepgram start error:", e);
      this.running = false;
      this.onError?.(e.message || "Failed to start transcription");
    }
  }

  private startStreaming() {
    if (!this.mediaStream || !this.ws) return;

    this.audioCtx = new AudioContext({ sampleRate: 16000 });
    const source = this.audioCtx.createMediaStreamSource(this.mediaStream);

    // Use ScriptProcessorNode for broad compatibility
    this.processor = this.audioCtx.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (e) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      const input = e.inputBuffer.getChannelData(0);
      // Convert Float32 to Int16 PCM
      const pcm = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.ws.send(pcm.buffer);
    };

    source.connect(this.processor);
    this.processor.connect(this.audioCtx.destination);
  }

  stop() {
    this.running = false;

    this.processor?.disconnect();
    this.processor = null;

    if (this.audioCtx?.state !== "closed") {
      this.audioCtx?.close().catch(() => {});
    }
    this.audioCtx = null;

    this.mediaStream?.getTracks().forEach((t) => t.stop());
    this.mediaStream = null;

    if (this.ws?.readyState === WebSocket.OPEN) {
      // Send close message per Deepgram protocol
      this.ws.send(JSON.stringify({ type: "CloseStream" }));
      this.ws.close();
    }
    this.ws = null;
  }

  private mapLang(speechCode: string): string {
    // Map common BCP-47 codes to Deepgram language codes
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
    return true; // Deepgram works in all modern browsers
  }
}
