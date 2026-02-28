/**
 * Voice session management: STT (Deepgram) + TTS (ElevenLabs) per session.
 *
 * Manages the lifecycle of a voice session:
 *   voice_start → stream audio → voice_stop → drain final transcripts → return utterance
 */
import { createDeepgramStream, type TranscriptEvent } from "../deepgram.js";
import { textToSpeechStream, VOICES } from "../elevenlabs.js";
import type { Session } from "./session.js";

export interface VoiceConfig {
  deepgramApiKey: string;
  elevenlabsApiKey: string;
  elevenlabsVoiceId?: string;
}

export interface VoiceSession {
  /** Feed raw audio (PCM 16-bit LE, 16kHz, mono) to Deepgram. */
  sendAudio(audio: Buffer): void;
  /** Signal end of voice input. Returns the complete utterance text. */
  stop(): Promise<string>;
  /** Whether a Deepgram stream is active. */
  readonly active: boolean;
}

/**
 * Start a voice session: opens a Deepgram stream, buffers audio,
 * sends transcripts to the session's client.
 */
export function startVoiceSession(
  session: Session,
  config: VoiceConfig,
): VoiceSession {
  let utteranceBuffer = "";
  let audioBuffer: Buffer[] = [];
  let active = true;

  const stream = createDeepgramStream({
    apiKey: config.deepgramApiKey,
    encoding: "linear16",
    sampleRate: 16000,
    channels: 1,
    interimResults: true,
    utteranceEndMs: 1000,
    endpointing: 300,
  });

  stream.onTranscript = (event: TranscriptEvent) => {
    session.sender.send({
      type: "transcript",
      text: event.text,
      isFinal: event.isFinal,
    });
    if (event.isFinal && event.text) {
      utteranceBuffer += (utteranceBuffer ? " " : "") + event.text;
    }
  };

  stream.onOpen = () => {
    // Flush buffered audio
    if (audioBuffer.length > 0) {
      for (const chunk of audioBuffer) {
        stream.sendAudio(chunk);
      }
      audioBuffer = [];
    }
  };

  stream.onError = (err: Error) => {
    console.error(`[voice:${session.id}] Deepgram error:`, err.message);
    session.sender.send({ type: "error", message: `STT error: ${err.message}` });
  };

  return {
    sendAudio(audio: Buffer) {
      if (!active) return;
      if (stream.connected) {
        stream.sendAudio(audio);
      } else {
        audioBuffer.push(audio);
      }
    },

    async stop(): Promise<string> {
      if (!active) return utteranceBuffer.trim();
      active = false;
      audioBuffer = [];

      // Wait for Deepgram to drain final transcripts
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          console.log(`[voice:${session.id}] Deepgram drain timeout`);
          resolve();
        }, 3000);

        const origOnClose = stream.onCloseHandler;
        stream.onClose = () => {
          clearTimeout(timeout);
          origOnClose?.();
          resolve();
        };

        stream.close();
      });

      return utteranceBuffer.trim();
    },

    get active() { return active; },
  };
}

/**
 * Stream TTS audio to a session.
 * Sends tts_start, audio chunks, and audio_end messages.
 */
export async function sendTtsToSession(
  session: Session,
  text: string,
  config: VoiceConfig,
): Promise<void> {
  if (!config.elevenlabsApiKey || !text) return;

  const voiceId = config.elevenlabsVoiceId ?? VOICES.charlie;
  session.sender.send({ type: "tts_start" });

  try {
    await textToSpeechStream(text, {
      apiKey: config.elevenlabsApiKey,
      voiceId,
    }, (chunk) => {
      session.sender.send({
        type: "audio",
        data: chunk.toString("base64"),
      });
    });
    session.sender.send({ type: "audio_end" });
  } catch (err: any) {
    console.error(`[voice:${session.id}] TTS error:`, err.message);
    session.sender.send({ type: "error", message: `TTS error: ${err.message}` });
  }
}
