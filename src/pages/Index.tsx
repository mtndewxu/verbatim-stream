import { useState, useCallback, useRef, useEffect } from "react";
import { Switch } from "@/components/ui/switch";
import { Palette, Check } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MonitorSection, type ConversationEntry } from "@/components/MonitorSection";
import { ConsoleSection } from "@/components/ConsoleSection";
import { DeepgramTranscriber } from "@/lib/deepgram";
import { translateText } from "@/lib/translate";
import { playTranslation } from "@/lib/tts";
import { getLanguage, type Language } from "@/lib/languages";
import { toast } from "@/hooks/use-toast";
import { useDynamicTheme } from "@/hooks/use-dynamic-theme";
import { useSilenceDetector } from "@/hooks/use-silence-detector";

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
  const [lastSpeechTs, setLastSpeechTs] = useState(Date.now());

  const [activeMessage, setActiveMessage] = useState<{
    original: string;
    interimSuffix: string;
    translated: string;
    interimTranslation: string;
  } | null>(null);

  const monitorRef = useRef<DeepgramTranscriber | null>(null);
  const recorderRef = useRef<DeepgramTranscriber | null>(null);
  const finalTextRef = useRef("");
  const isRecordingRef = useRef(false);

  const activeFinalRef = useRef("");
  const activeTranslatedRef = useRef("");
  const fromLangRef = useRef(fromLang);
  const toLangRef = useRef(toLang);

  fromLangRef.current = fromLang;
  toLangRef.current = toLang;

  // Dynamic theming
  const theme = useDynamicTheme();

  // Silence detector
  useSilenceDetector(isMonitoring, lastSpeechTs);

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

  const finalizeActiveBlock = useCallback(() => {
    const text = activeFinalRef.current.trim();
    const translated = activeTranslatedRef.current.trim();
    if (text) {
      addEntry(text, translated, fromLangRef.current, toLangRef.current, "Speaker");
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
    (checked: boolean) => {
      haptic();
      setIsMonitoring(checked);
      if (checked) {
        activeFinalRef.current = "";
        activeTranslatedRef.current = "";
        setActiveMessage(null);
        setLastSpeechTs(Date.now());

        const monitor = new DeepgramTranscriber(
          toLang.speechCode,
          (text, isFinal) => {
            setLastSpeechTs(Date.now());
            if (isFinal) {
              activeFinalRef.current += text + " ";
              const finalSoFar = activeFinalRef.current.trim();

              setActiveMessage({
                original: finalSoFar,
                interimSuffix: "",
                translated: activeTranslatedRef.current,
                interimTranslation: "",
              });

              // Deferred translation — only on isFinal
              translateText(text.trim(), toLangRef.current.name, fromLangRef.current.name)
                .then((segmentTranslation) => {
                  activeTranslatedRef.current = (activeTranslatedRef.current + " " + segmentTranslation).trim();
                  setActiveMessage((prev) =>
                    prev ? { ...prev, translated: activeTranslatedRef.current, interimTranslation: "" } : null
                  );
                })
                .catch(() => {});
            } else {
              // Instant ghost text for interim
              const currentFinal = activeFinalRef.current.trim();
              setActiveMessage({
                original: currentFinal,
                interimSuffix: " " + text,
                translated: activeTranslatedRef.current,
                interimTranslation: "",
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
        finalizeActiveBlock();
        monitorRef.current?.stop();
        monitorRef.current = null;
      }
    },
    [fromLang, toLang, finalizeActiveBlock]
  );

  return (
    <div
      className="h-screen flex flex-col overflow-hidden"
      style={{ backgroundColor: theme.background }}
    >
      {/* Top bar */}
      <header className="flex items-center justify-between px-5 py-3 border-b border-border/40 bg-card/60 backdrop-blur-xl">
        <h1 className="text-base font-semibold text-foreground tracking-tight">Translator</h1>
        <div className="flex items-center gap-3">
          {/* Palette dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="w-8 h-8 rounded-full flex items-center justify-center bg-secondary/60 text-muted-foreground hover:text-foreground transition-all active:scale-90"
                aria-label="Change theme"
              >
                <Palette className="w-4 h-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[180px]">
              {theme.presets.map((preset, i) => (
                <DropdownMenuItem
                  key={preset.label}
                  onClick={() => theme.selectPreset(i)}
                  className="flex items-center gap-3 cursor-pointer"
                >
                  <span
                    className="w-4 h-4 rounded-full border border-border/60 shrink-0"
                    style={{ backgroundColor: preset.color }}
                  />
                  <span className="text-sm">{preset.label}</span>
                  {theme.selectedIndex === i && (
                    <Check className="w-3.5 h-3.5 ml-auto text-primary" />
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="flex items-center gap-2">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Monitor
            </span>
            <Switch checked={isMonitoring} onCheckedChange={handleMonitorToggle} />
          </div>
        </div>
      </header>

      {/* Guide card — ABOVE conversation */}
      <div className="px-5 py-2">
        <div className="rounded-2xl px-4 py-3 text-[11px] leading-relaxed text-muted-foreground bg-card/40 backdrop-blur-md border border-border/30">
          <span className="font-semibold text-foreground/70">Incoming:</span> Enable Monitor to translate the other party. Turn off after the session.{" "}
          <span className="font-semibold text-foreground/70">Outgoing:</span> Tap Speaker for your turn; use the Loudspeaker icon for playback.
        </div>
      </div>

      {/* Monitor (conversation area) */}
      <MonitorSection entries={entries} isMonitoring={isMonitoring} activeMessage={activeMessage} />

      {/* Console (bottom) */}
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
