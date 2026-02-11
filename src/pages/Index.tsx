import { useState, useCallback, useRef } from "react";
import { Switch } from "@/components/ui/switch";
import { MonitorSection, type ConversationEntry } from "@/components/MonitorSection";
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
  const [monitorInterim, setMonitorInterim] = useState("");
  const [monitorInterimTranslation, setMonitorInterimTranslation] = useState("");

  const monitorRef = useRef<DeepgramTranscriber | null>(null);
  const recorderRef = useRef<DeepgramTranscriber | null>(null);
  const finalTextRef = useRef("");
  const isRecordingRef = useRef(false);
  const interimTranslateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastInterimTranslated = useRef("");

  const haptic = () => {
    if (navigator.vibrate) navigator.vibrate(10);
  };

  // Parallelized translate + auto-play pipeline
  const translateAndSpeak = useCallback(
    async (text: string, from: Language, to: Language, autoPlay = false) => {
      if (!text.trim()) return "";
      setIsTranslating(true);
      try {
        const result = await translateText(text.trim(), from.name, to.name);
        setIsTranslating(false);

        // Start TTS in parallel as soon as translation is ready
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

  const handleRecord = useCallback(() => {
    haptic();
    if (isRecording) {
      // Stop recording
      isRecordingRef.current = false;
      recorderRef.current?.stop();
      recorderRef.current = null;
      setIsRecording(false);

      // Translate final text
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
      // Start recording
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
    if (recorderRef.current) {
      recorderRef.current.setLang(toLang.speechCode);
    }
    if (monitorRef.current) {
      monitorRef.current.setLang(toLang.speechCode);
    }
  }, [fromLang, toLang]);

  const handleMonitorToggle = useCallback(
    (checked: boolean) => {
      haptic();
      setIsMonitoring(checked);
      if (checked) {
        let monitorBuffer = "";
        let interimAccum = "";

        const monitor = new DeepgramTranscriber(
          fromLang.speechCode,
          (text, isFinal) => {
            if (isFinal) {
              monitorBuffer += text + " ";
              const captured = monitorBuffer.trim();
              monitorBuffer = "";
              interimAccum = "";

              // Clear interim display
              setMonitorInterim("");
              setMonitorInterimTranslation("");
              lastInterimTranslated.current = "";
              if (interimTranslateTimer.current) {
                clearTimeout(interimTranslateTimer.current);
                interimTranslateTimer.current = null;
              }

              // Fire final translation immediately
              translateAndSpeak(captured, fromLang, toLang).then((translated) => {
                if (translated) {
                  addEntry(captured, translated, fromLang, toLang, "Speaker");
                }
              });
            } else {
              // Show interim text dimmed
              interimAccum = (monitorBuffer + text).trim();
              setMonitorInterim(interimAccum);

              // Debounce early translation of interim text (300ms idle)
              if (interimTranslateTimer.current) {
                clearTimeout(interimTranslateTimer.current);
              }
              const segmentToTranslate = interimAccum;
              if (segmentToTranslate.length > 5 && segmentToTranslate !== lastInterimTranslated.current) {
                interimTranslateTimer.current = setTimeout(() => {
                  lastInterimTranslated.current = segmentToTranslate;
                  translateText(segmentToTranslate, fromLang.name, toLang.name)
                    .then((t) => setMonitorInterimTranslation(t))
                    .catch(() => {});
                }, 300);
              }
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
        monitorRef.current?.stop();
        monitorRef.current = null;
        setMonitorInterim("");
        setMonitorInterimTranslation("");
        if (interimTranslateTimer.current) {
          clearTimeout(interimTranslateTimer.current);
          interimTranslateTimer.current = null;
        }
      }
    },
    [fromLang, toLang, translateAndSpeak, addEntry]
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

      {/* Monitor (top ~60%) */}
      <MonitorSection entries={entries} isMonitoring={isMonitoring} interimText={monitorInterim} interimTranslation={monitorInterimTranslation} />

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
