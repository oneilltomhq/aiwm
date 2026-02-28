import { describe, it, expect, vi } from "vitest";
import { SessionManager } from "./session.js";
import type { SessionSender, SessionEvent } from "./session.js";

function mockSender(open = true): SessionSender {
  const sent: any[] = [];
  return {
    send(msg) { sent.push(msg); return true; },
    isOpen() { return open; },
    _sent: sent,
  } as any;
}

describe("SessionManager", () => {
  it("creates a session with unique ID", () => {
    const mgr = new SessionManager();
    const s1 = mgr.create(mockSender());
    const s2 = mgr.create(mockSender());
    expect(s1.id).toBeTruthy();
    expect(s2.id).toBeTruthy();
    expect(s1.id).not.toBe(s2.id);
  });

  it("assigns default viewport", () => {
    const mgr = new SessionManager();
    const s = mgr.create(mockSender());
    expect(s.viewport).toEqual({ width: 1920, height: 1080 });
  });

  it("accepts custom viewport", () => {
    const mgr = new SessionManager();
    const s = mgr.create(mockSender(), { width: 1080, height: 2400 });
    expect(s.viewport).toEqual({ width: 1080, height: 2400 });
  });

  it("assigns driver role by default", () => {
    const mgr = new SessionManager();
    const s = mgr.create(mockSender());
    expect(s.role).toBe("driver");
  });

  it("tracks size", () => {
    const mgr = new SessionManager();
    expect(mgr.size).toBe(0);
    const s = mgr.create(mockSender());
    expect(mgr.size).toBe(1);
    mgr.create(mockSender());
    expect(mgr.size).toBe(2);
    mgr.destroy(s.id);
    expect(mgr.size).toBe(1);
  });

  it("get returns session by ID", () => {
    const mgr = new SessionManager();
    const s = mgr.create(mockSender());
    expect(mgr.get(s.id)).toBe(s);
  });

  it("get returns undefined for unknown ID", () => {
    const mgr = new SessionManager();
    expect(mgr.get("nonexistent")).toBeUndefined();
  });

  it("destroy removes session", () => {
    const mgr = new SessionManager();
    const s = mgr.create(mockSender());
    mgr.destroy(s.id);
    expect(mgr.get(s.id)).toBeUndefined();
    expect(mgr.size).toBe(0);
  });

  it("destroy is idempotent", () => {
    const mgr = new SessionManager();
    const s = mgr.create(mockSender());
    mgr.destroy(s.id);
    mgr.destroy(s.id); // should not throw
    expect(mgr.size).toBe(0);
  });

  it("all returns all sessions", () => {
    const mgr = new SessionManager();
    const s1 = mgr.create(mockSender());
    const s2 = mgr.create(mockSender());
    const all = mgr.all();
    expect(all).toHaveLength(2);
    expect(all).toContain(s1);
    expect(all).toContain(s2);
  });

  it("active filters by open connection", () => {
    const mgr = new SessionManager();
    const s1 = mgr.create(mockSender(true));
    const s2 = mgr.create(mockSender(false));
    const active = mgr.active();
    expect(active).toHaveLength(1);
    expect(active[0]).toBe(s1);
  });

  it("emits session_created event", () => {
    const mgr = new SessionManager();
    const events: SessionEvent[] = [];
    mgr.subscribe(e => events.push(e));
    const s = mgr.create(mockSender());
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("session_created");
    expect(events[0].session).toBe(s);
  });

  it("emits session_destroyed event", () => {
    const mgr = new SessionManager();
    const s = mgr.create(mockSender());
    const events: SessionEvent[] = [];
    mgr.subscribe(e => events.push(e));
    mgr.destroy(s.id);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("session_destroyed");
    expect(events[0].session).toBe(s);
  });

  it("does not emit for destroying unknown session", () => {
    const mgr = new SessionManager();
    const events: SessionEvent[] = [];
    mgr.subscribe(e => events.push(e));
    mgr.destroy("nope");
    expect(events).toHaveLength(0);
  });

  it("unsubscribe works", () => {
    const mgr = new SessionManager();
    const events: SessionEvent[] = [];
    const unsub = mgr.subscribe(e => events.push(e));
    mgr.create(mockSender());
    expect(events).toHaveLength(1);
    unsub();
    mgr.create(mockSender());
    expect(events).toHaveLength(1); // no new event
  });

  it("session voiceActive defaults to false", () => {
    const mgr = new SessionManager();
    const s = mgr.create(mockSender());
    expect(s.voiceActive).toBe(false);
  });

  it("session viewport is mutable", () => {
    const mgr = new SessionManager();
    const s = mgr.create(mockSender());
    s.viewport = { width: 3840, height: 2160 };
    expect(mgr.get(s.id)!.viewport).toEqual({ width: 3840, height: 2160 });
  });
});
