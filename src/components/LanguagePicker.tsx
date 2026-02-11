import { ArrowLeftRight } from "lucide-react";
import { LANGUAGES, type Language } from "@/lib/languages";

interface LanguagePickerProps {
  from: Language;
  to: Language;
  onFromChange: (lang: Language) => void;
  onToChange: (lang: Language) => void;
  onSwap: () => void;
}

export function LanguagePicker({ from, to, onFromChange, onToChange, onSwap }: LanguagePickerProps) {
  return (
    <div className="flex items-center justify-center gap-2">
      <select
        value={from.code}
        onChange={(e) => {
          const lang = LANGUAGES.find((l) => l.code === e.target.value)!;
          onFromChange(lang);
        }}
        className="appearance-none bg-secondary text-secondary-foreground rounded-full px-3 py-1.5 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-ring cursor-pointer"
      >
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.flag} {l.code.toUpperCase()}
          </option>
        ))}
      </select>

      <button
        onClick={onSwap}
        className="p-1.5 rounded-full hover:bg-secondary transition-colors"
        aria-label="Swap languages"
      >
        <ArrowLeftRight className="w-4 h-4 text-muted-foreground" />
      </button>

      <select
        value={to.code}
        onChange={(e) => {
          const lang = LANGUAGES.find((l) => l.code === e.target.value)!;
          onToChange(lang);
        }}
        className="appearance-none bg-secondary text-secondary-foreground rounded-full px-3 py-1.5 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-ring cursor-pointer"
      >
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.flag} {l.code.toUpperCase()}
          </option>
        ))}
      </select>
    </div>
  );
}
