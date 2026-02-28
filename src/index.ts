/**
 * AIWM — AI-driven Window Manager
 * 
 * An orchestrator agent that controls a headless sway compositor,
 * managing workspace layout based on conversation context and viewport.
 */
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel, registerBuiltInApiProviders } from "@mariozechner/pi-ai";
import { allTools } from "./tools.js";
import * as readline from "readline";

// Register built-in providers (Anthropic, OpenAI, etc.)
registerBuiltInApiProviders();

// Get Claude Sonnet model, point at exe.dev gateway
const model = {
  ...getModel("anthropic", "claude-sonnet-4-20250514"),
  baseUrl: "http://169.254.169.254/gateway/llm/anthropic",
};
console.log(`Using model: ${model.id} via ${model.baseUrl}`);

const SYSTEM_PROMPT = `You are AIWM, an AI window manager. You control a workspace compositor (sway) running on a server.

Your job is to:
1. Understand what the user is working on from their messages
2. Spawn, arrange, and manage windows (terminals, browsers) to show them what's relevant
3. Adapt the layout to their viewport (phone vs desktop vs multi-monitor)
4. Run commands, start dev servers, open URLs — and make sure the right output is visible

You have these workspace tools:
- spawn_terminal: Open a terminal, optionally running a command
- spawn_browser: Open a browser to a URL  
- arrange_workspace: Change layout, focus windows, close windows
- set_viewport: Change the display resolution (e.g. when switching devices)
- screenshot_workspace: See what the workspace currently looks like
- list_windows: See all open windows and their positions
- bash: Run any command on the server

Principles:
- Be proactive: if the user mentions a URL, open a browser. If they mention logs, spawn a terminal tailing them.
- Be aware of space: on a small viewport, prefer tabbed layout or a single focused window. On a wide viewport, tile things side by side.
- Keep it clean: close windows that are no longer relevant.
- When you make layout changes, screenshot the result so you can verify it looks right.
- The user can see the workspace via a VNC/streaming client. What you arrange is what they see.

Current viewport info will be provided. Start by listing windows to understand the current state.`;

async function main() {
  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model,
      tools: allTools,
      thinkingLevel: "low",
    },
  });

  // Subscribe to events for live feedback
  agent.subscribe((event) => {
    switch (event.type) {
      case "tool_execution_start":
        console.log(`\n🔧 ${event.toolName}(${JSON.stringify(event.args)})`);
        break;
      case "tool_execution_end":
        const text = event.result?.content?.[0]?.text ?? "";
        console.log(`   → ${text.substring(0, 200)}`);
        break;
      case "message_end":
        // Extract text from assistant message
        const msg = event.message as any;
        if (msg.content) {
          for (const block of msg.content) {
            if (block.type === "text" && block.text) {
              console.log(`\n🤖 ${block.text}`);
            }
          }
        }
        break;
    }
  });

  // Simple REPL
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("\n=== AIWM — AI Window Manager ===");
  console.log("Type messages to control your workspace.\n");

  const prompt = () => {
    rl.question("you> ", async (input) => {
      if (!input.trim()) {
        prompt();
        return;
      }
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
    // Wait for any pending agent work to finish before exiting
    agent.waitForIdle().then(() => process.exit(0)).catch(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000);
  });

  prompt();
}

main().catch(console.error);
