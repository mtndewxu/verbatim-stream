import { useState, useCallback } from "react";

export type AppThemeState = "default" | "monitoring" | "recording";

export interface MorandiPalette {
  label: string;
  color: string;
}

export const MORANDI_PRESETS: MorandiPalette[] = [
  { label: "Glacier Blue", color: "#F0F4F8" },
  { label: "Soft Sage", color: "#F1F3F0" },
  { label: "Muted Linen", color: "#F7F3F0" },
  { label: "Mist Gray", color: "#F1F3F5" },
];

export function useDynamicTheme() {
  const [selectedIndex, setSelectedIndex] = useState(2); // default: Muted Linen

  const background = MORANDI_PRESETS[selectedIndex].color;
  const currentPreset = MORANDI_PRESETS[selectedIndex];

  const selectPreset = useCallback((index: number) => {
    setSelectedIndex(index);
  }, []);

  return {
    background,
    currentPreset,
    selectedIndex,
    selectPreset,
    presets: MORANDI_PRESETS,
  };
}
