const TRANSLATE_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/translate`;

/**
 * Translate text with optional AbortSignal support.
 * Pass a signal from AbortController to cancel stale requests.
 */
export async function translateText(
  text: string,
  fromLang: string,
  toLang: string,
  signal?: AbortSignal
): Promise<string> {
  const resp = await fetch(TRANSLATE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
    },
    body: JSON.stringify({ text, fromLang, toLang }),
    signal,
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Translation failed: ${err}`);
  }

  const data = await resp.json();
  return data.translation;
}
