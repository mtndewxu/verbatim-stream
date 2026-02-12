// @ts-nocheck — Deno edge function
import WS from "npm:ws";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const DEEPGRAM_API_KEY = Deno.env.get("DEEPGRAM_API_KEY");
  if (!DEEPGRAM_API_KEY) {
    return new Response(
      JSON.stringify({ error: "DEEPGRAM_API_KEY not configured" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Require WebSocket upgrade
  if ((req.headers.get("upgrade") || "").toLowerCase() !== "websocket") {
    return new Response(
      JSON.stringify({ error: "WebSocket upgrade required" }),
      { status: 426, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Parse query params for Deepgram config
  const url = new URL(req.url);
  const language = url.searchParams.get("language") || "en";

  const { socket: clientSocket, response } = Deno.upgradeWebSocket(req);

  let dgSocket: any = null;

  clientSocket.onopen = () => {
    console.log(`[DG-Proxy] Client connected, language=${language}`);

    const dgUrl =
      `wss://api.deepgram.com/v1/listen?model=nova-2&language=${language}` +
      `&smart_format=true&encoding=linear16&sample_rate=16000` +
      `&punctuate=true&interim_results=true&endpointing=300`;

    dgSocket = new WS(dgUrl, {
      headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
    });

    dgSocket.on("open", () => {
      console.log("[DG-Proxy] Deepgram WebSocket connected ✓");
      // Notify client that proxy is ready
      clientSocket.send(JSON.stringify({ type: "proxy_ready" }));
    });

    dgSocket.on("message", (data: Buffer | string) => {
      // Forward Deepgram responses (JSON) to client
      try {
        if (clientSocket.readyState === WebSocket.OPEN) {
          const msg = typeof data === "string" ? data : data.toString("utf-8");
          clientSocket.send(msg);
        }
      } catch (e) {
        console.error("[DG-Proxy] Forward error:", e);
      }
    });

    dgSocket.on("error", (err: Error) => {
      console.error("[DG-Proxy] Deepgram error:", err.message);
      try {
        clientSocket.send(JSON.stringify({ type: "error", message: err.message }));
      } catch {}
    });

    dgSocket.on("close", (code: number) => {
      console.log(`[DG-Proxy] Deepgram closed: ${code}`);
      try { clientSocket.close(code || 1000); } catch {}
    });
  };

  clientSocket.onmessage = (event: MessageEvent) => {
    if (!dgSocket || dgSocket.readyState !== WS.OPEN) return;

    try {
      // Check for control messages (JSON strings)
      if (typeof event.data === "string") {
        const msg = JSON.parse(event.data);
        if (msg.type === "CloseStream") {
          dgSocket.send(JSON.stringify({ type: "CloseStream" }));
          return;
        }
        if (msg.type === "reconnect") {
          // Client wants to change language — close current DG connection
          // Client will open a new WS connection with new params
          dgSocket.close(1000);
          return;
        }
      }
    } catch {
      // Not JSON — treat as binary audio
    }

    // Forward binary audio data to Deepgram
    let audioData: Uint8Array;
    if (event.data instanceof ArrayBuffer) audioData = new Uint8Array(event.data);
    else if (event.data instanceof Uint8Array) audioData = event.data;
    else return;

    dgSocket.send(audioData);
  };

  clientSocket.onclose = () => {
    console.log("[DG-Proxy] Client disconnected");
    if (dgSocket?.readyState === WS.OPEN) {
      try {
        dgSocket.send(JSON.stringify({ type: "CloseStream" }));
        setTimeout(() => { try { dgSocket.close(1000); } catch {} }, 500);
      } catch {}
    }
  };

  clientSocket.onerror = () => {
    if (dgSocket) try { dgSocket.close(1000); } catch {}
  };

  return response;
});
