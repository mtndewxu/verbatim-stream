// @ts-nocheck — Deno edge function
import WS from "npm:ws";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const VOLC_WS_ENDPOINT = "wss://openspeech.bytedance.com/api/v4/ast/v2/translate";
const VOLC_RESOURCE_ID = "volc.service_type.10053";

// ── Protobuf wire helpers ──
const WIRE_VARINT = 0;
const WIRE_LEN = 2;

function encodeVarint(value: number): Uint8Array {
  if (value === 0) return new Uint8Array([0]);
  const bytes: number[] = [];
  let v = value >>> 0; // treat as unsigned
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7f);
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
    if (shift > 35) break;
  }
  return [result >>> 0, pos];
}

function encodeTag(field: number, wire: number): Uint8Array {
  return encodeVarint((field << 3) | wire);
}

function encodeLenDelimited(field: number, data: Uint8Array): Uint8Array {
  const tag = encodeTag(field, WIRE_LEN);
  const len = encodeVarint(data.length);
  const r = new Uint8Array(tag.length + len.length + data.length);
  r.set(tag, 0);
  r.set(len, tag.length);
  r.set(data, tag.length + len.length);
  return r;
}

function encodeVarintField(field: number, value: number): Uint8Array {
  const tag = encodeTag(field, WIRE_VARINT);
  const val = encodeVarint(value);
  const r = new Uint8Array(tag.length + val.length);
  r.set(tag, 0);
  r.set(val, tag.length);
  return r;
}

function encodeStringField(field: number, str: string): Uint8Array {
  return encodeLenDelimited(field, new TextEncoder().encode(str));
}

function encodeBytesField(field: number, data: Uint8Array): Uint8Array {
  return encodeLenDelimited(field, data);
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrays) total += a.length;
  const r = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { r.set(a, off); off += a.length; }
  return r;
}

// ── Event constants (from events.proto) ──
const EVT_START_SESSION   = 100;
const EVT_FINISH_SESSION  = 102;
const EVT_SESSION_STARTED = 150;
const EVT_SESSION_FAILED  = 153;
const EVT_SESSION_FINISHED = 152;
const EVT_USAGE_RESPONSE  = 154;
const EVT_TASK_REQUEST    = 200;

// ── Message builders (field numbers from .proto files) ──

// RequestMeta: Endpoint=1, AppKey=2, AppID=3, ResourceID=4, ConnectionID=5, SessionID=6, Sequence=7
function buildRequestMeta(sessionId: string): Uint8Array {
  return encodeStringField(6, sessionId); // SessionID = field 6
}

// User: uid=1, did=2
function buildUser(uid: string): Uint8Array {
  return concat(
    encodeStringField(1, uid),
    encodeStringField(2, uid),
  );
}

// Audio: format=4, rate=7, bits=8, channel=9, binary_data=14
function buildSourceAudioConfig(format: string, rate: number, bits: number, channel: number): Uint8Array {
  return concat(
    encodeStringField(4, format),
    encodeVarintField(7, rate),
    encodeVarintField(8, bits),
    encodeVarintField(9, channel),
  );
}

function buildAudioData(audioBytes: Uint8Array): Uint8Array {
  return encodeBytesField(14, audioBytes); // binary_data = field 14
}

// ReqParams: mode=1, source_language=2, target_language=3
function buildReqParams(mode: string, srcLang: string, tgtLang: string): Uint8Array {
  return concat(
    encodeStringField(1, mode),
    encodeStringField(2, srcLang),
    encodeStringField(3, tgtLang),
  );
}

// TranslateRequest: request_meta=1, event=2, user=3, source_audio=4, target_audio=5, request=6
function buildStartSession(sessionId: string, srcLang: string, tgtLang: string): Uint8Array {
  return concat(
    encodeLenDelimited(1, buildRequestMeta(sessionId)),   // request_meta
    encodeVarintField(2, EVT_START_SESSION),                // event = 100
    encodeLenDelimited(3, buildUser("verbatim-stream")),   // user
    encodeLenDelimited(4, buildSourceAudioConfig("pcm", 16000, 16, 1)), // source_audio
    encodeLenDelimited(6, buildReqParams("s2t", srcLang, tgtLang)),     // request
  );
}

function buildTaskRequest(sessionId: string, audioData: Uint8Array): Uint8Array {
  return concat(
    encodeLenDelimited(1, buildRequestMeta(sessionId)),   // request_meta
    encodeVarintField(2, EVT_TASK_REQUEST),                // event = 200
    encodeLenDelimited(4, buildAudioData(audioData)),      // source_audio.binary_data
  );
}

function buildFinishSession(sessionId: string): Uint8Array {
  return concat(
    encodeLenDelimited(1, buildRequestMeta(sessionId)),   // request_meta
    encodeVarintField(2, EVT_FINISH_SESSION),              // event = 102
  );
}

// ── Protobuf decoder ──
interface ProtoField {
  field: number;
  wire: number;
  value: number | Uint8Array;
}

function decodeFields(data: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;
  while (offset < data.length) {
    const [tag, newOff] = decodeVarint(data, offset);
    if (newOff === offset) break;
    offset = newOff;
    const wire = tag & 0x07;
    const field = tag >>> 3;

    if (wire === WIRE_VARINT) {
      const [value, nextOff] = decodeVarint(data, offset);
      offset = nextOff;
      fields.push({ field, wire, value });
    } else if (wire === WIRE_LEN) {
      const [length, nextOff] = decodeVarint(data, offset);
      offset = nextOff;
      fields.push({ field, wire, value: data.slice(offset, offset + length) });
      offset += length;
    } else if (wire === 5) { // fixed32
      offset += 4;
    } else if (wire === 1) { // fixed64
      offset += 8;
    } else {
      break;
    }
  }
  return fields;
}

