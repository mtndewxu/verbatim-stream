import { Mic, Volume2, Trash2 } from "lucide-react";
import { LanguagePicker } from "./LanguagePicker";
import type { Language } from "@/lib/languages";

interface ConsoleSectionProps {
  speechText: string;
  translationText: string;
  translationSegments?: string[];
  isRecording: boolean;
  isPlaying: boolean;
  isTranslating: boolean;
  fromLang: Language;
  toLang: Language;
  isVcMode?: boolean;
  onSpeechChange: (text: string) => void;
  onRecord: () => void;
  onPlay: () => void;
  onClear: () => void;
  onFromChange: (lang: Language) => void;
  onToChange: (lang: Language) => void;
  onSwapLangs: () => void;
}

export function ConsoleSection({
  speechText,
  translationText,
  translationSegments = [],
  isRecording,
  isPlaying,
  isTranslating,
  fromLang,
  toLang,
  isVcMode = false,
  onSpeechChange,
  onRecord,
  onPlay,
  onClear,
  onFromChange,
  onToChange,
  onSwapLangs,
}: ConsoleSectionProps) {
  // For VC mode with segments, show segmented view
  const showSegments = isVcMode && translationSegments.length > 0;
  const displayTranslation = showSegments
    ? translationSegments.join("\n")
    : translationText;

  return (
    <div className="flex flex-col gap-3 px-5 pt-4 pb-6 bg-background">
      {/* My Speech */}
      <div>
        <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1 block">
          My Speech
        </label>
        <textarea
          value={speechText}
          onChange={(e) => onSpeechChange(e.target.value)}
          placeholder="Tap the mic to start speaking..."
          className="w-full bg-secondary/50 border border-border rounded-xl px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground resize-none focus:outline-none focus:ring-2 focus:ring-ring h-16"
        />
      </div>

      {/* Translation */}
      <div>
        <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1.5">
          Translation {isTranslating && <span className="text-primary">• translating...</span>}
        </label>
        <div className="w-full bg-secondary/50 border border-border rounded-xl px-3 py-2 text-sm text-foreground min-h-[4rem] max-h-24 overflow-y-auto">
          {showSegments ? (
            <div className="flex flex-col gap-1">
              {translationSegments.map((seg, i) => (
                <p
                  key={i}
                  className="transition-opacity duration-300"
                  style={{ opacity: i === translationSegments.length - 1 ? 1 : 0.5 }}
                >
                  {seg}
                </p>
              ))}
            </div>
          ) : (
            <p className={displayTranslation ? "" : "text-muted-foreground"}>
              {displayTranslation || "Translation will appear here"}
            </p>
          )}
        </div>
      </div>

      {/* Language Picker — hidden in VC mode, replaced with auto badge */}
      {isVcMode ? (
        <div className="flex items-center justify-center py-1.5">
          <span className="text-sm font-medium text-muted-foreground bg-muted px-4 py-1.5 rounded-full">
            🇨🇳 中 ↔ EN 🇬🇧 · Auto Detect
          </span>
        </div>
      ) : (
        <LanguagePicker
          from={fromLang}
          to={toLang}
          onFromChange={onFromChange}
          onToChange={onToChange}
          onSwap={onSwapLangs}
        />
      )}

      {/* Action Buttons */}
      <div className="flex items-center justify-center gap-8">
        {/* Clear */}
        <button
          onClick={onClear}
          className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center hover:bg-secondary/80 transition-colors active:scale-95"
          aria-label="Clear"
        >
          <Trash2 className="w-5 h-5 text-muted-foreground" />
        </button>

        {/* Record */}
        <div className="relative">
          {isRecording && (
            <span className="absolute inset-0 rounded-full bg-destructive/30 animate-pulse-ring" />
          )}
          <button
            onClick={onRecord}
            className={`relative z-10 w-16 h-16 rounded-full flex items-center justify-center transition-all active:scale-95 ${
              isRecording
                ? "bg-destructive text-destructive-foreground shadow-lg"
                : "bg-primary text-primary-foreground shadow-md"
            }`}
            aria-label={isRecording ? "Stop recording" : "Start recording"}
          >
            <Mic className="w-7 h-7" />
          </button>
        </div>

        {/* Play */}
        <button
          onClick={onPlay}
          disabled={!displayTranslation || isPlaying}
          className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center hover:bg-secondary/80 transition-colors active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label="Play translation"
        >
          <Volume2 className={`w-5 h-5 ${isPlaying ? "text-primary animate-pulse" : "text-muted-foreground"}`} />
        </button>
      </div>
    </div>
  );
}
