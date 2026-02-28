/**
 * Voice + WebSocket server for AIWM thin clients.
 *
 * Protocol (client → server):
 *   { type: "audio", data: "<base64 PCM>" }   — mic audio chunk
 *   { type: "text", text: "..." }               — typed message
 *   { type: "viewport", width, height }          — viewport report
 *   { type: "voice_start" }                      — user pressed talk button
 *   { type: "voice_stop" }                       — user released talk button
 *
 * Protocol (server → client):
 *   { type: "transcript", text, isFinal }        — STT interim/final transcript
 *   { type: "response", text }                   — agent text response
 *   { type: "audio", data: "<base64 mp3>" }      — TTS audio chunk
 *   { type: "audio_end" }                        — TTS audio finished
 *   { type: "tool_call", name, args }            — agent tool usage (live feedback)
 *   { type: "thinking" }                         — agent is processing
 *   { type: "error", message }                   — error message
 */
import { WebSocketServer, WebSocket, createWebSocketStream } from "ws";
import { IncomingMessage, createServer } from "http";
import { createConnection } from "net";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { createDeepgramStream, type TranscriptEvent } from "./deepgram.js";
import { textToSpeechStream, VOICES } from "./elevenlabs.js";
import { Agent } from "@mariozechner/pi-agent-core";

const PORT = 8080;

export interface VoiceServerConfig {
  deepgramApiKey?: string;
  elevenlabsApiKey?: string;
  elevenlabsVoiceId?: string;
  agent: Agent;
}

interface ClientState {
  ws: WebSocket;
  deepgramStream: ReturnType<typeof createDeepgramStream> | null;
  viewport: { width: number; height: number };
  utteranceBuffer: string;  // accumulates final transcript segments
  isVoiceActive: boolean;
}

const VNC_WS_PORT = 5901;

/**
 * Proxy a WebSocket upgrade request directly to wayvnc's WebSocket on port 5901.
 * This is a raw TCP proxy — we forward the HTTP upgrade request as-is and then
 * pipe data bidirectionally. No WebSocket parsing on our side.
 */
