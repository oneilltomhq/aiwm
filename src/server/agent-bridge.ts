/**
 * Bridges agent events to client sessions.
 *
 * Single agent.subscribe() call — routes events to the correct session(s).
 * Eliminates the double-delivery bug from the old voice-server.ts.
 *
 * Responsibilities:
 * - Subscribe to agent events once
 * - Route tool_call, response, thinking events to sessions
 * - Collect response text per prompt for TTS
 * - Serialize prompts so concurrent clients don't race
 */
import type { Agent } from "@mariozechner/pi-agent-core";
import type { Session, SessionManager } from "./session.js";
import type { ServerMessage } from "./protocol.js";

export interface PromptResult {
  /** The final text response from the agent (empty if agent only used tools). */
  responseText: string;
}

export class AgentBridge {
  private agent: Agent;
  private sessions: SessionManager;
  private promptQueue: Array<{ resolve: (r: PromptResult) => void; reject: (e: Error) => void; text: string; sessionId: string }>;
  private processing = false;
  private unsubscribeAgent: (() => void) | null = null;

  /** The session ID currently being processed (whose prompt is running). */
  private activeSessionId: string | null = null;
  /** Accumulated response text for the current prompt. */
  private activeResponseText = "";

  constructor(agent: Agent, sessions: SessionManager) {
    this.agent = agent;
    this.sessions = sessions;
    this.promptQueue = [];
    this.subscribeToAgent();
  }

  /**
   * Queue a prompt from a session. Returns when the agent finishes.
   * Prompts are serialized — only one runs at a time.
   */
  prompt(text: string, sessionId: string): Promise<PromptResult> {
    return new Promise((resolve, reject) => {
      this.promptQueue.push({ resolve, reject, text, sessionId });
      this.processNext();
    });
  }

  /** Broadcast a message to all active sessions. */
  broadcast(msg: ServerMessage): void {
    for (const session of this.sessions.active()) {
      session.sender.send(msg);
    }
  }

  /** Send a message to a specific session. */
  sendTo(sessionId: string, msg: ServerMessage): void {
    this.sessions.get(sessionId)?.sender.send(msg);
  }

  /** Clean up the agent subscription. */
  destroy(): void {
    this.unsubscribeAgent?.();
    this.unsubscribeAgent = null;
  }

  private subscribeToAgent(): void {
    this.unsubscribeAgent = this.agent.subscribe((event) => {
      switch (event.type) {
        case "tool_execution_start":
          this.broadcast({
            type: "tool_call",
            name: event.toolName,
            args: event.args as Record<string, unknown>,
          });
          break;

        case "message_end": {
          const msg = event.message as any;
          if (msg.role === "assistant" && msg.content) {
            for (const block of msg.content) {
              if (block.type === "text" && block.text) {
                // Accumulate for the prompt result
                this.activeResponseText = block.text;
                // Broadcast to all sessions
                this.broadcast({ type: "response", text: block.text });
              }
            }
          }
          break;
        }
      }
    });
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.promptQueue.length === 0) return;
    this.processing = true;

    const item = this.promptQueue.shift()!;
    this.activeSessionId = item.sessionId;
    this.activeResponseText = "";

    try {
      await this.agent.prompt(item.text);
      item.resolve({ responseText: this.activeResponseText });
    } catch (err: any) {
      item.reject(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.activeSessionId = null;
      this.activeResponseText = "";
      this.processing = false;
      // Process next in queue
      this.processNext();
    }
  }
}
