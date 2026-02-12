import { useLayoutEffect, useRef } from "react";

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
  activeConsoleMessage?: ActiveMessage | null;
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

function MessageBubble({
  entry,
  isYou,
}: {
  entry: ConversationEntry;
  isYou: boolean;
}) {
  return (
    <div className={`flex ${isYou ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-3 shadow-sm border ${
          isYou
            ? "bg-primary/10 border-primary/30 backdrop-blur-md"
            : "bg-card/70 border-border backdrop-blur-md"
        }`}
      >
        <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">
          {entry.speaker}
        </div>
        <p className="text-sm text-foreground leading-relaxed">
          {entry.fromFlag} {entry.original}
        </p>
        {entry.translated && (
          <p
            className={`text-sm font-semibold leading-relaxed mt-1 ${
              isYou ? "text-primary" : "text-primary"
            }`}
          >
            → {entry.toFlag} {entry.translated}
          </p>
        )}
      </div>
    </div>
  );
}

function ActiveBubble({
  msg,
  label,
  isYou,
}: {
  msg: ActiveMessage;
  label: string;
  isYou: boolean;
}) {
  if (!msg.original && !msg.interimSuffix) return null;
  return (
    <div className={`flex ${isYou ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-3 shadow-sm border border-l-2 ${
          isYou
            ? "bg-primary/10 border-primary/30 border-l-primary backdrop-blur-md"
            : "bg-card/70 border-border border-l-destructive backdrop-blur-md"
        }`}
      >
        <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1">
          {label}
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full animate-pulse ${
              isYou ? "bg-primary" : "bg-destructive"
            }`}
          />
        </div>
        <p className="text-sm leading-relaxed">
          <span className="text-foreground">{msg.original}</span>
          {msg.interimSuffix && (
            <span className="text-muted-foreground/50">{msg.interimSuffix}</span>
          )}
        </p>
        {(msg.translated || msg.interimTranslation) && (
          <p className="text-sm leading-relaxed mt-1">
            <span className="font-semibold text-primary">→ {msg.translated}</span>
            {msg.interimTranslation && (
              <span className="text-primary/40 italic"> {msg.interimTranslation}</span>
            )}
          </p>
        )}
      </div>
    </div>
  );
}

export function MonitorSection({
  entries,
  isMonitoring,
  activeMessage,
  activeConsoleMessage,
}: MonitorSectionProps) {
  const scrollAnchor = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    scrollAnchor.current?.scrollIntoView({ behavior: "smooth" });
  }, [
    entries,
    activeMessage?.original,
    activeMessage?.interimSuffix,
    activeMessage?.translated,
    activeConsoleMessage?.original,
    activeConsoleMessage?.interimSuffix,
    activeConsoleMessage?.translated,
  ]);

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-card/30 backdrop-blur-sm">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-border/30">
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

      {/* Messages — column-reverse pins latest content to bottom */}
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col-reverse">
        <div className="flex flex-col px-5 py-3 gap-3">
          {entries.length === 0 && !activeMessage && !activeConsoleMessage && (
            <div className="flex items-center justify-center h-32">
              <p className="text-sm text-muted-foreground">
                Start speaking to see translations here
              </p>
            </div>
          )}

          {/* Active console message (outgoing — pinned to top) */}
          {activeConsoleMessage && (
            <ActiveBubble msg={activeConsoleMessage} label="You" isYou={true} />
          )}

          {entries.map((entry) => (
            <MessageBubble
              key={entry.id}
              entry={entry}
              isYou={entry.speaker === "You"}
            />
          ))}

          {/* Active monitor message (incoming — left) */}
          {activeMessage && (
            <ActiveBubble msg={activeMessage} label="Speaker" isYou={false} />
          )}

          {/* Scroll anchor */}
          <div ref={scrollAnchor} />
        </div>
      </div>
    </div>
  );
}
