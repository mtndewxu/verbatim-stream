import { useEffect, useRef } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";

export interface ConversationEntry {
  id: string;
  speaker: string;
  original: string;
  translated: string;
  fromFlag: string;
  toFlag: string;
}

interface MonitorSectionProps {
  entries: ConversationEntry[];
  isMonitoring: boolean;
  interimText?: string;
  interimTranslation?: string;
}

export function MonitorSection({ entries, isMonitoring, interimText, interimTranslation }: MonitorSectionProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries, interimText, interimTranslation]);

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
          </div>
        )}
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1">
        <div className="px-5 py-3 space-y-3">
          {entries.length === 0 && !interimText && (
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

          {/* Interim (partial) transcript — dimmed */}
          {interimText && (
            <div className="bg-card/50 rounded-2xl px-4 py-3 border border-border/50 opacity-60">
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">
                Speaker <span className="text-[9px] italic font-normal">(listening…)</span>
              </div>
              <p className="text-sm text-muted-foreground italic leading-relaxed">
                {interimText}
              </p>
              {interimTranslation && (
                <p className="text-sm text-primary/50 italic leading-relaxed mt-1">
                  → {interimTranslation}
                </p>
              )}
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </ScrollArea>
    </div>
  );
}
