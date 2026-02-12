import { useState, useCallback, useRef, useEffect } from "react";
import { Switch } from "@/components/ui/switch";
import { MonitorSection, type ConversationEntry, type ActiveMessage } from "@/components/MonitorSection";
import { ConsoleSection } from "@/components/ConsoleSection";
import { DeepgramTranscriber } from "@/lib/deepgram";
import { translateText } from "@/lib/translate";
import { playTranslation } from "@/lib/tts";
import { getLanguage, type Language } from "@/lib/languages";
import { toast } from "@/hooks/use-toast";

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

  // Active message state for continuous merging — single block per session
  const [activeMessage, setActiveMessage] = useState<ActiveMessage | null>(null);

  const monitorRef = useRef<DeepgramTranscriber | null>(null);
  const recorderRef = useRef<DeepgramTranscriber | null>(null);
  const finalTextRef = useRef("");
  const isRecordingRef = useRef(false);

  // Monitor merging refs — one block for entire session
  const activeFinalRef = useRef("");
  const activeTranslatedRef = useRef("");
  const fromLangRef = useRef(fromLang);
  const toLangRef = useRef(toLang);
  const conversationBottomRef = useRef<HTMLDivElement>(null);

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

  const translateAndSpeak = useCallback(
    async (text: string, from: Language, to: Language, autoPlay = false) => {
      if (!text.trim()) return "";
      setIsTranslating(true);
      try {
        const result = await translateText(text.trim(), from.name, to.name);
        setIsTranslating(false);
        if (autoPlay && result) {
          playTranslation(result).catch((e) =>
            toast({ variant: "destructive", title: "Playback error", description: e.message })
          );
        }
        return result;
      } catch (e: any) {
        setIsTranslating(false);
        toast({ variant: "destructive", title: "Translation error", description: e.message });
        return "";
      }
    },
    []
  );

  const addEntry = useCallback(
    (original: string, translated: string, from: Language, to: Language, speaker = "You") => {
      const entry: ConversationEntry = {
        id: crypto.randomUUID(),
        speaker,
        original,
        translated,
        fromFlag: from.flag,
        toFlag: to.flag,
      };
      setEntries((prev) => [...prev, entry]);
    },
    []
  );

  // Finalize the active block → move to entries (only called when monitor stops)
  // TTS is disabled in monitor mode — visual subtitles only
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
    setActiveMessage(null);
  }, [addEntry]);

  const handleRecord = useCallback(() => {
    haptic();
    if (isRecording) {
      isRecordingRef.current = false;
      recorderRef.current?.stop();
      recorderRef.current = null;
      setIsRecording(false);

      const text = finalTextRef.current;
      if (text.trim()) {
        translateAndSpeak(text, fromLang, toLang).then((translated) => {
          if (translated) {
            setTranslationText(translated);
            addEntry(text, translated, fromLang, toLang, "You");
          }
        });
      }
    } else {
      finalTextRef.current = "";
      setSpeechText("");
      setTranslationText("");
      isRecordingRef.current = true;

      const rec = new DeepgramTranscriber(
        fromLang.speechCode,
        (text, isFinal) => {
          if (isFinal) {
            finalTextRef.current += text + " ";
            setSpeechText(finalTextRef.current.trim());
          } else {
            setSpeechText((finalTextRef.current + text).trim());
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
  }, [isRecording, fromLang, toLang, translateAndSpeak, addEntry]);

  const handlePlay = useCallback(async () => {
    if (!translationText) return;
    haptic();
    setIsPlaying(true);
    try {
      await playTranslation(translationText);
    } catch (e: any) {
      toast({ variant: "destructive", title: "Playback error", description: e.message });
    } finally {
      setIsPlaying(false);
    }
  }, [translationText]);

  const handleClear = useCallback(() => {
    haptic();
    setSpeechText("");
    setTranslationText("");
    finalTextRef.current = "";
  }, []);

  const handleSwapLangs = useCallback(() => {
    setFromLang(toLang);
    setToLang(fromLang);
    if (recorderRef.current) recorderRef.current.setLang(toLang.speechCode);
    if (monitorRef.current) monitorRef.current.setLang(toLang.speechCode);
  }, [fromLang, toLang]);

  const handleMonitorToggle = useCallback(
    async (checked: boolean) => {
      haptic();
      setIsMonitoring(checked);
      if (checked) {
        // Start fresh — single active block for entire session
        activeFinalRef.current = "";
        activeTranslatedRef.current = "";
        setActiveMessage(null);

        const monitor = new DeepgramTranscriber(
          toLang.speechCode,
          (text, isFinal) => {
            if (isFinal) {
              // Append finalized segment to the single active block
              activeFinalRef.current += text + " ";
              const finalSoFar = activeFinalRef.current.trim();

              // Update active message immediately with original text
              setActiveMessage({
                original: finalSoFar,
                interimSuffix: "",
                translated: activeTranslatedRef.current,
                interimTranslation: "",
                sourceFlag: toLangRef.current.flag,
                targetFlag: fromLangRef.current.flag,
              });

              // Segmented translation: only translate the NEW segment, then append
              translateText(text.trim(), toLangRef.current.name, fromLangRef.current.name)
                .then((segmentTranslation) => {
                  activeTranslatedRef.current = (activeTranslatedRef.current + " " + segmentTranslation).trim();
                  setActiveMessage((prev) =>
                    prev ? { ...prev, translated: activeTranslatedRef.current, interimTranslation: "" } : null
                  );
                })
                .catch(() => {});
            } else {
              // Interim: show partial text immediately
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
            }
          },
          undefined,
          (error) => {
            toast({ variant: "destructive", title: "Monitor error", description: error });
            setIsMonitoring(false);
          }
        );

        monitorRef.current = monitor;
        monitor.start();
      } else {
        // Stop — finalize remaining active block into entries (await translation)
        monitorRef.current?.stop();
        monitorRef.current = null;
        await finalizeActiveBlock();
      }
    },
    [fromLang, toLang, finalizeActiveBlock]
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
