import { useEffect, useLayoutEffect, useRef } from "react";

export interface ConversationEntry {
  id: string;
  speaker: string;
  original: string;
  translated: string;
  fromFlag: string;
  toFlag: string;
}

interface ActiveMessage {
  original: string;
  interimSuffix: string;
  translated: string;
  interimTranslation: string;
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

  useLayoutEffect(() => {
    scrollAnchor.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries, activeMessage?.original, activeMessage?.interimSuffix, activeMessage?.translated, activeMessage?.interimTranslation]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-border">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
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

      {/* Messages — flex column with constrained overflow */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="flex flex-col px-5 py-3 gap-3">
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
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">
                {entry.speaker}
              </div>
              <p className="text-sm text-foreground leading-relaxed">
                {entry.fromFlag} {entry.original}
              </p>
              <p className="text-sm font-semibold text-primary leading-relaxed mt-1">
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
                <span className="text-foreground">{activeMessage.original}</span>
                {activeMessage.interimSuffix && (
                  <span className="text-muted-foreground/50">{activeMessage.interimSuffix}</span>
                )}
              </p>
              {(activeMessage.translated || activeMessage.interimTranslation) && (
                <p className="text-sm leading-relaxed mt-1">
                  <span className="font-semibold text-primary">→ {activeMessage.translated}</span>
                  {activeMessage.interimTranslation && (
                    <span className="text-primary/40 italic"> {activeMessage.interimTranslation}</span>
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