function proxyVncWebSocket(req: IncomingMessage, clientSocket: import("net").Socket, head: Buffer) {
  const upstream = createConnection({ host: "127.0.0.1", port: VNC_WS_PORT }, () => {
    // Reconstruct the HTTP upgrade request to send to wayvnc
    let reqLine = `GET ${req.url ?? "/"} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const key = req.rawHeaders[i];
      const val = req.rawHeaders[i + 1];
      // Rewrite Host header to point to the upstream
      if (key.toLowerCase() === "host") {
        reqLine += `Host: 127.0.0.1:${VNC_WS_PORT}\r\n`;
      } else {
        reqLine += `${key}: ${val}\r\n`;
      }
    }
    reqLine += "\r\n";
    upstream.write(reqLine);
    if (head.length > 0) upstream.write(head);

    // Pipe bidirectionally
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  upstream.on("error", (err) => {
    console.error("[vnc-proxy] Upstream error:", err.message);
    clientSocket.destroy();
  });

  clientSocket.on("error", (err) => {
    console.error("[vnc-proxy] Client socket error:", err.message);
    upstream.destroy();
  });

  clientSocket.on("close", () => upstream.destroy());
  upstream.on("close", () => clientSocket.destroy());
}

export function startVoiceServer(config: VoiceServerConfig) {
  const { agent } = config;
  const deepgramKey = config.deepgramApiKey ?? process.env.DEEPGRAM_API_KEY ?? "";
  const elevenKey = config.elevenlabsApiKey ?? process.env.ELEVENLABS_API_KEY ?? "";
  const voiceId = config.elevenlabsVoiceId ?? process.env.ELEVENLABS_VOICE_ID ?? VOICES.charlie;

  if (!deepgramKey) console.warn("[voice] No DEEPGRAM_API_KEY set — STT disabled");
  if (!elevenKey) console.warn("[voice] No ELEVENLABS_API_KEY set — TTS disabled");

  // HTTP server for serving the web client + noVNC assets
  const httpServer = createServer((req, res) => {
    const clientDir = join(import.meta.dirname ?? ".", "..", "client");

    let filePath: string;
    const urlPath = (req.url ?? "/").split("?")[0]; // strip query params
    if (urlPath === "/" || urlPath === "/index.html") {
      filePath = join(clientDir, "index.html");
    } else {
      // Serve static files from client dir (noVNC core, vendor, etc.)
      // Strip path traversal attempts
      const safePath = urlPath.replace(/\.\.\/|\.\.$/g, "");
      filePath = join(clientDir, safePath);
    }

    if (existsSync(filePath)) {
      const ext = filePath.split(".").pop();
      const contentTypes: Record<string, string> = {
        html: "text/html",
        js: "application/javascript",
        mjs: "application/javascript",
        css: "text/css",
        png: "image/png",
        svg: "image/svg+xml",
        ico: "image/x-icon",
        json: "application/json",
        woff: "font/woff",
        woff2: "font/woff2",
      };
      res.writeHead(200, { "Content-Type": contentTypes[ext ?? "html"] ?? "application/octet-stream" });
      res.end(readFileSync(filePath));
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  // Main WebSocket server handles chat/voice on default path
  const wss = new WebSocketServer({ noServer: true });

  // Handle HTTP upgrade: route /vnc to wayvnc proxy, everything else to chat/voice WSS
  httpServer.on("upgrade", (req: IncomingMessage, socket, head) => {
    const pathname = (req.url ?? "/").split("?")[0];

    if (pathname === "/vnc") {
      // Proxy WebSocket to wayvnc on port 5901
      proxyVncWebSocket(req, socket as any, head as Buffer);
    } else {
      // Chat/voice WebSocket
      wss.handleUpgrade(req, socket as any, head as Buffer, (ws) => {
        wss.emit("connection", ws, req);
      });
    }
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    console.log(`[voice] Client connected from ${req.socket.remoteAddress}`);

    const client: ClientState = {
      ws,
      deepgramStream: null,
      viewport: { width: 1920, height: 1080 },
      utteranceBuffer: "",
      isVoiceActive: false,
    };

    ws.on("message", async (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        await handleClientMessage(client, msg, config, agent, deepgramKey, elevenKey, voiceId);
      } catch (err: any) {
        console.error("[voice] Error handling message:", err.message);
        sendToClient(ws, { type: "error", message: err.message });
      }
    });

    ws.on("close", () => {
      console.log("[voice] Client disconnected");
      client.deepgramStream?.close();
    });

    ws.on("error", (err) => {
      console.error("[voice] WebSocket error:", err.message);
    });

    // Send welcome
    sendToClient(ws, {
      type: "response",
      text: "Connected to AIWM. " +
        (deepgramKey ? "Voice input ready." : "Voice input disabled (no API key).") +
        " " +
        (elevenKey ? "Voice output ready." : "Voice output disabled (no API key)."),
    });
  });

  // Subscribe to agent events for live feedback to all clients.
  // This handles broadcasts for REPL and any other prompt source.
  // processUserInput also captures response text for TTS via its own subscription.
  agent.subscribe((event) => {
    const clients = [...wss.clients].filter(c => c.readyState === WebSocket.OPEN);
    switch (event.type) {
      case "tool_execution_start":
        for (const c of clients) {
          sendToClient(c, { type: "tool_call", name: event.toolName, args: event.args });
        }
        break;
      case "message_end": {
        const msg = event.message as any;
        // Only broadcast assistant messages, not user echoes or tool results
        if (msg.role === "assistant" && msg.content) {
          for (const block of msg.content) {
            if (block.type === "text" && block.text) {
              for (const c of clients) {
                sendToClient(c, { type: "response", text: block.text });
              }
            }
          }
        }
        break;
      }
    }
  });

  httpServer.listen(PORT, () => {
    console.log(`[voice] Server listening on port ${PORT}`);
    console.log(`[voice] Web client: http://localhost:${PORT}`);
  });

  return { httpServer, wss };
}

