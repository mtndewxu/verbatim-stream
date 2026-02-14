const REFINE_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/refine-translation`;

export async function refineTranslations(
  sentences: string[],
  fromLang: string,
  toLang: string,
  previousContext?: string
): Promise<string[]> {
  const resp = await fetch(REFINE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
    },
    body: JSON.stringify({ sentences, fromLang, toLang, previousContext }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Refinement failed: ${err}`);
  }

  const data = await resp.json();
  return data.refinements;
}
