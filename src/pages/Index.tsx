import { useState, useCallback, useRef, useEffect } from "react";
import { Switch } from "@/components/ui/switch";
import { MonitorSection, type ConversationEntry, type ActiveMessage } from "@/components/MonitorSection";
import { ConsoleSection } from "@/components/ConsoleSection";
import { useElevenLabsTranscriber, prefetchScribeToken } from "@/hooks/use-transcriber";
import { useDeepgramTranscriber, prefetchDeepgramToken } from "@/hooks/use-transcriber-deepgram";
import { translateText } from "@/lib/translate";
import { refineTranslations } from "@/lib/refine";
import { getLanguage, type Language } from "@/lib/languages";
import { playTranslation } from "@/lib/tts";
import { toast } from "@/hooks/use-toast";

type SttEngine = "elevenlabs" | "deepgram";

const Index = () => {
  const [fromLang, setFromLang] = useState<Language>(getLanguage("zh"));
  const [toLang, setToLang] = useState<Language>(getLanguage("en"));
  const [speechText, setSpeechText] = useState("");
  const [translationText, setTranslationText] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [entries, setEntries] = useState<ConversationEntry[]>([]);
  const [sttEngine, setSttEngine] = useState<SttEngine>("elevenlabs");

  const [activeMessage, setActiveMessage] = useState<ActiveMessage | null>(null);

  // All four transcriber hooks (React requires unconditional hook calls)
  const elMonitor = useElevenLabsTranscriber();
  const elConsole = useElevenLabsTranscriber();
  const dgMonitor = useDeepgramTranscriber();
  const dgConsole = useDeepgramTranscriber();

  // Select active transcribers based on engine
  const monitorTranscriber = sttEngine === "elevenlabs" ? elMonitor : dgMonitor;
  const consoleTranscriber = sttEngine === "elevenlabs" ? elConsole : dgConsole;

  const finalTextRef = useRef("");
  const isRecordingRef = useRef(false);

  const consoleFinalRef = useRef("");
  const consoleTranslatedRef = useRef("");
  const pendingConsoleTranslations = useRef(0);
  const consoleTranslationSeq = useRef(0);

  const activeFinalRef = useRef("");
  const activeTranslatedRef = useRef("");
  const pendingMonitorTranslations = useRef(0);
  const monitorTranslationSeq = useRef(0);
  const fromLangRef = useRef(fromLang);
  const toLangRef = useRef(toLang);
  const conversationBottomRef = useRef<HTMLDivElement>(null);

  const refinementSeq = useRef(0);
  const pendingRefinement = useRef<Promise<void> | null>(null);

  fromLangRef.current = fromLang;
  toLangRef.current = toLang;

  // Pre-fetch tokens on mount
  useEffect(() => {
    prefetchScribeToken();
    prefetchDeepgramToken();
  }, []);

  useEffect(() => {
    conversationBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries, activeMessage]);

  const haptic = () => {
    if (navigator.vibrate) navigator.vibrate(10);
  };

  // Resolve lang code based on engine
  const getLangCode = useCallback((lang: Language): string => {
    return sttEngine === "elevenlabs" ? lang.code : lang.speechCode;
  }, [sttEngine]);

  const triggerRefinement = useCallback((entriesToRefine: ConversationEntry[], sourceLang: string, targetLang: string) => {
    if (entriesToRefine.length === 0) return;
    const seqId = ++refinementSeq.current;
    const targetIds = entriesToRefine.map(e => e.id);
    const sentences = entriesToRefine.map(e => e.translated);
    const promise = refineTranslations(sentences, sourceLang, targetLang)
      .then((refined) => {
        if (seqId !== refinementSeq.current) return;
        setEntries(prev => prev.map(e => {
          const idx = targetIds.indexOf(e.id);
          if (idx !== -1 && refined[idx]) return { ...e, translated: refined[idx], refined: true };
          return e;
        }));
      })
      .catch(() => {
        if (seqId === refinementSeq.current) {
          setEntries(prev => prev.map(e => targetIds.includes(e.id) ? { ...e, refined: true } : e));
        }
      });
    pendingRefinement.current = promise;
  }, []);

  const addEntry = useCallback(
    (original: string, translated: string, from: Language, to: Language, speaker = "You") => {
      const entry: ConversationEntry = {
        id: crypto.randomUUID(), speaker, original, translated,
        fromFlag: from.flag, toFlag: to.flag, refined: false,
      };
      setEntries((prev) => {
        const next = [...prev, entry];
        const last2 = next.slice(-2);
        const srcLang = speaker === "Speaker" ? to.name : from.name;
        const tgtLang = speaker === "Speaker" ? from.name : to.name;
        setTimeout(() => triggerRefinement(last2, srcLang, tgtLang), 0);
        return next;
      });
    },
    [triggerRefinement]
  );

  const finalizeActiveBlock = useCallback(async () => {
    const text = activeFinalRef.current.trim();
    let translated = activeTranslatedRef.current.trim();
    if (text && !translated) {
      try { translated = await translateText(text, toLangRef.current.name, fromLangRef.current.name); } catch {}
    }
    if (text) addEntry(text, translated, toLangRef.current, fromLangRef.current, "Speaker");
    activeFinalRef.current = "";
    activeTranslatedRef.current = "";
    pendingMonitorTranslations.current = 0;
    setActiveMessage(null);
  }, [addEntry]);

  // ── Console ──
  const handleRecord = useCallback(() => {
    haptic();
    if (isRecording) {
      isRecordingRef.current = false;
      setIsRecording(false);
      consoleTranscriber.stop();

      const text = consoleFinalRef.current.trim();
      const translated = consoleTranslatedRef.current.trim();

      if (text && !translated) {
        setIsTranslating(true);
        translateText(text, fromLangRef.current.name, toLangRef.current.name)
          .then((result) => {
            setTranslationText(result);
            consoleTranslatedRef.current = result;
            addEntry(text, result, fromLangRef.current, toLangRef.current, "You");
          })
          .catch((e: any) => toast({ variant: "destructive", title: "Translation error", description: e.message }))
          .finally(() => setIsTranslating(false))
          .then(async () => { if (pendingRefinement.current) await pendingRefinement.current; });
      } else if (text) {
        addEntry(text, translated, fromLangRef.current, toLangRef.current, "You");
        if (pendingRefinement.current) pendingRefinement.current.then(() => {});
      }
    } else {
      consoleFinalRef.current = "";
      consoleTranslatedRef.current = "";
      pendingConsoleTranslations.current = 0;
      consoleTranslationSeq.current = 0;
      finalTextRef.current = "";
      setSpeechText("");
      setTranslationText("");
      isRecordingRef.current = true;
      setIsRecording(true);

      consoleTranscriber.start(
        getLangCode(fromLang),
        (text, isFinal) => {
          if (isFinal) {
            finalTextRef.current += text + " ";
            consoleFinalRef.current = finalTextRef.current.trim();
            setSpeechText(consoleFinalRef.current);
            const fullText = consoleFinalRef.current;
            if (fullText) {
              const seqId = ++consoleTranslationSeq.current;
              pendingConsoleTranslations.current++;
              setIsTranslating(true);
              translateText(fullText, fromLangRef.current.name, toLangRef.current.name)
                .then((result) => {
                  if (seqId === consoleTranslationSeq.current) {
                    consoleTranslatedRef.current = result;
                    setTranslationText(result);
                  }
                })
                .catch(() => {})
                .finally(() => {
                  pendingConsoleTranslations.current--;
                  if (pendingConsoleTranslations.current <= 0) setIsTranslating(false);
                });
            }
          } else {
            setSpeechText((finalTextRef.current + text).trim());
          }
        },
        (error) => {
          toast({ variant: "destructive", title: "Mic error", description: error });
          isRecordingRef.current = false;
          setIsRecording(false);
        }
      );
    }
  }, [isRecording, fromLang, toLang, addEntry, consoleTranscriber, getLangCode]);

  const handlePlay = useCallback(async () => {
    if (!translationText) return;
    haptic();
    if (isPlaying) { await playTranslation(translationText); setIsPlaying(false); return; }
    setIsPlaying(true);
    try {
      const started = await playTranslation(translationText, () => setIsPlaying(false));
      if (!started) setIsPlaying(false);
    } catch (e: any) {
      toast({ variant: "destructive", title: "Playback error", description: e.message });
      setIsPlaying(false);
    }
  }, [translationText, isPlaying]);

  const handleClear = useCallback(() => {
    haptic();
    setSpeechText(""); setTranslationText("");
    finalTextRef.current = ""; consoleFinalRef.current = ""; consoleTranslatedRef.current = "";
  }, []);

  const handleSwapLangs = useCallback(() => {
    setFromLang(toLang); setToLang(fromLang);
    if (consoleTranscriber.isConnected) consoleTranscriber.setLang(getLangCode(toLang));
    if (monitorTranscriber.isConnected) monitorTranscriber.setLang(getLangCode(fromLang));
  }, [fromLang, toLang, consoleTranscriber, monitorTranscriber, getLangCode]);

  // ── Monitor toggle ──
  const handleMonitorToggle = useCallback(
    async (checked: boolean) => {
      haptic();
      setIsMonitoring(checked);
      if (checked) {
        activeFinalRef.current = "";
        activeTranslatedRef.current = "";
        pendingMonitorTranslations.current = 0;
        monitorTranslationSeq.current = 0;
        setActiveMessage(null);

        monitorTranscriber.start(
          getLangCode(toLang),
          (text, isFinal) => {
            if (isFinal) {
              activeFinalRef.current += text + " ";
              const finalSoFar = activeFinalRef.current.trim();
              setActiveMessage({
                original: finalSoFar, interimSuffix: "",
                translated: activeTranslatedRef.current, interimTranslation: "",
                sourceFlag: toLangRef.current.flag, targetFlag: fromLangRef.current.flag,
              });
              const fullText = activeFinalRef.current.trim();
              if (fullText) {
                const seqId = ++monitorTranslationSeq.current;
                pendingMonitorTranslations.current++;
                translateText(fullText, toLangRef.current.name, fromLangRef.current.name)
                  .then((result) => {
                    if (seqId === monitorTranslationSeq.current) {
                      activeTranslatedRef.current = result;
                      setActiveMessage((prev) => prev ? { ...prev, translated: result, interimTranslation: "" } : null);
                    }
                  })
                  .catch(() => {})
                  .finally(() => { pendingMonitorTranslations.current--; });
              }
            } else {
              const currentFinal = activeFinalRef.current.trim();
              setActiveMessage({
                original: currentFinal, interimSuffix: " " + text,
                translated: activeTranslatedRef.current, interimTranslation: "",
                sourceFlag: toLangRef.current.flag, targetFlag: fromLangRef.current.flag,
              });
            }
          },
          (error) => {
            toast({ variant: "destructive", title: "Monitor error", description: error });
            setIsMonitoring(false);
          }
        );
      } else {
        monitorTranscriber.stop();
        const waitForTranslations = () =>
          new Promise<void>((resolve) => {
            const check = () => {
              if (pendingMonitorTranslations.current <= 0) resolve();
              else setTimeout(check, 100);
            };
            check();
          });
        await waitForTranslations();
        await finalizeActiveBlock();
        if (pendingRefinement.current) await pendingRefinement.current;
      }
    },
    [fromLang, toLang, finalizeActiveBlock, monitorTranscriber, getLangCode]
  );

  const handleEngineSwitch = useCallback((engine: SttEngine) => {
    if (isMonitoring || isRecording) {
      toast({ title: "Stop first", description: "Please stop recording/monitoring before switching engines." });
      return;
    }
    setSttEngine(engine);
    toast({ title: `STT: ${engine === "elevenlabs" ? "ElevenLabs" : "Deepgram"}` });
  }, [isMonitoring, isRecording]);

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-background">
      {/* Top bar */}
      <header className="flex items-center justify-between px-5 py-3 border-b border-border bg-card">
        <div className="flex items-center gap-2">
          <h1 className="text-base font-semibold text-foreground tracking-tight">Translator</h1>
          {/* STT Engine toggle */}
          <div className="flex items-center bg-muted rounded-full p-0.5 ml-2">
            <button
              onClick={() => handleEngineSwitch("elevenlabs")}
              className={`text-[9px] font-semibold px-2.5 py-1 rounded-full transition-colors ${
                sttEngine === "elevenlabs"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              EL
            </button>
            <button
              onClick={() => handleEngineSwitch("deepgram")}
              className={`text-[9px] font-semibold px-2.5 py-1 rounded-full transition-colors ${
                sttEngine === "deepgram"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              DG
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Monitor
          </span>
          <Switch checked={isMonitoring} onCheckedChange={handleMonitorToggle} />
        </div>
      </header>

      {/* Guide */}
      <div className="px-5 py-2 border-b border-border bg-muted/30">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          <span className="font-semibold text-foreground">📖 Guide</span>{" · "}
          <span className="font-medium">Incoming:</span> Enable Monitor to translate the other party. Turn off after the session.{" "}
          <span className="font-medium">Outgoing:</span> Tap Speaker for your turn; use the Loudspeaker icon for playback.
        </p>
      </div>

      <MonitorSection entries={entries} isMonitoring={isMonitoring} activeMessage={activeMessage} />

      <ConsoleSection
        speechText={speechText}
        translationText={translationText}
        isRecording={isRecording}
        isPlaying={isPlaying}
        isTranslating={isTranslating}
        fromLang={fromLang}
        toLang={toLang}
        onSpeechChange={setSpeechText}
        onRecord={handleRecord}
        onPlay={handlePlay}
        onClear={handleClear}
        onFromChange={setFromLang}
        onToChange={setToLang}
        onSwapLangs={handleSwapLangs}
      />
    </div>
  );
};

export default Index;
