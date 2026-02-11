import { useState, useCallback, useRef } from "react";
import { Switch } from "@/components/ui/switch";
import { MonitorSection, type ConversationEntry } from "@/components/MonitorSection";
import { ConsoleSection } from "@/components/ConsoleSection";
import { SpeechRecognizer } from "@/lib/speech";
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

  const recognizerRef = useRef<SpeechRecognizer | null>(null);
  const monitorRef = useRef<SpeechRecognizer | null>(null);
  const finalTextRef = useRef("");

  const haptic = () => {
    if (navigator.vibrate) navigator.vibrate(10);
  };

  const doTranslate = useCallback(
    async (text: string, from: Language, to: Language) => {
      if (!text.trim()) return "";
      setIsTranslating(true);
      try {
        const result = await translateText(text.trim(), from.name, to.name);
        return result;
      } catch (e: any) {
        toast({ variant: "destructive", title: "Translation error", description: e.message });
        return "";
      } finally {
        setIsTranslating(false);
      }
    },
    []
  );

  const addEntry = useCallback(
    (original: string, translated: string, from: Language, to: Language) => {
      const entry: ConversationEntry = {
        id: crypto.randomUUID(),
        speaker: "You",
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
      recognizerRef.current?.stop();
      recognizerRef.current = null;
      setIsRecording(false);

      // Translate final text
      const text = finalTextRef.current;
      if (text.trim()) {
        doTranslate(text, fromLang, toLang).then((translated) => {
          if (translated) {
            setTranslationText(translated);
            addEntry(text, translated, fromLang, toLang);
          }
        });
      }
    } else {
      // Start recording
      finalTextRef.current = "";
      setSpeechText("");
      setTranslationText("");

      const rec = new SpeechRecognizer(
        fromLang.speechCode,
        (text, isFinal) => {
          if (isFinal) {
            finalTextRef.current += text;
            setSpeechText(finalTextRef.current);
          } else {
            setSpeechText(finalTextRef.current + text);
          }
        },
        () => setIsRecording(false)
      );

      if (!rec.supported) {
        toast({
          variant: "destructive",
          title: "Not supported",
          description: "Speech recognition is not supported in this browser.",
        });
        return;
      }

      recognizerRef.current = rec;
      rec.start();
      setIsRecording(true);
    }
  }, [isRecording, fromLang, toLang, doTranslate, addEntry]);

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
    if (recognizerRef.current) {
      recognizerRef.current.setLang(toLang.speechCode);
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
        const monitor = new SpeechRecognizer(
          fromLang.speechCode,
          (text, isFinal) => {
            if (isFinal) {
              monitorBuffer += text;
              const captured = monitorBuffer;
              monitorBuffer = "";
              doTranslate(captured, fromLang, toLang).then((translated) => {
                if (translated) {
                  const entry: ConversationEntry = {
                    id: crypto.randomUUID(),
                    speaker: "Speaker",
                    original: captured,
                    translated,
                    fromFlag: fromLang.flag,
                    toFlag: toLang.flag,
                  };
                  setEntries((prev) => [...prev, entry]);
                }
              });
            }
          }
        );

        if (!monitor.supported) {
          toast({
            variant: "destructive",
            title: "Not supported",
            description: "Speech recognition is not supported in this browser.",
          });
          setIsMonitoring(false);
          return;
        }

        monitorRef.current = monitor;
        monitor.start();
      } else {
        monitorRef.current?.stop();
        monitorRef.current = null;
      }
    },
    [fromLang, toLang, doTranslate, addEntry]
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
      <MonitorSection entries={entries} isMonitoring={isMonitoring} />

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
