// @ts-nocheck — Deno edge function
import WS from "npm:ws";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const VOLC_WS_ENDPOINT = "wss://openspeech.bytedance.com/api/v4/ast/v2/translate";
const VOLC_RESOURCE_ID = "volc.service_type.10053";

/**
 * Minimal Protobuf encoder/decoder for Volcengine AST v2 translate.
 * 
 * The Java demo uses protobuf with these message types:
 * - TranslateRequest: { request_meta, event, user, source_audio, target_audio, request }
 * - TranslateResponse: { response_meta, event, text, data, spk_chg }
 * 
 * Events: StartSession=1, SessionStarted=2, TaskRequest=3, 
 *         SessionFinished=6, FinishSession=7, SessionFailed=8, SessionCanceled=9
 * 
 * We manually encode/decode the protobuf wire format.
 */

// Protobuf wire types
const WIRE_VARINT = 0;
const WIRE_LEN = 2;

function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value & 0x7f);
  return new Uint8Array(bytes);
}

function decodeVarint(data: Uint8Array, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (pos < data.length) {
    const b = data[pos];
    result |= (b & 0x7f) << shift;
    pos++;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return [result, pos];
}

function encodeTag(fieldNumber: number, wireType: number): Uint8Array {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function encodeLenDelimited(fieldNumber: number, data: Uint8Array): Uint8Array {
  const tag = encodeTag(fieldNumber, WIRE_LEN);
  const len = encodeVarint(data.length);
  const result = new Uint8Array(tag.length + len.length + data.length);
  result.set(tag, 0);
  result.set(len, tag.length);
  result.set(data, tag.length + len.length);
  return result;
}

function encodeVarintField(fieldNumber: number, value: number): Uint8Array {
  const tag = encodeTag(fieldNumber, WIRE_VARINT);
  const val = encodeVarint(value);
  const result = new Uint8Array(tag.length + val.length);
  result.set(tag, 0);
  result.set(val, tag.length);
  return result;
}

function encodeString(fieldNumber: number, str: string): Uint8Array {
  return encodeLenDelimited(fieldNumber, new TextEncoder().encode(str));
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  let totalLen = 0;
  for (const a of arrays) totalLen += a.length;
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

// Build RequestMeta (message field 1)
// RequestMeta: { session_id: string (field 1) }
function buildRequestMeta(sessionId: string): Uint8Array {
  const inner = encodeString(1, sessionId);
  return encodeLenDelimited(1, inner);
}

// Build User (message field 4)
// User: { uid: string (field 1), did: string (field 2) }
function buildUser(uid: string, did: string): Uint8Array {
  const inner = concat(encodeString(1, uid), encodeString(2, did));
  return encodeLenDelimited(4, inner);
}

// Build Audio (for source_audio field 5 or target_audio field 6)
// Audio: { format: string(1), rate: int32(2), bits: int32(3), channel: int32(4), binary_data: bytes(5) }
function buildAudio(fieldNum: number, opts: { format?: string; rate?: number; bits?: number; channel?: number; binaryData?: Uint8Array }): Uint8Array {
  const parts: Uint8Array[] = [];
  if (opts.format) parts.push(encodeString(1, opts.format));
  if (opts.rate) parts.push(encodeVarintField(2, opts.rate));
  if (opts.bits) parts.push(encodeVarintField(3, opts.bits));
  if (opts.channel) parts.push(encodeVarintField(4, opts.channel));
  if (opts.binaryData) parts.push(encodeLenDelimited(5, opts.binaryData));
  return encodeLenDelimited(fieldNum, concat(...parts));
}

// Build ReqParams (message field 7)
// ReqParams: { mode: string(1), source_language: string(2), target_language: string(3) }
function buildReqParams(mode: string, srcLang: string, tgtLang: string): Uint8Array {
  const inner = concat(encodeString(1, mode), encodeString(2, srcLang), encodeString(3, tgtLang));
  return encodeLenDelimited(7, inner);
}

// Event field (field 2, varint)
function buildEvent(eventType: number): Uint8Array {
  return encodeVarintField(2, eventType);
}

// Events enum
const EVENT_START_SESSION = 1;
const EVENT_SESSION_STARTED = 2;
const EVENT_TASK_REQUEST = 3;
const EVENT_SESSION_FINISHED = 6;
const EVENT_FINISH_SESSION = 7;
const EVENT_SESSION_FAILED = 8;
const EVENT_USAGE_RESPONSE = 14;

function buildStartSessionRequest(sessionId: string, srcLang: string, tgtLang: string): Uint8Array {
  return concat(
    buildRequestMeta(sessionId),
    buildEvent(EVENT_START_SESSION),
    buildUser("verbatim-stream-user", "verbatim-stream-device"),
    buildAudio(5, { format: "pcm", rate: 16000, bits: 16, channel: 1 }),
    buildReqParams("s2t", srcLang, tgtLang),
  );
}

function buildAudioChunkRequest(sessionId: string, audioData: Uint8Array): Uint8Array {
  return concat(
    buildRequestMeta(sessionId),
    buildEvent(EVENT_TASK_REQUEST),
    buildAudio(5, { binaryData: audioData }),
  );
}

function buildFinishSessionRequest(sessionId: string): Uint8Array {
  return concat(
    buildRequestMeta(sessionId),
    buildEvent(EVENT_FINISH_SESSION),
  );
}

// ---- Protobuf Decoder ----
interface ProtoField {
  fieldNumber: number;
  wireType: number;
  value: number | Uint8Array;
}

function decodeProtoFields(data: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;
  while (offset < data.length) {
    const [tagValue, newOffset] = decodeVarint(data, offset);
    if (newOffset === offset) break;
    offset = newOffset;
    const wireType = tagValue & 0x07;
    const fieldNumber = tagValue >>> 3;

    if (wireType === WIRE_VARINT) {
      const [value, nextOffset] = decodeVarint(data, offset);
      offset = nextOffset;
      fields.push({ fieldNumber, wireType, value });
    } else if (wireType === WIRE_LEN) {
      const [length, nextOffset] = decodeVarint(data, offset);
      offset = nextOffset;
      const value = data.slice(offset, offset + length);
      offset += length;
      fields.push({ fieldNumber, wireType, value });
    } else if (wireType === 0) {
      // fixed32 - skip 4 bytes
      offset += 4;
    } else if (wireType === 1) {
      // fixed64 - skip 8 bytes
      offset += 8;
    } else {
      break; // unknown wire type
    }
  }
  return fields;
}

interface TranslateResponse {
  event: number;
  sessionId: string;
  statusCode: number;
  message: string;
  sequence: number;
  text: string;
  isFinal: boolean;
}

function parseTranslateResponse(data: Uint8Array): TranslateResponse {
  const result: TranslateResponse = {
    event: 0, sessionId: "", statusCode: 0, message: "", sequence: 0, text: "", isFinal: false,
  };

  const fields = decodeProtoFields(data);
  for (const f of fields) {
    if (f.fieldNumber === 1 && f.wireType === WIRE_LEN) {
      // response_meta
      const metaFields = decodeProtoFields(f.value as Uint8Array);
      for (const mf of metaFields) {
        if (mf.fieldNumber === 1 && mf.wireType === WIRE_LEN) {
          result.sessionId = new TextDecoder().decode(mf.value as Uint8Array);
        } else if (mf.fieldNumber === 2 && mf.wireType === WIRE_VARINT) {
          result.statusCode = mf.value as number;
        } else if (mf.fieldNumber === 3 && mf.wireType === WIRE_LEN) {
          result.message = new TextDecoder().decode(mf.value as Uint8Array);
        } else if (mf.fieldNumber === 4 && mf.wireType === WIRE_VARINT) {
          result.sequence = mf.value as number;
        }
      }
    } else if (f.fieldNumber === 2 && f.wireType === WIRE_VARINT) {
      result.event = f.value as number;
    } else if (f.fieldNumber === 3 && f.wireType === WIRE_LEN) {
      result.text = new TextDecoder().decode(f.value as Uint8Array);
    }
  }

  return result;
}

function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
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
  const sessionId = generateUUID();

  let volcSocket: any = null;
  let sessionStarted = false;
  // Track partial/final text per utterance
  let lastText = "";

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

    volcSocket.on("open", () => {
      console.log("[VolcProxy] Connected to Volcengine, sending StartSession…");
      const startMsg = buildStartSessionRequest(sessionId, sourceLang, targetLang);
      volcSocket.send(startMsg);
    });

    volcSocket.on("message", (data: Buffer | Uint8Array) => {
      try {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        // Debug: log first 64 bytes as hex
        const hexDump = Array.from(bytes.slice(0, 64)).map(b => b.toString(16).padStart(2, '0')).join(' ');
        console.log(`[VolcProxy] Raw response (${bytes.length} bytes): ${hexDump}`);
        const resp = parseTranslateResponse(bytes);
        console.log(`[VolcProxy] Event=${resp.event}, seq=${resp.sequence}, text="${resp.text}", status=${resp.statusCode}, msg="${resp.message}"`);

        if (resp.event === EVENT_SESSION_STARTED) {
          sessionStarted = true;
          clientSocket.send(JSON.stringify({ type: "ready" }));
          console.log("[VolcProxy] Session started ✓");
        } else if (resp.event === EVENT_SESSION_FAILED) {
          console.error(`[VolcProxy] Session failed: ${resp.statusCode} ${resp.message}`);
          clientSocket.send(JSON.stringify({ type: "error", message: `Session failed: ${resp.statusCode} ${resp.message}` }));
        } else if (resp.event === EVENT_SESSION_FINISHED) {
          console.log("[VolcProxy] Session finished");
          try { clientSocket.close(1000, "Session finished"); } catch {}
        } else if (resp.event === EVENT_USAGE_RESPONSE) {
          console.log("[VolcProxy] Usage response received");
        } else {
          // TaskResponse or other data events
          if (resp.text) {
            // Volcengine returns accumulated text; detect if it's a new final segment
            // The sequence number indicates progress; text accumulates
            const isFinal = resp.text !== lastText && resp.text.length > lastText.length;
            lastText = resp.text;
            
            // For the client, we send both partial updates and detect finality
            // The text field contains the source transcription
            // Translation is also in the text for s2t mode (source → recognized, then translated)
            clientSocket.send(JSON.stringify({
              type: isFinal ? "final" : "partial",
              text: resp.text,
              sequence: resp.sequence,
            }));
          }
        }
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

    volcSocket.on("close", (code: number, reason: string) => {
      console.log(`[VolcProxy] Volcengine closed: ${code} ${reason}`);
      try { clientSocket.close(code || 1000, reason || "Volcengine closed"); } catch {}
    });
  };

  clientSocket.onmessage = (event: MessageEvent) => {
    if (!sessionStarted || !volcSocket) return;

    try {
      if (typeof event.data === "string") {
        const msg = JSON.parse(event.data);
        if (msg.type === "audio_end") {
          console.log("[VolcProxy] Sending FinishSession");
          const finishMsg = buildFinishSessionRequest(sessionId);
          volcSocket.send(finishMsg);
          return;
        }
      }
    } catch {}

    // Forward binary audio data as TaskRequest protobuf
    let audioData: Uint8Array;
    if (event.data instanceof ArrayBuffer) {
      audioData = new Uint8Array(event.data);
    } else if (event.data instanceof Uint8Array) {
      audioData = event.data;
    } else {
      return;
    }

    const chunkMsg = buildAudioChunkRequest(sessionId, audioData);
    volcSocket.send(chunkMsg);
  };

  clientSocket.onclose = () => {
    console.log("[VolcProxy] Client disconnected");
    if (volcSocket && volcSocket.readyState === WS.OPEN) {
      try {
        const finishMsg = buildFinishSessionRequest(sessionId);
        volcSocket.send(finishMsg);
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
