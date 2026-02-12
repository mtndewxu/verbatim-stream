import { useState, useCallback, useMemo } from "react";

export type AppThemeState = "default" | "monitoring" | "recording";

interface MorandiPalette {
  label: string;
  default: string;
  monitoring: string;
  recording: string;
}

export const MORANDI_PALETTES: MorandiPalette[] = [
  {
    label: "Linen",
    default: "#F7F3F0",
    monitoring: "#F0F4F8",
    recording: "#F1F3F0",
  },
  {
    label: "Blush",
    default: "#F5EFEE",
    monitoring: "#EEF2F7",
    recording: "#EFF2EE",
  },
  {
    label: "Dove",
    default: "#EFEEED",
    monitoring: "#E8EDF3",
    recording: "#ECF0EB",
  },
  {
    label: "Sand",
    default: "#F4F1EB",
    monitoring: "#EBF0F5",
    recording: "#EEF1EA",
  },
];

export function useDynamicTheme() {
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [lockedColor, setLockedColor] = useState<string | null>(null);

  const palette = MORANDI_PALETTES[paletteIndex];

  const getBackground = useCallback(
    (state: AppThemeState): string => {
      if (lockedColor) return lockedColor;
      return palette[state];
    },
    [palette, lockedColor]
  );

  const cyclePalette = useCallback(() => {
    if (lockedColor) {
      // Unlock
      setLockedColor(null);
    } else {
      setPaletteIndex((i) => (i + 1) % MORANDI_PALETTES.length);
    }
  }, [lockedColor]);

  const lockColor = useCallback((color: string) => {
    setLockedColor(color);
  }, []);

  const unlock = useCallback(() => {
    setLockedColor(null);
  }, []);

  return {
    palette,
    paletteIndex,
    lockedColor,
    getBackground,
    cyclePalette,
    lockColor,
    unlock,
    isLocked: !!lockedColor,
  };
}