interface ParsedResponse {
  event: number;
  sessionId: string;
  sequence: number;
  statusCode: number;
  message: string;
  text: string;
}

function parseResponse(data: Uint8Array): ParsedResponse {
  const r: ParsedResponse = { event: 0, sessionId: "", sequence: 0, statusCode: 0, message: "", text: "" };
  for (const f of decodeFields(data)) {
    if (f.field === 1 && f.wire === WIRE_LEN) {
      // ResponseMeta: SessionID=1, Sequence=2, StatusCode=3, Message=4
      for (const mf of decodeFields(f.value as Uint8Array)) {
        if (mf.field === 1 && mf.wire === WIRE_LEN) r.sessionId = new TextDecoder().decode(mf.value as Uint8Array);
        else if (mf.field === 2 && mf.wire === WIRE_VARINT) r.sequence = mf.value as number;
        else if (mf.field === 3 && mf.wire === WIRE_VARINT) r.statusCode = mf.value as number;
        else if (mf.field === 4 && mf.wire === WIRE_LEN) r.message = new TextDecoder().decode(mf.value as Uint8Array);
      }
    } else if (f.field === 2 && f.wire === WIRE_VARINT) {
      r.event = f.value as number;
    } else if (f.field === 4 && f.wire === WIRE_LEN) {
      // text = field 4 in TranslateResponse
      r.text = new TextDecoder().decode(f.value as Uint8Array);
    }
  }
  return r;
}

function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ── Main server ──
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const appId = Deno.env.get("VOLCENGINE_APP_ID");
  const accessKey = Deno.env.get("VOLCENGINE_ACCESS_KEY");
  if (!appId || !accessKey) {
    return new Response(JSON.stringify({ error: "Missing Volcengine credentials" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() !== "websocket") {
    return new Response(JSON.stringify({ error: "WebSocket upgrade required" }), {
      status: 426, headers: { ...corsHeaders, "Content-Type": "application/json" },
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
      console.log("[VolcProxy] Connected to Volcengine, sending StartSession (event=100)…");
      const msg = buildStartSession(sessionId, sourceLang, targetLang);
      volcSocket.send(msg);
    });

    volcSocket.on("message", (data: Buffer | Uint8Array) => {
      try {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        const resp = parseResponse(bytes);
        console.log(`[VolcProxy] evt=${resp.event} seq=${resp.sequence} status=${resp.statusCode} text="${resp.text.substring(0, 80)}" msg="${resp.message.substring(0, 80)}"`);

        if (resp.event === EVT_SESSION_STARTED) {
          sessionStarted = true;
          clientSocket.send(JSON.stringify({ type: "ready" }));
          console.log("[VolcProxy] Session started ✓");

        } else if (resp.event === EVT_SESSION_FAILED) {
          console.error(`[VolcProxy] Session failed: ${resp.statusCode} ${resp.message}`);
          clientSocket.send(JSON.stringify({ type: "error", message: `Session failed (${resp.statusCode}): ${resp.message}` }));

        } else if (resp.event === EVT_SESSION_FINISHED) {
          console.log("[VolcProxy] Session finished");
          if (resp.text && resp.text !== lastText) {
            clientSocket.send(JSON.stringify({ type: "final", text: resp.text }));
          }
          try { clientSocket.close(1000, "Session finished"); } catch {}

        } else if (resp.event === EVT_USAGE_RESPONSE) {
          console.log("[VolcProxy] Usage response");

        } else {
          // TaskResponse or other data — forward text
          if (resp.text) {
            const isFinal = resp.text.length > lastText.length;
            lastText = resp.text;
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
      console.error("[VolcProxy] Volcengine error:", err.message);
      try { clientSocket.send(JSON.stringify({ type: "error", message: err.message })); } catch {}
    });

    volcSocket.on("close", (code: number, reason: Buffer) => {
      console.log(`[VolcProxy] Volcengine closed: ${code} ${reason?.toString() || ""}`);
      try { clientSocket.close(code || 1000); } catch {}
    });
  };

  clientSocket.onmessage = (event: MessageEvent) => {
    if (!sessionStarted || !volcSocket) return;

    try {
      if (typeof event.data === "string") {
        const msg = JSON.parse(event.data);
        if (msg.type === "audio_end") {
          console.log("[VolcProxy] Sending FinishSession (event=102)");
          volcSocket.send(buildFinishSession(sessionId));
          return;
        }
      }
    } catch {}

    // Forward binary audio as TaskRequest
    let audioData: Uint8Array;
    if (event.data instanceof ArrayBuffer) {
      audioData = new Uint8Array(event.data);
    } else if (event.data instanceof Uint8Array) {
      audioData = event.data;
    } else {
      return;
    }

    volcSocket.send(buildTaskRequest(sessionId, audioData));
  };

  clientSocket.onclose = () => {
    console.log("[VolcProxy] Client disconnected");
    if (volcSocket && volcSocket.readyState === WS.OPEN) {
      try { volcSocket.send(buildFinishSession(sessionId)); } catch {}
      setTimeout(() => { try { volcSocket.close(1000); } catch {} }, 500);
    }
  };

  clientSocket.onerror = () => {
    if (volcSocket) try { volcSocket.close(1000); } catch {}
  };

  return response;
});
