/**
 * WebSocket server: upgrade routing + message handling.
 *
 * Routes /vnc upgrades to the VNC proxy.
 * Routes all other upgrades to the chat/voice WebSocket server.
 * Wires incoming messages to session + agent-bridge + voice.
 */
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type { Server as HttpServer } from "http";
import type { Socket } from "net";
import { proxyVncWebSocket } from "./vnc-proxy.js";
import { parseClientMessage } from "./protocol.js";
import { SessionManager } from "./session.js";
import { AgentBridge } from "./agent-bridge.js";
import { startVoiceSession, sendTtsToSession, type VoiceConfig, type VoiceSession } from "./voice.js";
import type { ServerMessage } from "./protocol.js";

export interface WsServerConfig {
  httpServer: HttpServer;
  sessions: SessionManager;
  agentBridge: AgentBridge;
  voiceConfig: VoiceConfig;
}

export function setupWebSocketServer(config: WsServerConfig) {
  const { httpServer, sessions, agentBridge, voiceConfig } = config;
  const wss = new WebSocketServer({ noServer: true });

  // Track voice sessions per session ID
  const voiceSessions = new Map<string, VoiceSession>();

  // Handle HTTP upgrade: route /vnc to proxy, everything else to chat/voice
  httpServer.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const pathname = (req.url ?? "/").split("?")[0];

    if (pathname === "/vnc") {
      proxyVncWebSocket(req, socket, head);
    } else {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    }
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    console.log(`[ws] Client connected from ${req.socket.remoteAddress}`);

    // Create a session with a sender that wraps this WebSocket
    const sender = {
      send(msg: ServerMessage): boolean {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(msg));
          return true;
        }
        return false;
      },
      isOpen(): boolean {
        return ws.readyState === WebSocket.OPEN;
      },
    };

    const session = sessions.create(sender);
    console.log(`[ws] Session created: ${session.id}`);

    // Welcome message
    sender.send({
      type: "response",
      text: "Connected to AIWM. " +
        (voiceConfig.deepgramApiKey ? "Voice input ready." : "Voice input disabled (no API key).") +
        " " +
        (voiceConfig.elevenlabsApiKey ? "Voice output ready." : "Voice output disabled (no API key)."),
    });

    ws.on("message", async (data: Buffer) => {
      const msg = parseClientMessage(data);
      if (!msg) {
        sender.send({ type: "error", message: "Invalid message" });
        return;
      }

      try {
        switch (msg.type) {
          case "voice_start": {
            console.log(`[ws:${session.id}] voice_start`);
            session.voiceActive = true;
            if (voiceConfig.deepgramApiKey) {
              // Clean up any existing voice session
              const existing = voiceSessions.get(session.id);
              if (existing?.active) await existing.stop();
              voiceSessions.set(session.id, startVoiceSession(session, voiceConfig));
            }
            break;
          }

          case "voice_stop": {
            console.log(`[ws:${session.id}] voice_stop`);
            session.voiceActive = false;
            const vs = voiceSessions.get(session.id);
            if (vs) {
              voiceSessions.delete(session.id);
              const utterance = await vs.stop();
              if (utterance) {
                console.log(`[ws:${session.id}] Utterance: "${utterance}"`);
                sender.send({ type: "user_message", text: utterance });
                sender.send({ type: "thinking" });
                try {
                  const result = await agentBridge.prompt(utterance, session.id);
                  if (result.responseText && voiceConfig.elevenlabsApiKey) {
                    await sendTtsToSession(session, result.responseText, voiceConfig);
                  } else if (!result.responseText) {
                    sender.send({ type: "thinking_done" });
                  }
                } catch (err: any) {
                  sender.send({ type: "error", message: `Agent error: ${err.message}` });
                }
              }
            }
            break;
          }

          case "audio": {
            const vs = voiceSessions.get(session.id);
            if (vs) {
              vs.sendAudio(Buffer.from(msg.data, "base64"));
            }
            break;
          }

          case "text": {
            sender.send({ type: "user_message", text: msg.text });
            sender.send({ type: "thinking" });
            try {
              const result = await agentBridge.prompt(msg.text, session.id);
              if (result.responseText && voiceConfig.elevenlabsApiKey) {
                await sendTtsToSession(session, result.responseText, voiceConfig);
              } else if (!result.responseText) {
                sender.send({ type: "thinking_done" });
              }
            } catch (err: any) {
              sender.send({ type: "error", message: `Agent error: ${err.message}` });
            }
            break;
          }

          case "viewport": {
            session.viewport = { width: msg.width, height: msg.height };
            console.log(`[ws:${session.id}] Viewport: ${msg.width}x${msg.height}`);
            break;
          }
        }
      } catch (err: any) {
        console.error(`[ws:${session.id}] Error:`, err.message);
        sender.send({ type: "error", message: err.message });
      }
    });

    ws.on("close", () => {
      console.log(`[ws] Session ${session.id} disconnected`);
      // Clean up voice session
      const vs = voiceSessions.get(session.id);
      if (vs?.active) vs.stop();
      voiceSessions.delete(session.id);
      sessions.destroy(session.id);
    });

    ws.on("error", (err) => {
      console.error(`[ws:${session.id}] Error:`, err.message);
    });
  });

  return wss;
}
