export interface Language {
  code: string;
  name: string;
  flag: string;
  speechCode: string; // BCP 47 for Web Speech API
}

export const LANGUAGES: Language[] = [
  { code: "en", name: "English", flag: "🇺🇸", speechCode: "en-US" },
  { code: "zh", name: "中文", flag: "🇨🇳", speechCode: "zh-CN" },
  { code: "ja", name: "日本語", flag: "🇯🇵", speechCode: "ja-JP" },
  { code: "ko", name: "한국어", flag: "🇰🇷", speechCode: "ko-KR" },
  { code: "es", name: "Español", flag: "🇪🇸", speechCode: "es-ES" },
  { code: "fr", name: "Français", flag: "🇫🇷", speechCode: "fr-FR" },
  { code: "de", name: "Deutsch", flag: "🇩🇪", speechCode: "de-DE" },
  { code: "pt", name: "Português", flag: "🇧🇷", speechCode: "pt-BR" },
  { code: "ru", name: "Русский", flag: "🇷🇺", speechCode: "ru-RU" },
  { code: "ar", name: "العربية", flag: "🇸🇦", speechCode: "ar-SA" },
];

export function getLanguage(code: string): Language {
  return LANGUAGES.find((l) => l.code === code) || LANGUAGES[0];
}
