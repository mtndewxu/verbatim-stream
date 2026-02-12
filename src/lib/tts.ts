const TTS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/elevenlabs-tts`;

let currentAudio: HTMLAudioElement | null = null;
let currentAudioUrl: string | null = null;
let onEndCallback: (() => void) | null = null;

/** Returns true if audio is now playing, false if it was stopped. */
export async function playTranslation(text: string, onEnd?: () => void): Promise<boolean> {
  // Toggle off if already playing
  if (currentAudio && !currentAudio.paused) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
    cleanup();
    return false;
  }

  const response = await fetch(TTS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
    },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    throw new Error(`TTS failed: ${response.status}`);
  }

  const audioBlob = await response.blob();
  const audioUrl = URL.createObjectURL(audioBlob);
  const audio = new Audio(audioUrl);

  currentAudio = audio;
  currentAudioUrl = audioUrl;
  onEndCallback = onEnd || null;

  audio.onended = cleanup;
  audio.onerror = cleanup;

  await audio.play();
  return true;
}

function cleanup() {
  if (currentAudioUrl) {
    URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = null;
  }
  currentAudio = null;
  const cb = onEndCallback;
  onEndCallback = null;
  cb?.();
}

export function isAudioPlaying(): boolean {
  return currentAudio !== null && !currentAudio.paused;
}
