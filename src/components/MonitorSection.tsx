import { useLayoutEffect, useRef, useState } from "react";
import { Volume2 } from "lucide-react";
import { playTranslation } from "@/lib/tts";

export interface ConversationEntry {
  id: string;
  speaker: string;
  original: string;
  translated: string;
  fromFlag: string;
  toFlag: string;
  refined?: boolean;
}

export interface ActiveMessage {
  original: string;
  interimSuffix: string;
  translated: string;
  interimTranslation: string;
  sourceFlag: string;
  targetFlag: string;
}

interface MonitorSectionProps {
  entries: ConversationEntry[];
  isMonitoring: boolean;
  activeMessage?: ActiveMessage | null;
}

function AudioWaveVisualizer() {
  return (
    <div className="flex items-center gap-[2px] h-3 ml-2">
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className="w-[3px] rounded-full bg-destructive"
          style={{
            animation: `audioWave 1.2s ease-in-out ${i * 0.15}s infinite`,
          }}
        />
      ))}
      <style>{`
        @keyframes audioWave {
          0%, 100% { height: 4px; opacity: 0.4; }
          50% { height: 12px; opacity: 1; }
        }
      `}</style>
    </div>
  );
}

export function MonitorSection({ entries, isMonitoring, activeMessage }: MonitorSectionProps) {
  const scrollAnchor = useRef<HTMLDivElement>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);

  const handlePlay = async (id: string, text: string) => {
    if (playingId && playingId !== id) return;
    if (playingId === id) {
      await playTranslation(text);
      setPlayingId(null);
      return;
    }
    setPlayingId(id);
    try {
      const started = await playTranslation(text, () => setPlayingId(null));
      if (!started) setPlayingId(null);
    } catch {
      setPlayingId(null);
    }
  };

  useLayoutEffect(() => {
    scrollAnchor.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries, activeMessage?.original, activeMessage?.interimSuffix, activeMessage?.translated, activeMessage?.interimTranslation]);

  return (
    <div className="flex-1 min-h-0 flex flex-col px-5 py-3 gap-2">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Conversation
        </h2>
        {isMonitoring && (
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-destructive animate-pulse" />
            <span className="text-[10px] font-medium text-destructive uppercase tracking-wider">
              Live
            </span>
            <AudioWaveVisualizer />
          </div>
        )}
      </div>

      {/* Messages — bordered container matching textareas */}
      <div className="flex-1 min-h-0 overflow-y-auto bg-secondary/50 border border-border rounded-xl">
        <div className="flex flex-col px-3 py-2 gap-3">
          {entries.length === 0 && !activeMessage && (
            <div className="flex items-center justify-center h-32">
              <p className="text-sm text-muted-foreground">
                Start speaking to see translations here
              </p>
            </div>
          )}
          {entries.map((entry) => (
            <div
              key={entry.id}
              className="bg-card rounded-2xl px-4 py-3 shadow-sm border border-border"
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  {entry.speaker}
                </span>
                {entry.translated && (
                  <button
                    onClick={() => handlePlay(entry.id, entry.translated)}
                    disabled={playingId !== null && playingId !== entry.id}
                    className="p-1 rounded-full hover:bg-secondary transition-colors disabled:opacity-40"
                    aria-label={playingId === entry.id ? "Stop playback" : "Play translation"}
                  >
                    <Volume2 className={`w-3.5 h-3.5 ${playingId === entry.id ? "text-destructive animate-pulse" : "text-muted-foreground"}`} />
                  </button>
                )}
              </div>
              <p className="text-sm text-foreground leading-relaxed">
                {entry.fromFlag} {entry.original}
              </p>
              <p className={`text-sm font-semibold leading-relaxed mt-1 transition-colors duration-700 ${entry.refined ? "text-primary" : "text-muted-foreground"}`}>
                → {entry.toFlag} {entry.translated}
              </p>
            </div>
          ))}

          {/* Active (in-progress) message block */}
          {activeMessage && (activeMessage.original || activeMessage.interimSuffix) && (
            <div className="bg-card rounded-2xl px-4 py-3 shadow-sm border border-border border-l-2 border-l-destructive">
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1">
                Speaker
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-destructive animate-pulse" />
              </div>
              <p className="text-sm leading-relaxed">
                <span className="text-foreground">{activeMessage.sourceFlag} {activeMessage.original}</span>
                {activeMessage.interimSuffix && (
                  <span className="text-muted-foreground/50 italic opacity-50 transition-opacity duration-300">{activeMessage.interimSuffix}</span>
                )}
              </p>
              {(activeMessage.translated || activeMessage.interimTranslation) && (
                <p className="text-sm leading-relaxed mt-1">
                  <span className="font-semibold text-primary transition-all duration-500 ease-in-out">→ {activeMessage.targetFlag} {activeMessage.translated}</span>
                  {activeMessage.interimTranslation && (
                    <span className="text-primary/40 italic opacity-50 transition-opacity duration-300"> {activeMessage.interimTranslation}</span>
                  )}
                </p>
              )}
            </div>
          )}

          {/* Scroll anchor */}
          <div ref={scrollAnchor} />
        </div>
      </div>
    </div>
  );
}
