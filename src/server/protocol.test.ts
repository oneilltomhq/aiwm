import { describe, it, expect } from "vitest";
import { parseClientMessage, serializeServerMessage } from "./protocol.js";
import type { ServerMessage } from "./protocol.js";

describe("parseClientMessage", () => {
  it("parses a valid text message", () => {
    const msg = parseClientMessage(JSON.stringify({ type: "text", text: "hello" }));
    expect(msg).toEqual({ type: "text", text: "hello" });
  });

  it("parses a valid audio message", () => {
    const msg = parseClientMessage(JSON.stringify({ type: "audio", data: "AQID" }));
    expect(msg).toEqual({ type: "audio", data: "AQID" });
  });

  it("parses a valid viewport message", () => {
    const msg = parseClientMessage(JSON.stringify({ type: "viewport", width: 1920, height: 1080 }));
    expect(msg).toEqual({ type: "viewport", width: 1920, height: 1080 });
  });

  it("parses voice_start", () => {
    const msg = parseClientMessage(JSON.stringify({ type: "voice_start" }));
    expect(msg).toEqual({ type: "voice_start" });
  });

  it("parses voice_stop", () => {
    const msg = parseClientMessage(JSON.stringify({ type: "voice_stop" }));
    expect(msg).toEqual({ type: "voice_stop" });
  });

  it("accepts Buffer input", () => {
    const buf = Buffer.from(JSON.stringify({ type: "voice_start" }));
    expect(parseClientMessage(buf)).toEqual({ type: "voice_start" });
  });

  it("rejects invalid JSON", () => {
    expect(parseClientMessage("not json")).toBeNull();
  });

  it("rejects unknown type", () => {
    expect(parseClientMessage(JSON.stringify({ type: "unknown" }))).toBeNull();
  });

  it("rejects text with empty string", () => {
    expect(parseClientMessage(JSON.stringify({ type: "text", text: "  " }))).toBeNull();
  });

  it("rejects text with missing text field", () => {
    expect(parseClientMessage(JSON.stringify({ type: "text" }))).toBeNull();
  });

  it("rejects audio with missing data", () => {
    expect(parseClientMessage(JSON.stringify({ type: "audio" }))).toBeNull();
  });

  it("rejects viewport with zero width", () => {
    expect(parseClientMessage(JSON.stringify({ type: "viewport", width: 0, height: 1080 }))).toBeNull();
  });

  it("rejects viewport with negative height", () => {
    expect(parseClientMessage(JSON.stringify({ type: "viewport", width: 1920, height: -1 }))).toBeNull();
  });

  it("rejects viewport with non-number dimensions", () => {
    expect(parseClientMessage(JSON.stringify({ type: "viewport", width: "big", height: 1080 }))).toBeNull();
  });

  it("rejects null input", () => {
    expect(parseClientMessage("null")).toBeNull();
  });

  it("rejects array input", () => {
    expect(parseClientMessage("[]")).toBeNull();
  });
});

describe("serializeServerMessage", () => {
  it("serializes a response message", () => {
    const msg: ServerMessage = { type: "response", text: "hello" };
    expect(JSON.parse(serializeServerMessage(msg))).toEqual(msg);
  });

  it("serializes a tool_call message", () => {
    const msg: ServerMessage = { type: "tool_call", name: "bash", args: { command: "ls" } };
    expect(JSON.parse(serializeServerMessage(msg))).toEqual(msg);
  });

  it("serializes an error message", () => {
    const msg: ServerMessage = { type: "error", message: "something broke" };
    expect(JSON.parse(serializeServerMessage(msg))).toEqual(msg);
  });

  it("serializes thinking", () => {
    const msg: ServerMessage = { type: "thinking" };
    expect(JSON.parse(serializeServerMessage(msg))).toEqual(msg);
  });
});
