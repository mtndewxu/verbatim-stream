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
  let v = value >>> 0;
  while (v > 0x7f) { bytes.push((v & 0x7f) | 0x80); v >>>= 7; }
  bytes.push(v & 0x7f);
  return new Uint8Array(bytes);
}

function decodeVarint(data: Uint8Array, offset: number): [number, number] {
  let result = 0, shift = 0, pos = offset;
  while (pos < data.length) {
    const b = data[pos]; result |= (b & 0x7f) << shift; pos++;
    if ((b & 0x80) === 0) break; shift += 7; if (shift > 35) break;
  }
  return [result >>> 0, pos];
}

function encodeTag(field: number, wire: number): Uint8Array { return encodeVarint((field << 3) | wire); }

function encodeLenDelimited(field: number, data: Uint8Array): Uint8Array {
  const tag = encodeTag(field, WIRE_LEN), len = encodeVarint(data.length);
  const r = new Uint8Array(tag.length + len.length + data.length);
  r.set(tag, 0); r.set(len, tag.length); r.set(data, tag.length + len.length);
  return r;
}

function encodeVarintField(field: number, value: number): Uint8Array {
  const tag = encodeTag(field, WIRE_VARINT), val = encodeVarint(value);
  const r = new Uint8Array(tag.length + val.length); r.set(tag, 0); r.set(val, tag.length);
  return r;
}

function encodeStringField(field: number, str: string): Uint8Array {
  return encodeLenDelimited(field, new TextEncoder().encode(str));
}

function encodeBytesField(field: number, data: Uint8Array): Uint8Array {
  return encodeLenDelimited(field, data);
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  let total = 0; for (const a of arrays) total += a.length;
  const r = new Uint8Array(total); let off = 0;
  for (const a of arrays) { r.set(a, off); off += a.length; }
  return r;
}

// ── Event constants ──
const EVT_START_SESSION   = 100;
const EVT_FINISH_SESSION  = 102;
const EVT_SESSION_STARTED = 150;
const EVT_SESSION_FAILED  = 153;
const EVT_SESSION_FINISHED = 152;
const EVT_USAGE_RESPONSE  = 154;
const EVT_TASK_REQUEST    = 200;
const EVT_AUDIO_MUTED     = 250;
const EVT_SRC_SUBTITLE_START = 650;
const EVT_SRC_SUBTITLE_RESP  = 651;
const EVT_SRC_SUBTITLE_END   = 652;
const EVT_TGT_SUBTITLE_START = 653;
const EVT_TGT_SUBTITLE_RESP  = 654;
const EVT_TGT_SUBTITLE_END   = 655;

// ── Protobuf message builders ──
function buildRequestMeta(sessionId: string): Uint8Array { return encodeStringField(6, sessionId); }

function buildStartSession(sessionId: string, srcLang: string, tgtLang: string): Uint8Array {
  return concat(
    encodeLenDelimited(1, buildRequestMeta(sessionId)),
    encodeVarintField(2, EVT_START_SESSION),
    encodeLenDelimited(3, concat(encodeStringField(1, "verbatim"), encodeStringField(2, "verbatim"))),
    encodeLenDelimited(4, concat(encodeStringField(4, "pcm"), encodeVarintField(7, 16000), encodeVarintField(8, 16), encodeVarintField(9, 1))),
    encodeLenDelimited(6, concat(encodeStringField(1, "s2t"), encodeStringField(2, srcLang), encodeStringField(3, tgtLang))),
  );
}

function buildTaskRequest(sessionId: string, audioData: Uint8Array): Uint8Array {
  return concat(
    encodeLenDelimited(1, buildRequestMeta(sessionId)),
    encodeVarintField(2, EVT_TASK_REQUEST),
    encodeLenDelimited(4, encodeBytesField(14, audioData)),
  );
}

function buildFinishSession(sessionId: string): Uint8Array {
  return concat(
    encodeLenDelimited(1, buildRequestMeta(sessionId)),
    encodeVarintField(2, EVT_FINISH_SESSION),
  );
}

// ── Protobuf decoder ──
function decodeFields(data: Uint8Array): { field: number; wire: number; value: number | Uint8Array }[] {
  const fields: any[] = []; let offset = 0;
  while (offset < data.length) {
    const [tag, newOff] = decodeVarint(data, offset); if (newOff === offset) break; offset = newOff;
    const wire = tag & 0x07, field = tag >>> 3;
    if (wire === WIRE_VARINT) { const [v, nOff] = decodeVarint(data, offset); offset = nOff; fields.push({ field, wire, value: v }); }
    else if (wire === WIRE_LEN) { const [len, nOff] = decodeVarint(data, offset); offset = nOff; fields.push({ field, wire, value: data.slice(offset, offset + len) }); offset += len; }
    else if (wire === 5) { offset += 4; } else if (wire === 1) { offset += 8; } else { break; }
  }
  return fields;
}

function parseResponse(data: Uint8Array) {
  const r = { event: 0, sessionId: "", sequence: 0, statusCode: 0, message: "", text: "" };
  for (const f of decodeFields(data)) {
    if (f.field === 1 && f.wire === WIRE_LEN) {
      for (const mf of decodeFields(f.value as Uint8Array)) {
        if (mf.field === 1 && mf.wire === WIRE_LEN) r.sessionId = new TextDecoder().decode(mf.value as Uint8Array);
        else if (mf.field === 2 && mf.wire === WIRE_VARINT) r.sequence = mf.value as number;
        else if (mf.field === 3 && mf.wire === WIRE_VARINT) r.statusCode = mf.value as number;
        else if (mf.field === 4 && mf.wire === WIRE_LEN) r.message = new TextDecoder().decode(mf.value as Uint8Array);
      }
    } else if (f.field === 2 && f.wire === WIRE_VARINT) r.event = f.value as number;
    else if (f.field === 4 && f.wire === WIRE_LEN) r.text = new TextDecoder().decode(f.value as Uint8Array);
  }
  return r;
}

