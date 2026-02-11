/// <reference lib="dom" />

interface SpeechRecognitionType extends EventTarget {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

type SpeechCallback = (text: string, isFinal: boolean) => void;

export class SpeechRecognizer {
  private recognition: SpeechRecognitionType | null = null;
  private isRunning = false;

  constructor(
    private lang: string,
    private onResult: SpeechCallback,
    private onEnd?: () => void,
    private onError?: (error: string) => void
  ) {
    const SpeechRecognitionCtor =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) return;

    this.recognition = new SpeechRecognitionCtor() as SpeechRecognitionType;
    this.recognition.lang = lang;
    this.recognition.interimResults = true;
    this.recognition.continuous = true;

    this.recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          final += transcript;
        } else {
          interim += transcript;
        }
      }
      if (final) this.onResult(final, true);
      else if (interim) this.onResult(interim, false);
    };

    (this.recognition as any).onerror = (event: any) => {
      console.error("SpeechRecognition error:", event.error);
      if (event.error === "not-allowed" || event.error === "service-not-available") {
        this.isRunning = false;
        this.onError?.(event.error);
      }
      // "no-speech" and "aborted" are normal — onend will auto-restart
    };

    this.recognition.onend = () => {
      if (this.isRunning) {
        try {
          this.recognition?.start();
        } catch {}
      } else {
        this.onEnd?.();
      }
    };
  }

  setLang(lang: string) {
    this.lang = lang;
    if (this.recognition) this.recognition.lang = lang;
  }

  start() {
    if (!this.recognition) return;
    this.isRunning = true;
    try {
      this.recognition.start();
    } catch {}
  }

  stop() {
    this.isRunning = false;
    try {
      this.recognition?.stop();
    } catch {}
  }

  get supported() {
    return !!this.recognition;
  }
}
