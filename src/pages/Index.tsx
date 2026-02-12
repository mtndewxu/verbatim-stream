import { useState, useCallback, useRef } from "react";
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

  // Monitor active message (incoming — left-aligned)
  const [activeMessage, setActiveMessage] = useState<{
    original: string;
    interimSuffix: string;
    translated: string;
    interimTranslation: string;
  } | null>(null);

  // Console active message (outgoing — right-aligned, real-time)
  const [activeConsoleMessage, setActiveConsoleMessage] = useState<{
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

  // Console refs for real-time tracking
  const consoleFinalRef = useRef("");
  const consoleTranslatedRef = useRef("");

  const fromLangRef = useRef(fromLang);
  const toLangRef = useRef(toLang);
  fromLangRef.current = fromLang;
  toLangRef.current = toLang;

  const theme = useDynamicTheme();
  useSilenceDetector(isMonitoring, lastSpeechTs);

  const haptic = () => {
    if (navigator.vibrate) navigator.vibrate(10);
  };

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
      addEntry(text, translated, toLangRef.current, fromLangRef.current, "Speaker");
    }
    activeFinalRef.current = "";
    activeTranslatedRef.current = "";
    setActiveMessage(null);
  }, [addEntry]);

  // ─── Speaker (Console) recording ─────────────────────────────
  const handleRecord = useCallback(() => {
    haptic();
    if (isRecording) {
      // STOP recording
      isRecordingRef.current = false;
      recorderRef.current?.stop();
      recorderRef.current = null;
      setIsRecording(false);

      // Finalize: archive console active message into entries
      const text = consoleFinalRef.current.trim();
      const alreadyTranslated = consoleTranslatedRef.current.trim();
      setActiveConsoleMessage(null);

      if (text) {
        if (alreadyTranslated) {
          // We already have translations from isFinal segments
          addEntry(text, alreadyTranslated, fromLangRef.current, toLangRef.current, "You");
          setTranslationText(alreadyTranslated);
        } else {
          // Fallback: translate everything now
          setIsTranslating(true);
          translateText(text, fromLangRef.current.name, toLangRef.current.name)
            .then((result) => {
              setTranslationText(result);
              addEntry(text, result, fromLangRef.current, toLangRef.current, "You");
            })
            .catch((e) => toast({ variant: "destructive", title: "Translation error", description: e.message }))
            .finally(() => setIsTranslating(false));
        }
        setSpeechText(text);
      }

      consoleFinalRef.current = "";
      consoleTranslatedRef.current = "";
    } else {
      // START recording
      consoleFinalRef.current = "";
      consoleTranslatedRef.current = "";
      finalTextRef.current = "";
      setSpeechText("");
      setTranslationText("");
      isRecordingRef.current = true;

      // Show empty active bubble immediately
      setActiveConsoleMessage({ original: "", interimSuffix: "", translated: "", interimTranslation: "" });

      const rec = new DeepgramTranscriber(
        fromLangRef.current.speechCode,
        (text, isFinal) => {
          if (isFinal) {
            // Fast-track: append final text instantly
            consoleFinalRef.current += text + " ";
            const finalSoFar = consoleFinalRef.current.trim();
            setSpeechText(finalSoFar);

            setActiveConsoleMessage((prev) => ({
              original: finalSoFar,
              interimSuffix: "",
              translated: prev?.translated || consoleTranslatedRef.current,
              interimTranslation: "",
            }));

            // Slow-track: translate this segment
            translateText(text.trim(), fromLangRef.current.name, toLangRef.current.name)
              .then((segmentTranslation) => {
                consoleTranslatedRef.current = (consoleTranslatedRef.current + " " + segmentTranslation).trim();
                const t = consoleTranslatedRef.current;
                setTranslationText(t);
                setActiveConsoleMessage((prev) =>
                  prev ? { ...prev, translated: t } : null
                );
              })
              .catch(() => {});
          } else {
            // Fast-track: show interim ghost text immediately
            const currentFinal = consoleFinalRef.current.trim();
            setSpeechText((currentFinal + " " + text).trim());

            setActiveConsoleMessage((prev) => ({
              original: currentFinal,
              interimSuffix: " " + text,
              translated: prev?.translated || consoleTranslatedRef.current,
              interimTranslation: "",
            }));
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
  }, [isRecording, addEntry]);

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
    consoleFinalRef.current = "";
    consoleTranslatedRef.current = "";
  }, []);

  const handleSwapLangs = useCallback(() => {
    setFromLang(toLang);
    setToLang(fromLang);
    if (recorderRef.current) recorderRef.current.setLang(toLang.speechCode);
    if (monitorRef.current) monitorRef.current.setLang(fromLang.speechCode);
  }, [fromLang, toLang]);

  // ─── Monitor toggle ──────────────────────────────────────────
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

              translateText(text.trim(), toLangRef.current.name, fromLangRef.current.name)
                .then((segmentTranslation) => {
                  activeTranslatedRef.current = (activeTranslatedRef.current + " " + segmentTranslation).trim();
                  setActiveMessage((prev) =>
                    prev ? { ...prev, translated: activeTranslatedRef.current } : null
                  );
                })
                .catch(() => {});
            } else {
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
    [toLang, finalizeActiveBlock]
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

      {/* Guide card */}
      <div className="px-5 py-2">
        <div className="rounded-2xl px-4 py-3 text-[11px] leading-relaxed text-muted-foreground bg-card/40 backdrop-blur-md border border-border/30">
          <span className="font-semibold text-foreground/70">Incoming:</span> Enable Monitor to translate the other party. Turn off after the session.{" "}
          <span className="font-semibold text-foreground/70">Outgoing:</span> Tap Speaker for your turn; use the Loudspeaker icon for playback.
        </div>
      </div>

      {/* Conversation area — universal for both Monitor & Console */}
      <MonitorSection
        entries={entries}
        isMonitoring={isMonitoring}
        activeMessage={activeMessage}
        activeConsoleMessage={activeConsoleMessage}
      />

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
