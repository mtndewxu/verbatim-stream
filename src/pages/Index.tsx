import { useState, useCallback, useRef, useEffect } from "react";
import { Switch } from "@/components/ui/switch";
import { MonitorSection, type ConversationEntry, type ActiveMessage } from "@/components/MonitorSection";
import { ConsoleSection } from "@/components/ConsoleSection";
import { DeepgramTranscriber, type ConnectionState } from "@/lib/deepgram";
import { translateText } from "@/lib/translate";
import { refineTranslations } from "@/lib/refine";
import { getLanguage, type Language } from "@/lib/languages";
import { playTranslation } from "@/lib/tts";
import { toast } from "@/hooks/use-toast";

const PARTIAL_TRIGGER_CHARS = 20;
const PARTIAL_TRIGGER_PAUSE_MS = 500;

const Index = () => {
  const [fromLang, setFromLang] = useState<Language>(getLanguage("zh"));
  const [toLang, setToLang] = useState<Language>(getLanguage("en"));
  const [speechText, setSpeechText] = useState("");
  const [translationText, setTranslationText] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [entries, setEntries] = useState<ConversationEntry[]>([]);

  const [activeMessage, setActiveMessage] = useState<ActiveMessage | null>(null);

  const monitorRef = useRef<DeepgramTranscriber | null>(null);
  const recorderRef = useRef<DeepgramTranscriber | null>(null);
  const finalTextRef = useRef("");
  const isRecordingRef = useRef(false);

  // Console streaming translation refs
  const consoleFinalRef = useRef("");
  const consoleTranslatedRef = useRef("");
  const consoleTranslationSeq = useRef(0);
  const consoleAbortRef = useRef<AbortController | null>(null);

  // Monitor merging refs
  const activeFinalRef = useRef("");
  const activeTranslatedRef = useRef("");
  const monitorTranslationSeq = useRef(0);
  const monitorAbortRef = useRef<AbortController | null>(null);
  const fromLangRef = useRef(fromLang);
  const toLangRef = useRef(toLang);
  const conversationBottomRef = useRef<HTMLDivElement>(null);

  // Partial pre-translation refs (monitor)
  const monitorInterimRef = useRef("");
  const monitorPartialTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const monitorPartialAbortRef = useRef<AbortController | null>(null);

  // Partial pre-translation refs (console)
  const consoleInterimRef = useRef("");
  const consolePartialTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const consolePartialAbortRef = useRef<AbortController | null>(null);

  // Rolling refinement refs
  const refinementSeq = useRef(0);
  const pendingRefinement = useRef<Promise<void> | null>(null);

  // Pending translation counters
  const pendingMonitorTranslations = useRef(0);
  const pendingConsoleTranslations = useRef(0);

  fromLangRef.current = fromLang;
  toLangRef.current = toLang;

  useEffect(() => {
    conversationBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries, activeMessage]);

  const haptic = () => {
    if (navigator.vibrate) navigator.vibrate(10);
  };

  // ── Refinement ──
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
          if (idx !== -1 && refined[idx]) {
            return { ...e, translated: refined[idx], refined: true };
          }
          return e;
        }));
      })
      .catch(() => {
        if (seqId === refinementSeq.current) {
          setEntries(prev => prev.map(e =>
            targetIds.includes(e.id) ? { ...e, refined: true } : e
          ));
        }
      });
    pendingRefinement.current = promise;
  }, []);

  const addEntry = useCallback(
    (original: string, translated: string, from: Language, to: Language, speaker = "You") => {
      const entry: ConversationEntry = {
        id: crypto.randomUUID(),
        speaker,
        original,
        translated,
        fromFlag: from.flag,
        toFlag: to.flag,
        refined: false,
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
      try {
        translated = await translateText(text, toLangRef.current.name, fromLangRef.current.name);
      } catch {
        // proceed with whatever we have
      }
    }

    if (text) {
      addEntry(text, translated, toLangRef.current, fromLangRef.current, "Speaker");
    }
    activeFinalRef.current = "";
    activeTranslatedRef.current = "";
    pendingMonitorTranslations.current = 0;
    setActiveMessage(null);
  }, [addEntry]);

  // ── Helper: fire a translation with AbortController ──
  const fireTranslation = (
    fullText: string,
    srcLang: string,
    tgtLang: string,
    seqRef: React.MutableRefObject<number>,
    abortRef: React.MutableRefObject<AbortController | null>,
    onResult: (result: string, seqId: number) => void,
    pendingRef: React.MutableRefObject<number>,
    onFinally?: () => void
  ) => {
    // Abort any previous request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const seqId = ++seqRef.current;
    pendingRef.current++;

    translateText(fullText, srcLang, tgtLang, controller.signal)
      .then((result) => {
        if (seqId === seqRef.current && !controller.signal.aborted) {
          onResult(result, seqId);
        }
      })
      .catch((e) => {
        if (e.name === "AbortError") return; // expected
      })
      .finally(() => {
        pendingRef.current--;
        onFinally?.();
      });
  };

  // ── Partial pre-translation trigger ──
  const schedulePartialTranslation = (
    interimText: string,
    finalSoFar: string,
    srcLang: string,
    tgtLang: string,
    timerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>,
    partialAbortRef: React.MutableRefObject<AbortController | null>,
    onResult: (result: string) => void
  ) => {
    // Clear previous timer
    if (timerRef.current) clearTimeout(timerRef.current);

    const combinedText = (finalSoFar + " " + interimText).trim();
    if (interimText.length < PARTIAL_TRIGGER_CHARS) return;

    timerRef.current = setTimeout(() => {
      // Fire a speculative translation of final + interim
      partialAbortRef.current?.abort();
      const controller = new AbortController();
      partialAbortRef.current = controller;

      translateText(combinedText, srcLang, tgtLang, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) {
            onResult(result);
          }
        })
        .catch(() => {}); // ignore abort errors
    }, PARTIAL_TRIGGER_PAUSE_MS);
  };

  // ── Console: Record with Deepgram + streaming translation ──
  const handleRecord = useCallback(() => {
    haptic();
    if (isRecording) {
      isRecordingRef.current = false;
      setIsRecording(false);

      const rec = recorderRef.current;
      recorderRef.current = null;

      if (rec) {
        rec.stopGracefully(3000).then(async () => {
          const text = consoleFinalRef.current.trim();
          const translated = consoleTranslatedRef.current.trim();

          if (text && !translated) {
            setIsTranslating(true);
            try {
              const result = await translateText(text, fromLangRef.current.name, toLangRef.current.name);
              setTranslationText(result);
              consoleTranslatedRef.current = result;
              addEntry(text, result, fromLangRef.current, toLangRef.current, "You");
            } catch (e: any) {
              toast({ variant: "destructive", title: "Translation error", description: e.message });
            } finally {
              setIsTranslating(false);
            }
          } else if (text) {
            addEntry(text, translated, fromLangRef.current, toLangRef.current, "You");
          }

          if (pendingRefinement.current) {
            await pendingRefinement.current;
          }
        });
      }
    } else {
      consoleFinalRef.current = "";
      consoleTranslatedRef.current = "";
      consoleTranslationSeq.current = 0;
      consoleAbortRef.current = null;
      pendingConsoleTranslations.current = 0;
      consoleInterimRef.current = "";
      finalTextRef.current = "";
      setSpeechText("");
      setTranslationText("");
      isRecordingRef.current = true;

      const rec = new DeepgramTranscriber(
        fromLang.speechCode,
        (text, isFinal) => {
          if (isFinal) {
            // Cancel any partial pre-translation
            if (consolePartialTimer.current) clearTimeout(consolePartialTimer.current);
            consolePartialAbortRef.current?.abort();

            finalTextRef.current += text + " ";
            consoleFinalRef.current = finalTextRef.current.trim();
            setSpeechText(consoleFinalRef.current);

            const fullText = consoleFinalRef.current;
            if (fullText) {
              fireTranslation(
                fullText,
                fromLangRef.current.name,
                toLangRef.current.name,
                consoleTranslationSeq,
                consoleAbortRef,
                (result) => {
                  consoleTranslatedRef.current = result;
                  setTranslationText(result);
                },
                pendingConsoleTranslations,
                () => {
                  if (pendingConsoleTranslations.current <= 0) setIsTranslating(false);
                }
              );
              setIsTranslating(true);
            }
          } else {
            consoleInterimRef.current = text;
            setSpeechText((finalTextRef.current + text).trim());

            // Schedule partial pre-translation
            schedulePartialTranslation(
              text,
              consoleFinalRef.current,
              fromLangRef.current.name,
              toLangRef.current.name,
              consolePartialTimer,
              consolePartialAbortRef,
              (result) => {
                // Show as interim translation
                setTranslationText(result);
                setIsTranslating(true);
              }
            );
          }
        },
        () => {
          isRecordingRef.current = false;
          setIsRecording(false);
        },
        (error) => {
          toast({ variant: "destructive", title: "Mic error", description: error });
          isRecordingRef.current = false;
          setIsRecording(false);
        }
      );

      recorderRef.current = rec;
      rec.start();
      setIsRecording(true);
    }
  }, [isRecording, fromLang, toLang, addEntry]);

  const handlePlay = useCallback(async () => {
    if (!translationText) return;
    haptic();
    if (isPlaying) {
      await playTranslation(translationText);
      setIsPlaying(false);
      return;
    }
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
    setSpeechText("");
    setTranslationText("");
    finalTextRef.current = "";
    consoleFinalRef.current = "";
    consoleTranslatedRef.current = "";
  }, []);

  const handleSwapLangs = useCallback(() => {
    setFromLang(toLang);
    setToLang(fromLang);
    if (recorderRef.current) recorderRef.current.setLang(toLang.speechCode);
    if (monitorRef.current) monitorRef.current.setLang(fromLang.speechCode);
  }, [fromLang, toLang]);

  // ── Monitor toggle with state guard ──
  const handleMonitorToggle = useCallback(
    async (checked: boolean) => {
      if (isProcessing) return; // prevent rapid toggling
      haptic();
      setIsProcessing(true);

      try {
        setIsMonitoring(checked);
        if (checked) {
          activeFinalRef.current = "";
          activeTranslatedRef.current = "";
          pendingMonitorTranslations.current = 0;
          monitorTranslationSeq.current = 0;
          monitorAbortRef.current = null;
          monitorInterimRef.current = "";
          setActiveMessage(null);

          const monitor = new DeepgramTranscriber(
            toLang.speechCode,
            (text, isFinal) => {
              if (isFinal) {
                // Cancel any partial pre-translation
                if (monitorPartialTimer.current) clearTimeout(monitorPartialTimer.current);
                monitorPartialAbortRef.current?.abort();

                activeFinalRef.current += text + " ";
                const finalSoFar = activeFinalRef.current.trim();

                setActiveMessage({
                  original: finalSoFar,
                  interimSuffix: "",
                  translated: activeTranslatedRef.current,
                  interimTranslation: "",
                  sourceFlag: toLangRef.current.flag,
                  targetFlag: fromLangRef.current.flag,
                });

                const fullText = activeFinalRef.current.trim();
                if (fullText) {
                  fireTranslation(
                    fullText,
                    toLangRef.current.name,
                    fromLangRef.current.name,
                    monitorTranslationSeq,
                    monitorAbortRef,
                    (result) => {
                      activeTranslatedRef.current = result;
                      setActiveMessage((prev) =>
                        prev ? { ...prev, translated: result, interimTranslation: "" } : null
                      );
                    },
                    pendingMonitorTranslations
                  );
                }
              } else {
                monitorInterimRef.current = text;
                const currentFinal = activeFinalRef.current.trim();
                const interimSuffix = " " + text;

                setActiveMessage({
                  original: currentFinal,
                  interimSuffix,
                  translated: activeTranslatedRef.current,
                  interimTranslation: "",
                  sourceFlag: toLangRef.current.flag,
                  targetFlag: fromLangRef.current.flag,
                });

                // Schedule partial pre-translation for long interim text
                schedulePartialTranslation(
                  text,
                  currentFinal,
                  toLangRef.current.name,
                  fromLangRef.current.name,
                  monitorPartialTimer,
                  monitorPartialAbortRef,
                  (result) => {
                    setActiveMessage((prev) =>
                      prev ? { ...prev, interimTranslation: result } : null
                    );
                  }
                );
              }
            },
            undefined,
            (error) => {
              toast({ variant: "destructive", title: "Monitor error", description: error });
              setIsMonitoring(false);
              setIsProcessing(false);
            }
          );

          monitorRef.current = monitor;
          await monitor.start();
        } else {
          const monitor = monitorRef.current;
          monitorRef.current = null;

          // Cancel partial timers
          if (monitorPartialTimer.current) clearTimeout(monitorPartialTimer.current);
          monitorPartialAbortRef.current?.abort();

          if (monitor) {
            await monitor.stopGracefully(3000);
          }

          const waitForTranslations = () =>
            new Promise<void>((resolve) => {
              const check = () => {
                if (pendingMonitorTranslations.current <= 0) {
                  resolve();
                } else {
                  setTimeout(check, 100);
                }
              };
              check();
            });

          await waitForTranslations();
          await finalizeActiveBlock();

          if (pendingRefinement.current) {
            await pendingRefinement.current;
          }
        }
      } finally {
        setIsProcessing(false);
      }
    },
    [fromLang, toLang, finalizeActiveBlock, isProcessing]
  );

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-background">
      {/* Top bar */}
      <header className="flex items-center justify-between px-5 py-3 border-b border-border bg-card">
        <h1 className="text-base font-semibold text-foreground tracking-tight">Translator</h1>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Monitor
          </span>
          <Switch
            checked={isMonitoring}
            onCheckedChange={handleMonitorToggle}
            disabled={isProcessing}
          />
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

      {/* Monitor (top ~60%) */}
      <MonitorSection entries={entries} isMonitoring={isMonitoring} activeMessage={activeMessage} />

      {/* Console (bottom ~40%) */}
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
