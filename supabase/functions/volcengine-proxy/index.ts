// @ts-nocheck — Deno edge function
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Volcengine 同传 endpoint
const VOLC_WS_ENDPOINT = "wss://openspeech.bytedance.com/api/v4/ast/v2/translate";
const VOLC_RESOURCE_ID = "volc.service_type.10047"; // 同声传译资源ID

// Binary protocol constants
const PROTOCOL_VERSION = 0x1;
const HEADER_SIZE_UNITS = 0x1;
const MSG_TYPE_FULL_CLIENT_REQ = 0x1;
const MSG_TYPE_AUDIO_ONLY_CLIENT_REQ = 0x2;
const MSG_TYPE_FULL_SERVER_RESP = 0x9;
const MSG_TYPE_ERROR_SERVER = 0xf;
const SERIALIZE_JSON = 0x1;
const COMPRESS_GZIP = 0x1;
const COMPRESS_NONE = 0x0;
const FLAG_AUDIO_LAST = 0x2;

function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function gzip(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  writer.write(data);
  writer.close();
  const chunks: Uint8Array[] = [];
  const reader = cs.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  let totalLength = 0;
  for (const c of chunks) totalLength += c.length;
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return result;
}

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  try {
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    writer.write(data);
    writer.close();
    const chunks: Uint8Array[] = [];
    const reader = ds.readable.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    let totalLength = 0;
    for (const c of chunks) totalLength += c.length;
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const c of chunks) {
      result.set(c, offset);
      offset += c.length;
    }
    return result;
  } catch {
    return data;
  }
}

function buildClientFrame(
  messageType: number,
  flags: number,
  serialization: number,
  compression: number,
  payload: Uint8Array
): Uint8Array {
  const header = new Uint8Array(4);
  header[0] = ((PROTOCOL_VERSION & 0x0f) << 4) | (HEADER_SIZE_UNITS & 0x0f);
  header[1] = ((messageType & 0x0f) << 4) | (flags & 0x0f);
  header[2] = ((serialization & 0x0f) << 4) | (compression & 0x0f);
  header[3] = 0;

  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, payload.length, false); // big-endian

  const frame = new Uint8Array(4 + 4 + payload.length);
  frame.set(header, 0);
  frame.set(size, 4);
  frame.set(payload, 8);
  return frame;
}

function buildFullClientRequest(sourceLang: string, targetLang: string): string {
  return JSON.stringify({
    header: {
      appid: Deno.env.get("VOLCENGINE_APP_ID") || "",
      token: Deno.env.get("VOLCENGINE_ACCESS_KEY") || "",
    },
    user: {
      uid: "verbatim-stream-user",
    },
    audio: {
      format: "pcm",
      rate: 16000,
      bits: 16,
      channel: 1,
    },
    request: {
      reqid: generateUUID(),
      source_language: sourceLang, // e.g. "zh" or "en"
      target_language: targetLang, // e.g. "en" or "zh"
      mode: "s2t", // Speech-to-Text translation
      enable_itn: true,
      enable_punc: true,
    },
  });
}

