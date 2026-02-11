import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const DEEPGRAM_API_KEY = Deno.env.get("DEEPGRAM_API_KEY");
    if (!DEEPGRAM_API_KEY) {
      throw new Error("DEEPGRAM_API_KEY not configured");
    }

    // Use Deepgram's temporary key API for better security
    // This creates a short-lived key scoped to listen only
    const resp = await fetch("https://api.deepgram.com/v1/projects", {
      headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
    });

    if (!resp.ok) {
      console.error("Deepgram projects error:", resp.status, await resp.text());
      // Fallback: return the main key if projects API fails
      return new Response(
        JSON.stringify({ key: DEEPGRAM_API_KEY }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const projects = await resp.json();
    const projectId = projects.projects?.[0]?.project_id;

    if (!projectId) {
      console.log("No project found, returning main key");
      return new Response(
        JSON.stringify({ key: DEEPGRAM_API_KEY }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create a temporary key valid for 60 seconds
    const keyResp = await fetch(
      `https://api.deepgram.com/v1/projects/${projectId}/keys`,
      {
        method: "POST",
        headers: {
          Authorization: `Token ${DEEPGRAM_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          comment: "Temporary browser key",
          scopes: ["usage:write"],
          time_to_live_in_seconds: 60,
        }),
      }
    );

    if (!keyResp.ok) {
      console.error("Deepgram temp key error:", keyResp.status, await keyResp.text());
      return new Response(
        JSON.stringify({ key: DEEPGRAM_API_KEY }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const keyData = await keyResp.json();
    console.log("Temporary Deepgram key created, TTL: 60s");

    return new Response(
      JSON.stringify({ key: keyData.key }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("deepgram-token error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
