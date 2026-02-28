/**
 * Deepgram streaming STT (speech-to-text) via WebSocket.
 * Receives raw audio from the client, streams it to Deepgram, returns transcripts.
 */
import WebSocket from "ws";

const DEEPGRAM_API_URL = "wss://api.deepgram.com/v1/listen";

export interface TranscriptEvent {
  text: string;
  isFinal: boolean;
  confidence: number;
  speechFinal: boolean; // end of utterance (user stopped speaking)
}

export interface DeepgramStreamOptions {
  apiKey: string;
  model?: string;
  language?: string;
  encoding?: string;
  sampleRate?: number;
  channels?: number;
  interimResults?: boolean;
  utteranceEndMs?: number;
  vadEvents?: boolean;
  endpointing?: number;
}

/**
 * Create a streaming STT session with Deepgram.
 * Returns an object to send audio data and receive transcript events.
 */
export function createDeepgramStream(opts: DeepgramStreamOptions) {
  const params = new URLSearchParams({
    model: opts.model ?? "nova-3",
    language: opts.language ?? "en",
    encoding: opts.encoding ?? "linear16",
    sample_rate: String(opts.sampleRate ?? 16000),
    channels: String(opts.channels ?? 1),
    interim_results: String(opts.interimResults ?? true),
    utterance_end_ms: String(opts.utteranceEndMs ?? 1000),
    vad_events: String(opts.vadEvents ?? true),
    endpointing: String(opts.endpointing ?? 300),
    punctuate: "true",
    smart_format: "true",
  });

  const url = `${DEEPGRAM_API_URL}?${params}`;
  const ws = new WebSocket(url, {
    headers: { Authorization: `Token ${opts.apiKey}` },
  });

  let onTranscript: ((event: TranscriptEvent) => void) | null = null;
  let onError: ((err: Error) => void) | null = null;
  let onClose: (() => void) | null = null;
  let onOpen: (() => void) | null = null;
  let isOpen = false;

  ws.on("open", () => {
    isOpen = true;
    console.log("[deepgram] WebSocket connected");
    onOpen?.();
  });

  ws.on("message", (data: WebSocket.Data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "Results") {
        const alt = msg.channel?.alternatives?.[0];
        if (alt && alt.transcript) {
          onTranscript?.({
            text: alt.transcript,
            isFinal: msg.is_final ?? false,
            confidence: alt.confidence ?? 0,
            speechFinal: msg.speech_final ?? false,
          });
        }
      } else if (msg.type === "UtteranceEnd") {
        // Deepgram signals end of utterance
        onTranscript?.({
          text: "",
          isFinal: true,
          confidence: 1,
          speechFinal: true,
        });
      }
    } catch (err) {
      console.error("[deepgram] Failed to parse message:", err);
    }
  });

  ws.on("error", (err) => {
    console.error("[deepgram] WebSocket error:", err.message);
    onError?.(err);
  });

  ws.on("close", (code, reason) => {
    isOpen = false;
    console.log(`[deepgram] WebSocket closed (code=${code}, reason=${reason?.toString() || 'none'})`);
    onClose?.();
  });

  return {
    /** Send raw audio data (Buffer) to Deepgram */
    sendAudio(audio: Buffer) {
      if (isOpen && ws.readyState === WebSocket.OPEN) {
        ws.send(audio);
      }
    },

    /** Close the Deepgram connection */
    close() {
      if (ws.readyState === WebSocket.OPEN) {
        // Send close message per Deepgram protocol
        ws.send(JSON.stringify({ type: "CloseStream" }));
        setTimeout(() => ws.close(), 500);
      }
    },

    get connected() { return isOpen; },

    /** Event handlers */
    set onTranscript(fn: (event: TranscriptEvent) => void) { onTranscript = fn; },
    set onError(fn: (err: Error) => void) { onError = fn; },
    set onClose(fn: () => void) { onClose = fn; },
    get onCloseHandler() { return onClose; },
    set onOpen(fn: () => void) { onOpen = fn; },
  };
}
