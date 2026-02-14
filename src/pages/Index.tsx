import { useState, useCallback, useRef, useEffect } from "react";
import { MonitorSection, type ConversationEntry, type ActiveMessage } from "@/components/MonitorSection";
import { ConsoleSection } from "@/components/ConsoleSection";
import { DeepgramTranscriber } from "@/lib/deepgram";
import { translateText } from "@/lib/translate";
import { refineTranslations } from "@/lib/refine";
import { getLanguage, type Language } from "@/lib/languages";
import { playTranslation } from "@/lib/tts";
import { toast } from "@/hooks/use-toast";

function Index() {
  const [fromLang, setFromLang] = useState<Language>(getLanguage("zh"));
  const [toLang, setToLang] = useState<Language>(getLanguage("en"));
  const [speechText, setSpeechText] = useState("");
  const [translationText, setTranslationText] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [entries, setEntries] = useState<ConversationEntry[]>([]);
  const [isMicReady, setIsMicReady] = useState(false);

  // Active message state for continuous merging — single block per session
  const [activeMessage, setActiveMessage] = useState<ActiveMessage | null>(null);

  const monitorRef = useRef<DeepgramTranscriber | null>(null);
  const recorderRef = useRef<DeepgramTranscriber | null>(null);
  const finalTextRef = useRef("");
  const isRecordingRef = useRef(false);

  // Console streaming translation refs
  const consoleFinalRef = useRef("");
  const consoleTranslatedRef = useRef("");
  const pendingConsoleTranslations = useRef(0);
  const consoleTranslationSeq = useRef(0);

  // Monitor merging refs — one block for entire session
  const activeFinalRef = useRef("");
  const activeTranslatedRef = useRef("");
  const pendingMonitorTranslations = useRef(0);
  const monitorTranslationSeq = useRef(0);
  const monitorInterimSeq = useRef(0);
  const fromLangRef = useRef(fromLang);
  const toLangRef = useRef(toLang);

  // Throttle refs for interim translations
  const lastTranslationTimeRef = useRef<number>(0);
  const lastInterimTextLengthRef = useRef<number>(0);
  const lastConsoleTranslationTimeRef = useRef<number>(0);
  const lastConsoleInterimTextLengthRef = useRef<number>(0);
  const conversationBottomRef = useRef<HTMLDivElement>(null);

  // Rolling refinement refs
  const refinementSeq = useRef(0);
  const pendingRefinement = useRef<Promise<void> | null>(null);

  // Keep refs in sync
  fromLangRef.current = fromLang;
  toLangRef.current = toLang;

  // Auto-scroll whenever activeMessage or entries change
  useEffect(() => {
    conversationBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries, activeMessage]);

  const haptic = () => {
    if (navigator.vibrate) navigator.vibrate(10);
  };

  // Trigger refinement on the last N entries (up to 2)
  const triggerRefinement = useCallback((entriesToRefine: ConversationEntry[], sourceLang: string, targetLang: string, allEntries: ConversationEntry[]) => {
    if (entriesToRefine.length === 0) return;

    const seqId = ++refinementSeq.current;
    const targetIds = entriesToRefine.map(e => e.id);
    const sentences = entriesToRefine.map(e => e.translated);

    // Get previous context: the entry just before the ones being refined
    const firstRefineIdx = allEntries.findIndex(e => e.id === targetIds[0]);
    const previousContext = firstRefineIdx > 0 ? allEntries[firstRefineIdx - 1].translated : undefined;

    const promise = refineTranslations(sentences, sourceLang, targetLang, previousContext)
      .then((refined) => {
        if (seqId !== refinementSeq.current) return; // stale
        setEntries(prev => prev.map(e => {
          const idx = targetIds.indexOf(e.id);
          if (idx !== -1 && refined[idx]) {
            return { ...e, translated: refined[idx], refined: true };
          }
          return e;
        }));
      })
      .catch(() => {
        // Refinement is best-effort; mark as refined anyway so color transitions
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
        // Trigger refinement on the last 2 entries
        const last2 = next.slice(-2);
        const srcLang = from.name;
        const tgtLang = to.name;
        // Schedule refinement async (after state update), pass full list for context
        setTimeout(() => triggerRefinement(last2, srcLang, tgtLang, next), 0);
        return next;
      });
    },
    [triggerRefinement]
  );

  // Finalize the active block → move to entries (only called when monitor stops)
  const finalizeActiveBlock = useCallback(async () => {
    const text = activeFinalRef.current.trim();
    let translated = activeTranslatedRef.current.trim();

    // If there's untranslated text remaining, translate it before finalizing
    if (text && !translated) {
      try {
        translated = await translateText(text, toLangRef.current.name, fromLangRef.current.name);
      } catch {
        // proceed with whatever we have
      }
    }

    if (text) {
      // Monitor: source is toLang, target is fromLang
      addEntry(text, translated, toLangRef.current, fromLangRef.current, "Speaker");
    }
    activeFinalRef.current = "";
    activeTranslatedRef.current = "";
    pendingMonitorTranslations.current = 0;
    setActiveMessage(null);
  }, [addEntry]);

  // ── Console: Record with Deepgram + streaming translation ──
  const handleRecord = useCallback(() => {
    haptic();
    if (isRecording) {
      // Stop recording
      isRecordingRef.current = false;
      setIsRecording(false);
      setIsMicReady(false);

      // Graceful stop to capture remaining finals
      const rec = recorderRef.current;
      recorderRef.current = null;

      if (rec) {
        rec.stopGracefully(3000).then(async () => {
          // After all finals received, check if we still need a final translation
          const text = consoleFinalRef.current.trim();
          const translated = consoleTranslatedRef.current.trim();

          if (text && !translated) {
            // No translation came in yet, do a full translate
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
            // Translation already streamed in — archive it
            addEntry(text, translated, fromLangRef.current, toLangRef.current, "You");
          }

          // Wait for refinement to finish
          if (pendingRefinement.current) {
            await pendingRefinement.current;
          }
        });
      }
    } else {
      // Start recording
      setIsMicReady(false);
      consoleFinalRef.current = "";
      consoleTranslatedRef.current = "";
      pendingConsoleTranslations.current = 0;
      consoleTranslationSeq.current = 0;
      lastConsoleTranslationTimeRef.current = 0;
      lastConsoleInterimTextLengthRef.current = 0;
      finalTextRef.current = "";
      setSpeechText("");
      setTranslationText("");
      isRecordingRef.current = true;

      const rec = new DeepgramTranscriber(
        fromLang.speechCode,
        (text, isFinal) => {
          if (isFinal) {
            finalTextRef.current += text + " ";
            consoleFinalRef.current = finalTextRef.current.trim();
            setSpeechText(consoleFinalRef.current);

            // Full-context re-translation: translate entire accumulated text
            const fullText = consoleFinalRef.current;
            if (fullText) {
              const seqId = ++consoleTranslationSeq.current;
              pendingConsoleTranslations.current++;
              setIsTranslating(true);
              translateText(fullText, fromLangRef.current.name, toLangRef.current.name)
                .then((result) => {
                  // Only apply if this is still the latest request
                  if (seqId === consoleTranslationSeq.current) {
                    consoleTranslatedRef.current = result;
                    setTranslationText(result);
                  }
                })
                .catch(() => {})
                .finally(() => {
                  pendingConsoleTranslations.current--;
                  if (pendingConsoleTranslations.current <= 0) {
                    setIsTranslating(false);
                  }
                });
            }
          } else {
            // Interim: show partial text immediately
            const fullInterim = (finalTextRef.current + text).trim();
            setSpeechText(fullInterim);

            // Throttled interim translation for console
            const now = Date.now();
            const timeElapsed = now - lastConsoleTranslationTimeRef.current;
            const textGrew = Math.abs(fullInterim.length - lastConsoleInterimTextLengthRef.current) > 6;
            const shouldTranslate = (timeElapsed > 600 || textGrew) && fullInterim.length > 3;

            if (shouldTranslate) {
              lastConsoleTranslationTimeRef.current = now;
              lastConsoleInterimTextLengthRef.current = fullInterim.length;

              const seqId = ++consoleTranslationSeq.current;
              pendingConsoleTranslations.current++;
              setIsTranslating(true);
              translateText(fullInterim, fromLangRef.current.name, toLangRef.current.name)
                .then((result) => {
                  if (seqId === consoleTranslationSeq.current) {
                    setTranslationText(result);
                  }
                })
                .catch(() => {})
                .finally(() => {
                  pendingConsoleTranslations.current--;
                  if (pendingConsoleTranslations.current <= 0) setIsTranslating(false);
                });
            }
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
        },
        () => setIsMicReady(true)
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

  // ── Monitor toggle ──
  const handleMonitorToggle = useCallback(
    async (checked: boolean) => {
      haptic();
      setIsMonitoring(checked);
      if (checked) {
        // Start fresh — single active block for entire session
        setIsMicReady(false);
        activeFinalRef.current = "";
        activeTranslatedRef.current = "";
        pendingMonitorTranslations.current = 0;
        monitorTranslationSeq.current = 0;
        monitorInterimSeq.current = 0;
        lastTranslationTimeRef.current = 0;
        lastInterimTextLengthRef.current = 0;
        setActiveMessage(null);

        const monitor = new DeepgramTranscriber(
          toLang.speechCode,
          (text, isFinal) => {
            if (isFinal) {
              // Append finalized segment to the single active block
              activeFinalRef.current += text + " ";
              const finalSoFar = activeFinalRef.current.trim();

              // Update active message immediately with original text + flag
              setActiveMessage((prev) => ({
                original: finalSoFar,
                interimSuffix: "",
                translated: activeTranslatedRef.current || prev?.translated || "",
                interimTranslation: prev?.interimTranslation || "",
                sourceFlag: toLangRef.current.flag,
                targetFlag: fromLangRef.current.flag,
              }));

              // Full-context re-translation: translate entire accumulated text
              const fullText = activeFinalRef.current.trim();
              if (fullText) {
                const seqId = ++monitorTranslationSeq.current;
                pendingMonitorTranslations.current++;
                translateText(fullText, toLangRef.current.name, fromLangRef.current.name)
                  .then((result) => {
                    // Only apply if this is still the latest request
                    if (seqId === monitorTranslationSeq.current) {
                      activeTranslatedRef.current = result;
                      setActiveMessage((prev) =>
                        prev ? { ...prev, translated: result } : null
                      );
                    }
                  })
                  .catch((err) => { console.error("[Monitor] Final translation error:", err); })
                  .finally(() => {
                    pendingMonitorTranslations.current--;
                  });
              }
            } else {
              // Interim: show partial text immediately with flag
              const currentFinal = activeFinalRef.current.trim();
              const interimSuffix = " " + text;
              const fullInterimText = (currentFinal + interimSuffix).trim();

              // 1. Update UI immediately with the raw text
              setActiveMessage((prev) => ({
                original: currentFinal,
                interimSuffix,
                translated: prev?.translated || activeTranslatedRef.current,
                interimTranslation: prev?.interimTranslation || "",
                sourceFlag: toLangRef.current.flag,
                targetFlag: fromLangRef.current.flag,
              }));

              // 2. Throttled interim translation (fire immediately on first, then throttle)
              const now = Date.now();
              const timeElapsed = now - lastTranslationTimeRef.current;
              const isFirst = lastTranslationTimeRef.current === 0;
              const textGrew = Math.abs(fullInterimText.length - lastInterimTextLengthRef.current) > 3;
              const shouldTranslate = (isFirst || timeElapsed > 400 || textGrew) && fullInterimText.length > 1;

              if (shouldTranslate) {
                lastTranslationTimeRef.current = now;
                lastInterimTextLengthRef.current = fullInterimText.length;

                const seqId = ++monitorInterimSeq.current;
                pendingMonitorTranslations.current++;
                translateText(fullInterimText, toLangRef.current.name, fromLangRef.current.name)
                  .then((result) => {
                    if (seqId === monitorInterimSeq.current) {
                      setActiveMessage((prev) =>
                        prev ? { ...prev, interimTranslation: result } : null
                      );
                    }
                  })
                  .catch((err) => { console.error("[Monitor] Interim translation error:", err); })
                  .finally(() => {
                    pendingMonitorTranslations.current--;
                  });
              }
            }
          },
          undefined,
          (error) => {
            toast({ variant: "destructive", title: "Monitor error", description: error });
            setIsMonitoring(false);
          },
          () => setIsMicReady(true)
        );

        monitorRef.current = monitor;
        monitor.start();
      } else {
        // Stopping
        setIsMicReady(false);

        // Graceful stop — wait for Deepgram to flush remaining finals
        const monitor = monitorRef.current;
        monitorRef.current = null;

        if (monitor) {
          await monitor.stopGracefully(3000);
        }

        // Wait for any pending segment translations to finish
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

        // Wait for the final refinement pass to complete
        if (pendingRefinement.current) {
          await pendingRefinement.current;
        }
      }
    },
    [fromLang, toLang, finalizeActiveBlock]
  );

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-background">
      {/* Top bar */}
      <header className="flex items-center justify-between px-5 py-3 border-b border-border bg-card">
        <h1 className="text-base font-semibold text-foreground tracking-tight">Translator</h1>
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
      <MonitorSection entries={entries} isMonitoring={isMonitoring} activeMessage={activeMessage} isMicReady={isMicReady} onMonitorToggle={handleMonitorToggle} />

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
        isMicReady={isMicReady}
      />
    </div>
  );
};

export default Index;
