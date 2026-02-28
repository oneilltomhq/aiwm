import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session, SessionSender } from "./session.js";
import type { ServerMessage } from "./protocol.js";

// We test the voice module by mocking deepgram. Since voice.ts imports
// deepgram at module level, we mock the module.
vi.mock("../deepgram.js", () => {
  return {
    createDeepgramStream: vi.fn(),
  };
});

vi.mock("../elevenlabs.js", () => {
  return {
    textToSpeechStream: vi.fn(),
    VOICES: { charlie: "test-voice-id" },
  };
});

import { startVoiceSession, sendTtsToSession } from "./voice.js";
import { createDeepgramStream } from "../deepgram.js";
import { textToSpeechStream } from "../elevenlabs.js";

function createMockSession(): Session & { messages: ServerMessage[] } {
  const messages: ServerMessage[] = [];
  return {
    id: "test-session",
    role: "driver" as const,
    viewport: { width: 1920, height: 1080 },
    voiceActive: false,
    createdAt: Date.now(),
    messages,
    sender: {
      send(msg: ServerMessage) { messages.push(msg); return true; },
      isOpen() { return true; },
    },
  };
}

function createMockDeepgramStream() {
  let onTranscript: ((e: any) => void) | null = null;
  let onOpen: (() => void) | null = null;
  let onError: ((e: Error) => void) | null = null;
  let onClose: (() => void) | null = null;
  let closed = false;
  const audioReceived: Buffer[] = [];

  return {
    get connected() { return !closed; },
    sendAudio(audio: Buffer) { audioReceived.push(audio); },
    close() {
      closed = true;
      // Simulate async close
      setTimeout(() => onClose?.(), 10);
    },
    set onTranscript(fn: (e: any) => void) { onTranscript = fn; },
    set onOpen(fn: () => void) { onOpen = fn; },
    set onError(fn: (e: Error) => void) { onError = fn; },
    set onClose(fn: () => void) { onClose = fn; },
    get onCloseHandler() { return onClose; },
    // Test helpers
    _emitTranscript(e: any) { onTranscript?.(e); },
    _emitOpen() { onOpen?.(); },
    _emitError(e: Error) { onError?.(e); },
    _emitClose() { onClose?.(); },
    _audioReceived: audioReceived,
    get _closed() { return closed; },
  };
}

describe("startVoiceSession", () => {
  let mockStream: ReturnType<typeof createMockDeepgramStream>;

  beforeEach(() => {
    mockStream = createMockDeepgramStream();
    vi.mocked(createDeepgramStream).mockReturnValue(mockStream as any);
  });

  it("creates a voice session and sends audio to Deepgram", () => {
    const session = createMockSession();
    const vs = startVoiceSession(session, {
      deepgramApiKey: "test-key",
      elevenlabsApiKey: "test-key",
    });

    expect(vs.active).toBe(true);
    vs.sendAudio(Buffer.from([1, 2, 3]));
    expect(mockStream._audioReceived).toHaveLength(1);
  });

  it("buffers audio before Deepgram connects, flushes on open", () => {
    // Make stream appear not connected initially
    const stream = createMockDeepgramStream();
    // Override connected to return false initially
    let isConnected = false;
    Object.defineProperty(stream, "connected", { get: () => isConnected });
    vi.mocked(createDeepgramStream).mockReturnValue(stream as any);

    const session = createMockSession();
    const vs = startVoiceSession(session, {
      deepgramApiKey: "test-key",
      elevenlabsApiKey: "test-key",
    });

    vs.sendAudio(Buffer.from([1, 2]));
    vs.sendAudio(Buffer.from([3, 4]));
    expect(stream._audioReceived).toHaveLength(0); // buffered, not sent

    // Simulate connection
    isConnected = true;
    stream._emitOpen();
    expect(stream._audioReceived).toHaveLength(2); // flushed
  });

  it("forwards transcripts to session", () => {
    const session = createMockSession();
    startVoiceSession(session, {
      deepgramApiKey: "test-key",
      elevenlabsApiKey: "test-key",
    });

    mockStream._emitTranscript({ text: "hello", isFinal: false, confidence: 0.9, speechFinal: false });
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]).toEqual({ type: "transcript", text: "hello", isFinal: false });
  });

  it("accumulates final transcripts and returns on stop", async () => {
    const session = createMockSession();
    const vs = startVoiceSession(session, {
      deepgramApiKey: "test-key",
      elevenlabsApiKey: "test-key",
    });

    mockStream._emitTranscript({ text: "hello", isFinal: true, confidence: 0.9, speechFinal: false });
    mockStream._emitTranscript({ text: "world", isFinal: true, confidence: 0.9, speechFinal: true });

    const text = await vs.stop();
    expect(text).toBe("hello world");
    expect(vs.active).toBe(false);
  });

  it("stop is idempotent", async () => {
    const session = createMockSession();
    const vs = startVoiceSession(session, {
      deepgramApiKey: "test-key",
      elevenlabsApiKey: "test-key",
    });

    mockStream._emitTranscript({ text: "test", isFinal: true, confidence: 0.9, speechFinal: true });

    const text1 = await vs.stop();
    const text2 = await vs.stop();
    expect(text1).toBe("test");
    expect(text2).toBe("test");
  });

  it("sends error to session on Deepgram error", () => {
    const session = createMockSession();
    startVoiceSession(session, {
      deepgramApiKey: "test-key",
      elevenlabsApiKey: "test-key",
    });

    mockStream._emitError(new Error("connection failed"));
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]).toEqual({ type: "error", message: "STT error: connection failed" });
  });

  it("does not send audio after stop", async () => {
    const session = createMockSession();
    const vs = startVoiceSession(session, {
      deepgramApiKey: "test-key",
      elevenlabsApiKey: "test-key",
    });

    await vs.stop();
    const countBefore = mockStream._audioReceived.length;
    vs.sendAudio(Buffer.from([5, 6]));
    expect(mockStream._audioReceived.length).toBe(countBefore);
  });
});

describe("sendTtsToSession", () => {
  it("sends tts_start, audio chunks, and audio_end", async () => {
    const session = createMockSession();

    vi.mocked(textToSpeechStream).mockImplementation(
      async (_text: string, _opts: any, onChunk: (chunk: Buffer) => void) => {
        onChunk(Buffer.from("chunk1"));
        onChunk(Buffer.from("chunk2"));
      }
    );

    await sendTtsToSession(session, "hello", {
      deepgramApiKey: "test",
      elevenlabsApiKey: "test-eleven-key",
    });

    expect(session.messages.map(m => m.type)).toEqual(["tts_start", "audio", "audio", "audio_end"]);
  });

  it("skips TTS when no API key", async () => {
    const session = createMockSession();
    await sendTtsToSession(session, "hello", {
      deepgramApiKey: "test",
      elevenlabsApiKey: "",
    });
    expect(session.messages).toHaveLength(0);
  });

  it("skips TTS when no text", async () => {
    const session = createMockSession();
    await sendTtsToSession(session, "", {
      deepgramApiKey: "test",
      elevenlabsApiKey: "test-key",
    });
    expect(session.messages).toHaveLength(0);
  });

  it("sends error on TTS failure", async () => {
    const session = createMockSession();
    vi.mocked(textToSpeechStream).mockRejectedValue(new Error("TTS broke"));

    await sendTtsToSession(session, "hello", {
      deepgramApiKey: "test",
      elevenlabsApiKey: "test-key",
    });

    const types = session.messages.map(m => m.type);
    expect(types).toContain("tts_start");
    expect(types).toContain("error");
  });
});
