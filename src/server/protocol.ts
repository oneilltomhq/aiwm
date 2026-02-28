/**
 * WebSocket protocol types shared between server and client.
 *
 * All messages are JSON-encoded. Each has a `type` discriminator.
 */

// ── Client → Server ──────────────────────────────────────────────

export interface AudioMessage {
  type: "audio";
  /** Base64-encoded PCM audio (16-bit LE, 16kHz, mono) */
  data: string;
}

export interface TextMessage {
  type: "text";
  text: string;
}

export interface ViewportMessage {
  type: "viewport";
  width: number;
  height: number;
}

export interface VoiceStartMessage {
  type: "voice_start";
}

export interface VoiceStopMessage {
  type: "voice_stop";
}

export type ClientMessage =
  | AudioMessage
  | TextMessage
  | ViewportMessage
  | VoiceStartMessage
  | VoiceStopMessage;

// ── Server → Client ──────────────────────────────────────────────

export interface TranscriptResponse {
  type: "transcript";
  text: string;
  isFinal: boolean;
}

export interface ResponseMessage {
  type: "response";
  text: string;
}

export interface UserMessageEcho {
  type: "user_message";
  text: string;
}

export interface AudioResponse {
  type: "audio";
  /** Base64-encoded mp3 audio */
  data: string;
}

export interface AudioEndResponse {
  type: "audio_end";
}

export interface TtsStartResponse {
  type: "tts_start";
}

export interface ToolCallResponse {
  type: "tool_call";
  name: string;
  args: Record<string, unknown>;
}

export interface ThinkingResponse {
  type: "thinking";
}

export interface ThinkingDoneResponse {
  type: "thinking_done";
}

export interface ErrorResponse {
  type: "error";
  message: string;
}

export type ServerMessage =
  | TranscriptResponse
  | ResponseMessage
  | UserMessageEcho
  | AudioResponse
  | AudioEndResponse
  | TtsStartResponse
  | ToolCallResponse
  | ThinkingResponse
  | ThinkingDoneResponse
  | ErrorResponse;

// ── Parsing & validation ─────────────────────────────────────────

const CLIENT_MESSAGE_TYPES = new Set<ClientMessage["type"]>([
  "audio", "text", "viewport", "voice_start", "voice_stop",
]);

/**
 * Parse a raw WebSocket message into a typed ClientMessage.
 * Returns null if invalid.
 */
export function parseClientMessage(raw: string | Buffer): ClientMessage | null {
  try {
    const data = typeof raw === "string" ? raw : raw.toString();
    const msg = JSON.parse(data);
    if (!msg || typeof msg !== "object" || !CLIENT_MESSAGE_TYPES.has(msg.type)) {
      return null;
    }
    // Validate required fields per type
    switch (msg.type) {
      case "audio":
        if (typeof msg.data !== "string") return null;
        break;
      case "text":
        if (typeof msg.text !== "string" || !msg.text.trim()) return null;
        break;
      case "viewport":
        if (typeof msg.width !== "number" || typeof msg.height !== "number") return null;
        if (msg.width <= 0 || msg.height <= 0) return null;
        break;
      case "voice_start":
      case "voice_stop":
        break;
    }
    return msg as ClientMessage;
  } catch {
    return null;
  }
}

/** Serialize a server message to JSON string. */
export function serializeServerMessage(msg: ServerMessage): string {
  return JSON.stringify(msg);
}