function parseServerResponse(data: Uint8Array): {
  type: "result" | "error";
  text?: string;
  translation?: string;
  isFinal?: boolean;
  errorCode?: number;
  errorMsg?: string;
  raw?: unknown;
} | null {
  if (data.length < 8) return null;

  const headerSizeBytes = (data[0] & 0x0f) * 4;
  const msgType = (data[1] >> 4) & 0x0f;
  const flags = data[1] & 0x0f;
  const serialization = (data[2] >> 4) & 0x0f;
  const compression = data[2] & 0x0f;

  if (msgType === MSG_TYPE_ERROR_SERVER) {
    let offset = headerSizeBytes;
    if (data.length < offset + 8) return null;
    const dv = new DataView(data.buffer, data.byteOffset);
    const code = dv.getUint32(offset, false);
    const size = dv.getUint32(offset + 4, false);
    const start = offset + 8;
    const end = Math.min(start + size, data.length);
    const msg = new TextDecoder().decode(data.slice(start, end));
    return { type: "error", errorCode: code, errorMsg: msg };
  }

  if (msgType === MSG_TYPE_FULL_SERVER_RESP) {
    // Skip header + optional sequence field
    let offset = headerSizeBytes + 4; // +4 for sequence number
    if (data.length < offset + 4) return null;
    const dv = new DataView(data.buffer, data.byteOffset);
    const payloadSize = dv.getUint32(offset, false);
    offset += 4;
    if (data.length < offset + payloadSize) return null;

    let payload = data.slice(offset, offset + payloadSize);
    return { type: "result", raw: payload, isFinal: (flags & 0x3) === 0x3 };
  }

  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const appId = Deno.env.get("VOLCENGINE_APP_ID");
  const accessKey = Deno.env.get("VOLCENGINE_ACCESS_KEY");

  if (!appId || !accessKey) {
    return new Response(JSON.stringify({ error: "Missing Volcengine credentials" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Check for WebSocket upgrade
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() !== "websocket") {
    return new Response(JSON.stringify({ error: "WebSocket upgrade required" }), {
      status: 426,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const url = new URL(req.url);
  const sourceLang = url.searchParams.get("source") || "zh";
  const targetLang = url.searchParams.get("target") || "en";

  const { socket: clientSocket, response } = Deno.upgradeWebSocket(req);
  const connectId = generateUUID();

  let volcSocket: WebSocket | null = null;
  let volcReady = false;

  clientSocket.onopen = () => {
    console.log("[VolcProxy] Client connected, opening Volcengine WSS…");

    // Connect to Volcengine with auth headers
    // Note: Deno WebSocket doesn't support custom headers directly,
    // so we pass auth in the initial payload instead
    volcSocket = new WebSocket(VOLC_WS_ENDPOINT);
    volcSocket.binaryType = "arraybuffer";

    volcSocket.onopen = async () => {
      console.log("[VolcProxy] Connected to Volcengine");

      // Send full client request with config
      const fullRequest = buildFullClientRequest(sourceLang, targetLang);
      console.log("[VolcProxy] Sending config:", fullRequest);

      const payload = await gzip(new TextEncoder().encode(fullRequest));
      const frame = buildClientFrame(MSG_TYPE_FULL_CLIENT_REQ, 0, SERIALIZE_JSON, COMPRESS_GZIP, payload);
      volcSocket!.send(frame);
      volcReady = true;
      clientSocket.send(JSON.stringify({ type: "ready" }));
    };

    volcSocket.onmessage = async (event) => {
      try {
        const rawData = event.data instanceof ArrayBuffer
          ? new Uint8Array(event.data)
          : new Uint8Array(await (event.data as Blob).arrayBuffer());

        const parsed = parseServerResponse(rawData);
        if (!parsed) return;

        if (parsed.type === "error") {
          clientSocket.send(JSON.stringify({
            type: "error",
            code: parsed.errorCode,
            message: parsed.errorMsg,
          }));
          return;
        }

        if (parsed.type === "result" && parsed.raw instanceof Uint8Array) {
          // Decompress if needed
          let payloadBytes = parsed.raw;
          // Check compression from original data
          const compression = (rawData[2] >> 4 === 0) ? rawData[2] & 0x0f : rawData[2] & 0x0f;
          if (compression === COMPRESS_GZIP) {
            payloadBytes = await gunzip(payloadBytes);
          }
          const serialization = (rawData[2] >> 4) & 0x0f;
          if (serialization === SERIALIZE_JSON) {
            const json = JSON.parse(new TextDecoder().decode(payloadBytes));
            // Extract transcription and translation from response
            const srcText = json?.result?.src_text || json?.result?.text || "";
            const tgtText = json?.result?.tgt_text || json?.result?.translation || "";
            const isFinal = parsed.isFinal || false;

            clientSocket.send(JSON.stringify({
              type: isFinal ? "final" : "partial",
              text: srcText,
              translation: tgtText,
              raw: json,
            }));
          }
        }
      } catch (e) {
        console.error("[VolcProxy] Parse error:", e);
      }
    };

    volcSocket.onerror = (event) => {
      console.error("[VolcProxy] Volcengine WSS error:", event);
      try {
        clientSocket.send(JSON.stringify({ type: "error", message: "Volcengine connection error" }));
      } catch {}
    };

    volcSocket.onclose = (event) => {
      console.log(`[VolcProxy] Volcengine closed: ${event.code} ${event.reason}`);
      try { clientSocket.close(event.code, event.reason); } catch {}
    };
  };

  clientSocket.onmessage = async (event) => {
    if (!volcReady || !volcSocket) return;

    try {
      // Check if it's a JSON control message
      if (typeof event.data === "string") {
        const msg = JSON.parse(event.data);
        if (msg.type === "audio_end") {
          const emptyPayload = await gzip(new Uint8Array(0));
          const frame = buildClientFrame(MSG_TYPE_AUDIO_ONLY_CLIENT_REQ, FLAG_AUDIO_LAST, 0, COMPRESS_GZIP, emptyPayload);
          volcSocket.send(frame);
          console.log("[VolcProxy] Sent audio end marker");
          return;
        }
      }
    } catch {
      // Not JSON, treat as binary audio
    }

    // Forward binary audio data
    const audioData = event.data instanceof ArrayBuffer
      ? new Uint8Array(event.data)
      : new TextEncoder().encode(event.data);

    const payload = await gzip(audioData);
    const frame = buildClientFrame(MSG_TYPE_AUDIO_ONLY_CLIENT_REQ, 0, 0, COMPRESS_GZIP, payload);
    volcSocket.send(frame);
  };

  clientSocket.onclose = async () => {
    console.log("[VolcProxy] Client disconnected");
    if (volcSocket && volcSocket.readyState === WebSocket.OPEN) {
      try {
        const emptyPayload = await gzip(new Uint8Array(0));
        const frame = buildClientFrame(MSG_TYPE_AUDIO_ONLY_CLIENT_REQ, FLAG_AUDIO_LAST, 0, COMPRESS_GZIP, emptyPayload);
        volcSocket.send(frame);
      } catch {}
      volcSocket.close(1000, "Client disconnected");
    }
  };

  clientSocket.onerror = (event) => {
    console.error("[VolcProxy] Client error:", event);
    if (volcSocket) volcSocket.close(1000, "Client error");
  };

  return response;
});
