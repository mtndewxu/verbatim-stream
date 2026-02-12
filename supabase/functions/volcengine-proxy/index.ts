// @ts-nocheck — Deno edge function
import WS from "npm:ws";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const VOLC_WS_ENDPOINT = "wss://openspeech.bytedance.com/api/v4/ast/v2/translate";
const VOLC_RESOURCE_ID = "volc.service_type.10053";

// Binary protocol constants
const PROTOCOL_VERSION = 0x1;
const HEADER_SIZE_UNITS = 0x1;
const MSG_TYPE_FULL_CLIENT_REQ = 0x1;
const MSG_TYPE_AUDIO_ONLY_CLIENT_REQ = 0x2;
const MSG_TYPE_FULL_SERVER_RESP = 0x9;
const MSG_TYPE_FULL_SERVER_ACK = 0xb;
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
  new DataView(size.buffer).setUint32(0, payload.length, false);

  const frame = new Uint8Array(4 + 4 + payload.length);
  frame.set(header, 0);
  frame.set(size, 4);
  frame.set(payload, 8);
  return frame;
}

function buildFullClientRequest(appId: string, token: string, sourceLang: string, targetLang: string): string {
  return JSON.stringify({
    header: {
      appid: appId,
      token: token,
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
      source_language: sourceLang,
      target_language: targetLang,
      mode: "s2t",
      enable_itn: true,
      enable_punc: true,
    },
  });
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

  let volcSocket: any = null;
  let volcReady = false;

  clientSocket.onopen = () => {
    console.log("[VolcProxy] Client connected, opening Volcengine WSS…");

    volcSocket = new WS(VOLC_WS_ENDPOINT, {
      headers: {
        "X-Api-App-Key": appId,
        "X-Api-Access-Key": accessKey,
        "X-Api-Resource-Id": VOLC_RESOURCE_ID,
        "X-Api-Connect-Id": connectId,
      },
    });

    volcSocket.on("open", async () => {
      console.log("[VolcProxy] Connected to Volcengine, sending config…");

      // Send full client request with config (binary frame protocol)
      const fullRequest = buildFullClientRequest(appId!, accessKey!, sourceLang, targetLang);
      console.log("[VolcProxy] Config:", fullRequest);

      const payload = await gzip(new TextEncoder().encode(fullRequest));
      const frame = buildClientFrame(MSG_TYPE_FULL_CLIENT_REQ, 0, SERIALIZE_JSON, COMPRESS_GZIP, payload);
      volcSocket.send(frame);
      volcReady = true;
      clientSocket.send(JSON.stringify({ type: "ready" }));
    });

    volcSocket.on("message", async (data: Buffer | Uint8Array) => {
      try {
        // Convert Buffer to Uint8Array
        const rawData = data instanceof Uint8Array ? data : new Uint8Array(data);
        
        if (rawData.length < 4) {
          console.log("[VolcProxy] Too short response:", rawData.length);
          return;
        }

        const headerSizeBytes = (rawData[0] & 0x0f) * 4;
        const msgType = (rawData[1] >> 4) & 0x0f;
        const flags = rawData[1] & 0x0f;
        const serialization = (rawData[2] >> 4) & 0x0f;
        const compression = rawData[2] & 0x0f;

        console.log(`[VolcProxy] Frame: msgType=${msgType}, flags=${flags}, ser=${serialization}, comp=${compression}, len=${rawData.length}`);

        if (msgType === MSG_TYPE_ERROR_SERVER) {
          let offset = headerSizeBytes;
          if (rawData.length >= offset + 8) {
            const dv = new DataView(rawData.buffer, rawData.byteOffset);
            const code = dv.getUint32(offset, false);
            const size = dv.getUint32(offset + 4, false);
            const start = offset + 8;
            const end = Math.min(start + size, rawData.length);
            const msg = new TextDecoder().decode(rawData.slice(start, end));
            console.error(`[VolcProxy] Server error: code=${code}, msg=${msg}`);
            clientSocket.send(JSON.stringify({ type: "error", message: `Error ${code}: ${msg}` }));
          }
          return;
        }

        if (msgType === MSG_TYPE_FULL_SERVER_ACK) {
          console.log("[VolcProxy] Server ACK received");
          return;
        }

        if (msgType === MSG_TYPE_FULL_SERVER_RESP) {
          let offset = headerSizeBytes;
          // Read sequence number (4 bytes)
          if (rawData.length < offset + 4) return;
          const dv = new DataView(rawData.buffer, rawData.byteOffset);
          const sequence = dv.getInt32(offset, false);
          offset += 4;

          // Read payload size (4 bytes)
          if (rawData.length < offset + 4) return;
          const payloadSize = dv.getUint32(offset, false);
          offset += 4;

          if (rawData.length < offset + payloadSize) return;
          let payloadBytes = rawData.slice(offset, offset + payloadSize);

          // Decompress if gzip
          if (compression === COMPRESS_GZIP) {
            payloadBytes = await gunzip(payloadBytes);
          }

          if (serialization === SERIALIZE_JSON) {
            const jsonStr = new TextDecoder().decode(payloadBytes);
            console.log(`[VolcProxy] Response JSON (seq=${sequence}): ${jsonStr.substring(0, 200)}`);

            try {
              const json = JSON.parse(jsonStr);
              const srcText = json?.result?.src_text || json?.result?.text || json?.text || "";
              const tgtText = json?.result?.tgt_text || json?.result?.translation || json?.translation || "";
              const isFinal = json?.result?.is_final || json?.is_final || false;

              clientSocket.send(JSON.stringify({
                type: isFinal ? "final" : "partial",
                text: srcText,
                translation: tgtText,
                sequence,
                raw: json,
              }));
            } catch (e) {
              console.error("[VolcProxy] JSON parse error:", e, jsonStr.substring(0, 100));
            }
          }
          return;
        }

        // Unknown message type - log hex for debugging
        const hexDump = Array.from(rawData.slice(0, 32)).map(b => b.toString(16).padStart(2, '0')).join(' ');
        console.log(`[VolcProxy] Unknown msgType=${msgType}, hex: ${hexDump}`);

      } catch (e) {
        console.error("[VolcProxy] Parse error:", e);
      }
    });

    volcSocket.on("error", (err: Error) => {
      console.error("[VolcProxy] Volcengine WSS error:", err.message);
      try {
        clientSocket.send(JSON.stringify({ type: "error", message: err.message }));
      } catch {}
    });

    volcSocket.on("close", (code: number, reason: Buffer) => {
      const reasonStr = reason ? reason.toString() : "";
      console.log(`[VolcProxy] Volcengine closed: ${code} ${reasonStr}`);
      try { clientSocket.close(code || 1000, reasonStr || "Volcengine closed"); } catch {}
    });
  };

  clientSocket.onmessage = async (event: MessageEvent) => {
    if (!volcReady || !volcSocket) return;

    try {
      if (typeof event.data === "string") {
        const msg = JSON.parse(event.data);
        if (msg.type === "audio_end") {
          // Send last audio frame with FLAG_AUDIO_LAST
          const emptyPayload = new Uint8Array(0);
          const frame = buildClientFrame(MSG_TYPE_AUDIO_ONLY_CLIENT_REQ, FLAG_AUDIO_LAST, 0, COMPRESS_NONE, emptyPayload);
          volcSocket.send(frame);
          console.log("[VolcProxy] Sent audio end marker");
          return;
        }
      }
    } catch {}

    // Forward binary audio data
    let audioData: Uint8Array;
    if (event.data instanceof ArrayBuffer) {
      audioData = new Uint8Array(event.data);
    } else if (event.data instanceof Uint8Array) {
      audioData = event.data;
    } else {
      return;
    }

    // Send audio as uncompressed for lower latency
    const frame = buildClientFrame(MSG_TYPE_AUDIO_ONLY_CLIENT_REQ, 0, 0, COMPRESS_NONE, audioData);
    volcSocket.send(frame);
  };

  clientSocket.onclose = () => {
    console.log("[VolcProxy] Client disconnected");
    if (volcSocket && volcSocket.readyState === WS.OPEN) {
      try {
        const frame = buildClientFrame(MSG_TYPE_AUDIO_ONLY_CLIENT_REQ, FLAG_AUDIO_LAST, 0, COMPRESS_NONE, new Uint8Array(0));
        volcSocket.send(frame);
      } catch {}
      setTimeout(() => {
        try { volcSocket.close(1000, "Client disconnected"); } catch {}
      }, 500);
    }
  };

  clientSocket.onerror = (event: Event) => {
    console.error("[VolcProxy] Client error:", event);
    if (volcSocket) try { volcSocket.close(1000, "Client error"); } catch {}
  };

  return response;
});