// Detect if text contains Chinese characters
function containsChinese(text: string): boolean {
  return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(text);
}

function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ── Main server ──
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const appId = Deno.env.get("VOLCENGINE_APP_ID");
  const accessKey = Deno.env.get("VOLCENGINE_ACCESS_KEY");
  if (!appId || !accessKey) {
    return new Response(JSON.stringify({ error: "Missing credentials" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  if ((req.headers.get("upgrade") || "").toLowerCase() !== "websocket") {
    return new Response(JSON.stringify({ error: "WebSocket upgrade required" }), { status: 426, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const url = new URL(req.url);
  const sourceLang = url.searchParams.get("source") || "zh";
  const targetLang = url.searchParams.get("target") || "en";

  const { socket: clientSocket, response } = Deno.upgradeWebSocket(req);
  const connectId = generateUUID();
  const sessionId = generateUUID();

  let volcSocket: any = null;
  let sessionStarted = false;
  let currentSrcText = "";
  let currentTgtText = "";

  clientSocket.onopen = () => {
    console.log("[VolcProxy] Client connected, opening Volcengine WSS…");

    volcSocket = new WS(VOLC_WS_ENDPOINT, {
      headers: {
        "X-Api-App-Key": appId, "X-Api-Access-Key": accessKey,
        "X-Api-Resource-Id": VOLC_RESOURCE_ID, "X-Api-Connect-Id": connectId,
      },
    });

    volcSocket.on("open", () => {
      console.log(`[VolcProxy] Connected, StartSession source=${sourceLang} target=${targetLang}`);
      volcSocket.send(buildStartSession(sessionId, sourceLang, targetLang));
    });

    volcSocket.on("message", (data: Buffer | Uint8Array) => {
      try {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        const resp = parseResponse(bytes);

        if (resp.event === EVT_SESSION_STARTED) {
          sessionStarted = true;
          clientSocket.send(JSON.stringify({ type: "ready" }));
          console.log("[VolcProxy] Session started ✓");

        } else if (resp.event === EVT_SESSION_FAILED) {
          console.error(`[VolcProxy] Failed: ${resp.statusCode} ${resp.message}`);
          clientSocket.send(JSON.stringify({ type: "error", message: `${resp.statusCode}: ${resp.message}` }));

        } else if (resp.event === EVT_SESSION_FINISHED) {
          console.log("[VolcProxy] Session finished");
          try { clientSocket.close(1000); } catch {}

        } else if (resp.event === EVT_USAGE_RESPONSE || resp.event === EVT_AUDIO_MUTED) {
          // skip

        } else if (resp.event === EVT_SRC_SUBTITLE_START) {
          if (resp.sequence > 0) { currentSrcText = ""; currentTgtText = ""; }

        } else if (resp.event === EVT_SRC_SUBTITLE_RESP) {
          currentSrcText += resp.text;
          clientSocket.send(JSON.stringify({
            type: "partial", text: currentSrcText, sequence: resp.sequence,
          }));

        } else if (resp.event === EVT_SRC_SUBTITLE_END) {
          currentSrcText = resp.text || currentSrcText;
          // Detect language of source text
          const detectedLang = containsChinese(currentSrcText) ? "zh" : "en";
          clientSocket.send(JSON.stringify({
            type: "final", text: currentSrcText, sequence: resp.sequence,
            detected_lang: detectedLang,
          }));

        } else if (resp.event === EVT_TGT_SUBTITLE_RESP) {
          currentTgtText += resp.text;
          clientSocket.send(JSON.stringify({
            type: "translation_partial", translation: currentTgtText, sequence: resp.sequence,
          }));

        } else if (resp.event === EVT_TGT_SUBTITLE_END) {
          currentTgtText = resp.text || currentTgtText;
          clientSocket.send(JSON.stringify({
            type: "translation_final", translation: currentTgtText, sequence: resp.sequence,
          }));
        }
      } catch (e) {
        console.error("[VolcProxy] Parse error:", e);
      }
    });

    volcSocket.on("error", (err: Error) => {
      console.error("[VolcProxy] Error:", err.message);
      try { clientSocket.send(JSON.stringify({ type: "error", message: err.message })); } catch {}
    });

    volcSocket.on("close", (code: number, reason: Buffer) => {
      console.log(`[VolcProxy] Volcengine closed: ${code}`);
      try { clientSocket.close(code || 1000); } catch {}
    });
  };

  clientSocket.onmessage = (event: MessageEvent) => {
    if (!sessionStarted || !volcSocket) return;
    try {
      if (typeof event.data === "string") {
        const msg = JSON.parse(event.data);
        if (msg.type === "audio_end") {
          volcSocket.send(buildFinishSession(sessionId));
          return;
        }
      }
    } catch {}

    let audioData: Uint8Array;
    if (event.data instanceof ArrayBuffer) audioData = new Uint8Array(event.data);
    else if (event.data instanceof Uint8Array) audioData = event.data;
    else return;

    volcSocket.send(buildTaskRequest(sessionId, audioData));
  };

  clientSocket.onclose = () => {
    console.log("[VolcProxy] Client disconnected");
    if (volcSocket?.readyState === WS.OPEN) {
      try { volcSocket.send(buildFinishSession(sessionId)); } catch {}
      setTimeout(() => { try { volcSocket.close(1000); } catch {} }, 500);
    }
  };

  clientSocket.onerror = () => { if (volcSocket) try { volcSocket.close(1000); } catch {} };

  return response;
});
