import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentBridge } from "./agent-bridge.js";
import { SessionManager } from "./session.js";
import type { SessionSender } from "./session.js";
import type { ServerMessage } from "./protocol.js";

// Mock agent: captures subscribe callback, has controllable prompt
function createMockAgent() {
  let subscriber: ((event: any) => void) | null = null;
  let promptResolve: (() => void) | null = null;

  return {
    subscribe(fn: (event: any) => void) {
      subscriber = fn;
      return () => { subscriber = null; };
    },
    prompt(_text: string) {
      return new Promise<void>((resolve) => {
        promptResolve = resolve;
      });
    },
    // Test helpers
    emit(event: any) { subscriber?.(event); },
    completePrompt() { promptResolve?.(); },
    get hasSubscriber() { return subscriber !== null; },
  };
}

function createSender(): SessionSender & { messages: ServerMessage[] } {
  const messages: ServerMessage[] = [];
  return {
    messages,
    send(msg: ServerMessage) { messages.push(msg); return true; },
    isOpen() { return true; },
  };
}

describe("AgentBridge", () => {
  let agent: ReturnType<typeof createMockAgent>;
  let sessions: SessionManager;

  beforeEach(() => {
    agent = createMockAgent();
    sessions = new SessionManager();
  });

  it("subscribes to agent on construction", () => {
    new AgentBridge(agent as any, sessions);
    expect(agent.hasSubscriber).toBe(true);
  });

  it("unsubscribes on destroy", () => {
    const bridge = new AgentBridge(agent as any, sessions);
    bridge.destroy();
    expect(agent.hasSubscriber).toBe(false);
  });

  it("broadcasts tool_call events to all sessions", () => {
    const bridge = new AgentBridge(agent as any, sessions);
    const s1 = createSender();
    const s2 = createSender();
    sessions.create(s1);
    sessions.create(s2);

    agent.emit({ type: "tool_execution_start", toolName: "bash", args: { command: "ls" } });

    expect(s1.messages).toHaveLength(1);
    expect(s1.messages[0]).toEqual({ type: "tool_call", name: "bash", args: { command: "ls" } });
    expect(s2.messages).toHaveLength(1);
    expect(s2.messages[0]).toEqual(s1.messages[0]);
  });

  it("broadcasts response text from message_end", () => {
    const bridge = new AgentBridge(agent as any, sessions);
    const sender = createSender();
    sessions.create(sender);

    agent.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello world" }],
      },
    });

    expect(sender.messages).toHaveLength(1);
    expect(sender.messages[0]).toEqual({ type: "response", text: "hello world" });
  });

  it("ignores non-assistant message_end", () => {
    const bridge = new AgentBridge(agent as any, sessions);
    const sender = createSender();
    sessions.create(sender);

    agent.emit({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "user text" }] },
    });

    expect(sender.messages).toHaveLength(0);
  });

  it("does not send to closed sessions", () => {
    const bridge = new AgentBridge(agent as any, sessions);
    const open = createSender();
    const closed: SessionSender & { messages: ServerMessage[] } = {
      messages: [],
      send(msg) { this.messages.push(msg); return true; },
      isOpen() { return false; },
    };
    sessions.create(open);
    sessions.create(closed);

    agent.emit({ type: "tool_execution_start", toolName: "bash", args: {} });

    expect(open.messages).toHaveLength(1);
    expect(closed.messages).toHaveLength(0);
  });

  it("prompt returns response text", async () => {
    const bridge = new AgentBridge(agent as any, sessions);
    const sender = createSender();
    const session = sessions.create(sender);

    const resultPromise = bridge.prompt("hello", session.id);

    // Simulate agent emitting response then completing
    agent.emit({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "hi back" }] },
    });
    agent.completePrompt();

    const result = await resultPromise;
    expect(result.responseText).toBe("hi back");
  });

  it("prompt returns empty text when agent produces no text", async () => {
    const bridge = new AgentBridge(agent as any, sessions);
    const sender = createSender();
    const session = sessions.create(sender);

    const resultPromise = bridge.prompt("hello", session.id);
    agent.completePrompt();

    const result = await resultPromise;
    expect(result.responseText).toBe("");
  });

  it("serializes concurrent prompts", async () => {
    const agent = createMockAgent();
    const bridge = new AgentBridge(agent as any, sessions);
    const sender = createSender();
    const session = sessions.create(sender);

    const order: string[] = [];

    const p1 = bridge.prompt("first", session.id).then(() => { order.push("first"); });
    const p2 = bridge.prompt("second", session.id).then(() => { order.push("second"); });

    // Only first should be processing
    agent.completePrompt();
    await p1;

    // Now second should start processing
    agent.completePrompt();
    await p2;

    expect(order).toEqual(["first", "second"]);
  });

  it("sendTo sends to specific session", () => {
    const bridge = new AgentBridge(agent as any, sessions);
    const s1 = createSender();
    const s2 = createSender();
    const session1 = sessions.create(s1);
    sessions.create(s2);

    bridge.sendTo(session1.id, { type: "thinking" });

    expect(s1.messages).toHaveLength(1);
    expect(s1.messages[0]).toEqual({ type: "thinking" });
    expect(s2.messages).toHaveLength(0);
  });

  it("sendTo to unknown session is no-op", () => {
    const bridge = new AgentBridge(agent as any, sessions);
    bridge.sendTo("nonexistent", { type: "thinking" }); // should not throw
  });

  it("response text is only captured during active prompt", async () => {
    const bridge = new AgentBridge(agent as any, sessions);
    const sender = createSender();
    const session = sessions.create(sender);

    // Emit response before any prompt — should still broadcast but not accumulate
    agent.emit({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "stray" }] },
    });

    const resultPromise = bridge.prompt("hello", session.id);
    agent.emit({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "actual" }] },
    });
    agent.completePrompt();

    const result = await resultPromise;
    expect(result.responseText).toBe("actual");
  });
});
