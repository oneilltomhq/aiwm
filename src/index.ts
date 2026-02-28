/**
 * AIWM — AI-driven Window Manager
 *
 * Entry point: creates the agent, session manager, agent bridge,
 * HTTP server, and WebSocket server. Wires them together.
 */
import "dotenv/config";
import * as readline from "readline";
import { join } from "path";
import { createAgent } from "./agent.js";
import { SessionManager } from "./server/session.js";
import { AgentBridge } from "./server/agent-bridge.js";
import { createHttpServer } from "./server/http.js";
import { setupWebSocketServer } from "./server/ws.js";
import { VOICES } from "./elevenlabs.js";

const PORT = 8080;

async function main() {
  // --- Core ---
  const agent = createAgent();
  const sessions = new SessionManager();
  const agentBridge = new AgentBridge(agent, sessions);

  // --- Voice config ---
  const deepgramApiKey = process.env.DEEPGRAM_API_KEY ?? "";
  const elevenlabsApiKey = process.env.ELEVENLABS_API_KEY ?? "";
  const elevenlabsVoiceId = process.env.ELEVENLABS_VOICE_ID ?? VOICES.charlie;

  if (!deepgramApiKey) console.warn("[aiwm] No DEEPGRAM_API_KEY — STT disabled");
  if (!elevenlabsApiKey) console.warn("[aiwm] No ELEVENLABS_API_KEY — TTS disabled");

  // --- HTTP + WebSocket servers ---
  const clientDir = join(import.meta.dirname ?? ".", "..", "client");
  const httpServer = createHttpServer(clientDir);

  setupWebSocketServer({
    httpServer,
    sessions,
    agentBridge,
    voiceConfig: {
      deepgramApiKey,
      elevenlabsApiKey,
      elevenlabsVoiceId,
    },
  });

  httpServer.listen(PORT, () => {
    console.log(`[aiwm] Server listening on port ${PORT}`);
    console.log(`[aiwm] Web client: http://localhost:${PORT}`);
  });

  // --- REPL (for local terminal use) ---
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("\n=== AIWM — AI Window Manager ===");
  console.log("Type messages to control your workspace.");
  console.log(`Web client: http://localhost:${PORT}\n`);

  const prompt = () => {
    rl.question("you> ", async (input) => {
      if (!input.trim()) { prompt(); return; }
      if (input.trim() === "quit" || input.trim() === "exit") {
        rl.close();
        process.exit(0);
      }
      try {
        await agent.prompt(input);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
      }
      prompt();
    });
  };

  rl.on("close", () => {
    agent.waitForIdle().then(() => process.exit(0)).catch(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000);
  });

  prompt();
}

main().catch(console.error);
