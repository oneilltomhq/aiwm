/**
 * Session management for connected clients.
 *
 * Each WebSocket connection gets a Session with identity, viewport state,
 * and voice state. Sessions are the unit of "who is connected."
 */
import { randomBytes } from "crypto";
import type { ServerMessage } from "./protocol.js";

export interface Viewport {
  width: number;
  height: number;
}

export type SessionRole = "driver" | "observer";

export interface SessionSender {
  /** Send a message to this session's client. Returns false if send failed. */
  send(msg: ServerMessage): boolean;
  /** Whether the underlying connection is open. */
  isOpen(): boolean;
}

export interface Session {
  readonly id: string;
  role: SessionRole;
  viewport: Viewport;
  voiceActive: boolean;
  readonly sender: SessionSender;
  readonly createdAt: number;
}

/**
 * Manages the set of active sessions.
 *
 * Emits events when sessions are added/removed so other modules
 * can react (e.g. agent-bridge subscribes to know who to send to).
 */
export class SessionManager {
  private sessions = new Map<string, Session>();
  private listeners: Array<(event: SessionEvent) => void> = [];

  /** Create a new session for a connected client. */
  create(sender: SessionSender, viewport?: Viewport): Session {
    const id = randomBytes(6).toString("hex");
    const session: Session = {
      id,
      role: "driver",
      viewport: viewport ?? { width: 1920, height: 1080 },
      voiceActive: false,
      sender,
      createdAt: Date.now(),
    };
    this.sessions.set(id, session);
    this.emit({ type: "session_created", session });
    return session;
  }

  /** Remove a session (client disconnected). */
  destroy(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      this.sessions.delete(id);
      this.emit({ type: "session_destroyed", session });
    }
  }

  /** Get a session by ID. */
  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /** Get all active sessions. */
  all(): Session[] {
    return [...this.sessions.values()];
  }

  /** Get all sessions with open connections. */
  active(): Session[] {
    return this.all().filter(s => s.sender.isOpen());
  }

  /** Number of active sessions. */
  get size(): number {
    return this.sessions.size;
  }

  /** Subscribe to session events. Returns unsubscribe function. */
  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  private emit(event: SessionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

export type SessionEvent =
  | { type: "session_created"; session: Session }
  | { type: "session_destroyed"; session: Session };
