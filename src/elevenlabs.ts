/**
 * ElevenLabs TTS (text-to-speech) via streaming REST API.
 * Converts agent response text to speech audio.
 */

const ELEVENLABS_API_URL = "https://api.elevenlabs.io";

// Good default voices
export const VOICES = {
  rachel: "21m00Tcm4TlvDq8ikWAM",   // calm, narration
  drew: "29vD33N1CtxCmqQRPOHJ",      // male, conversational
  clyde: "2EiwWnXFnvU5JabPnv8n",     // male, deep
  dave: "CYw3kZ02Hs0563khs1Fj",      // male, conversational
  dorothy: "ThT5KcBeYPX3keUQqHPh",   // female, pleasant
  elli: "MF3mGyEYCl7XYWbV9V6O",      // female, young
  sarah: "EXAVITQu4vr4xnSDxMaL",     // female, soft/news
  charlie: "IKne3meq5aSn9XLyUdCD",   // male, conversational, Australian
  james: "ZQe5CZNOzWyzPSCn5a3c",     // male, calm, authoritative
  aria: "9BWtsMINqrJLrRacOk9x",      // female, expressive
} as const;

export interface TTSOptions {
  apiKey: string;
  voiceId?: string;
  modelId?: string;
  outputFormat?: string;
  stability?: number;
  similarityBoost?: number;
  style?: number;
}

/**
 * Convert text to speech, returning audio as a Buffer.
 * Uses the streaming endpoint for low latency.
 */
export async function textToSpeech(
  text: string,
  opts: TTSOptions,
): Promise<Buffer> {
  const voiceId = opts.voiceId ?? VOICES.charlie;
  const url = `${ELEVENLABS_API_URL}/v1/text-to-speech/${voiceId}/stream`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": opts.apiKey,
    },
    body: JSON.stringify({
      text,
      model_id: opts.modelId ?? "eleven_turbo_v2_5",
      output_format: opts.outputFormat ?? "mp3_44100_128",
      voice_settings: {
        stability: opts.stability ?? 0.5,
        similarity_boost: opts.similarityBoost ?? 0.75,
        style: opts.style ?? 0,
      },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`ElevenLabs TTS error ${response.status}: ${errText}`);
  }

  // Collect the streaming response into a buffer
  const chunks: Uint8Array[] = [];
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  return Buffer.concat(chunks);
}

/**
 * Stream TTS audio in chunks, calling onChunk for each piece.
 * Lower latency than waiting for the full audio.
 */
export async function textToSpeechStream(
  text: string,
  opts: TTSOptions,
  onChunk: (chunk: Buffer) => void,
): Promise<void> {
  const voiceId = opts.voiceId ?? VOICES.charlie;
  const url = `${ELEVENLABS_API_URL}/v1/text-to-speech/${voiceId}/stream`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": opts.apiKey,
    },
    body: JSON.stringify({
      text,
      model_id: opts.modelId ?? "eleven_turbo_v2_5",
      output_format: opts.outputFormat ?? "mp3_44100_128",
      voice_settings: {
        stability: opts.stability ?? 0.5,
        similarity_boost: opts.similarityBoost ?? 0.75,
        style: opts.style ?? 0,
      },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`ElevenLabs TTS error ${response.status}: ${errText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk(Buffer.from(value));
  }
}
