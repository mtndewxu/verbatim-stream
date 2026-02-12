import { useEffect, useRef } from "react";
import { toast } from "@/hooks/use-toast";

/**
 * Shows a toast if Monitor is on but no speech arrives for 30 seconds.
 * Reset the timer every time `lastSpeechTime` updates.
 */
export function useSilenceDetector(
  isMonitoring: boolean,
  lastSpeechTimestamp: number
) {
  const shownRef = useRef(false);

  useEffect(() => {
    if (!isMonitoring) {
      shownRef.current = false;
      return;
    }

    // Reset shown flag when new speech arrives
    shownRef.current = false;

    const timer = setTimeout(() => {
      if (isMonitoring && !shownRef.current) {
        shownRef.current = true;
        toast({
          title: "No speech detected",
          description:
            "Consider turning off Monitor to save battery.",
        });
      }
    }, 30_000);

    return () => clearTimeout(timer);
  }, [isMonitoring, lastSpeechTimestamp]);
}