async function handleClientMessage(
  client: ClientState,
  msg: any,
  config: VoiceServerConfig,
  agent: Agent,
  deepgramKey: string,
  elevenKey: string,
  voiceId: string,
) {
  switch (msg.type) {
    case "voice_start":
      client.isVoiceActive = true;
      client.utteranceBuffer = "";
      if (deepgramKey) {
        startDeepgramSession(client, deepgramKey);
      }
      break;

    case "voice_stop":
      client.isVoiceActive = false;
      // Close Deepgram session
      client.deepgramStream?.close();
      client.deepgramStream = null;
      // Process accumulated utterance
      if (client.utteranceBuffer.trim()) {
        const text = client.utteranceBuffer.trim();
        client.utteranceBuffer = "";
        // Send the final transcript back as a user message so it appears in chat
        sendToClient(client.ws, { type: "user_message", text });
        await processUserInput(client, text, agent, elevenKey, voiceId);
      }
      break;

    case "audio":
      if (client.deepgramStream?.connected && msg.data) {
        const audio = Buffer.from(msg.data, "base64");
        client.deepgramStream.sendAudio(audio);
      }
      break;

    case "text":
      if (msg.text?.trim()) {
        await processUserInput(client, msg.text.trim(), agent, elevenKey, voiceId);
      }
      break;

    case "viewport":
      if (msg.width && msg.height) {
        client.viewport = { width: msg.width, height: msg.height };
        console.log(`[voice] Viewport updated: ${msg.width}x${msg.height}`);
        // TODO: auto-trigger agent viewport adaptation
      }
      break;

    default:
      console.log(`[voice] Unknown message type: ${msg.type}`);
  }
}

function startDeepgramSession(client: ClientState, apiKey: string) {
  // Close any existing session
  client.deepgramStream?.close();

  const stream = createDeepgramStream({
    apiKey,
    encoding: "linear16",
    sampleRate: 16000,
    channels: 1,
    interimResults: true,
    utteranceEndMs: 1000,
    endpointing: 300,
  });

  stream.onTranscript = (event: TranscriptEvent) => {
    // Send transcript to client for display
    sendToClient(client.ws, {
      type: "transcript",
      text: event.text,
      isFinal: event.isFinal,
    });

    // Accumulate final transcript segments
    if (event.isFinal && event.text) {
      client.utteranceBuffer += (client.utteranceBuffer ? " " : "") + event.text;
    }
  };

  stream.onError = (err: Error) => {
    console.error("[voice] Deepgram error:", err.message);
    sendToClient(client.ws, { type: "error", message: `STT error: ${err.message}` });
  };

  client.deepgramStream = stream;
}

async function processUserInput(
  client: ClientState,
  text: string,
  agent: Agent,
  elevenKey: string,
  voiceId: string,
) {
  console.log(`[voice] User: ${text}`);
  sendToClient(client.ws, { type: "thinking" });

  try {
    // Collect agent response text via a temporary event subscription.
    // The global subscription in startVoiceServer handles sending the
    // response text to all clients — this one just captures it for TTS.
    let responseText = "";
    const unsub = agent.subscribe((event) => {
      if (event.type === "message_end") {
        const msg = event.message as any;
        if (msg.role === "assistant" && msg.content) {
          for (const block of msg.content) {
            if (block.type === "text" && block.text) {
              responseText = block.text;
            }
          }
        }
      }
    });

    // Feed text to the agent (returns void, response comes via events)
    await agent.prompt(text);
    unsub();

    if (responseText && elevenKey) {
      // Generate TTS audio
      console.log(`[voice] TTS: generating audio for ${responseText.length} chars`);
      sendToClient(client.ws, { type: "tts_start" });
      try {
        await textToSpeechStream(responseText, {
          apiKey: elevenKey,
          voiceId,
        }, (chunk) => {
          sendToClient(client.ws, {
            type: "audio",
            data: chunk.toString("base64"),
          });
        });
        sendToClient(client.ws, { type: "audio_end" });
        console.log("[voice] TTS: audio sent");
      } catch (ttsErr: any) {
        console.error("[voice] TTS error:", ttsErr.message);
        sendToClient(client.ws, { type: "error", message: `TTS error: ${ttsErr.message}` });
      }
    } else if (!elevenKey) {
      console.log("[voice] TTS: skipped (no API key)");
    } else {
      console.log("[voice] TTS: skipped (no response text)");
    }
  } catch (err: any) {
    console.error("[voice] Agent error:", err.message);
    sendToClient(client.ws, { type: "error", message: `Agent error: ${err.message}` });
  }
}

function sendToClient(ws: WebSocket | globalThis.WebSocket, msg: any) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}
