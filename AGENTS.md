# AIWM — Agent Guide

This file is for AI agents (Shelley, Pi, OpenClaw, etc.) working on this project.

## What this project is

AIWM is an AI-driven window manager. An LLM agent controls a headless sway Wayland compositor running on a server. The agent spawns real applications (terminals, browsers), arranges them based on conversation context and viewport size, and streams the result to thin clients via VNC.

The core differentiator: **the AI infers what you need to see.** Not just executing layout commands — proactively deciding which surfaces matter based on the conversation.

## Current state (proof of concept)

### What works
- Headless sway on the server (no GPU, `WLR_BACKENDS=headless WLR_RENDERER=pixman`)
- Pi agent framework (`@mariozechner/pi-*` v0.55.1) as orchestrator
- 14 tools: `spawn_terminal`, `spawn_browser`, `arrange_workspace`, `set_viewport`, `screenshot_workspace`, `list_windows`, `bash`, `type_text`, `send_key`, `navigate_browser`, `read_browser`, `browser_js`, `click`, `scroll`
- Full input injection: `wtype` for keyboard input, `ydotool` for mouse events (needs `/dev/uinput`)
- Headed Chromium (Playwright's Chrome for Testing) running in sway with Wayland/Ozone
- Chrome DevTools Protocol (CDP) on port 9222 for reliable browser control
- `src/cdp.ts` — CDP WebSocket client (navigate, read content, execute JS)
- Viewport adaptation: desktop (tiled) vs phone (stacking + AI picks focus)
- wayvnc streaming on port 5900
- LLM calls via exe.dev gateway (`http://169.254.169.254/gateway/llm/anthropic`) with `ANTHROPIC_API_KEY=dummy`
- **Voice + WebSocket server** on port 8080 with web thin client
  - WebSocket protocol for thin client ↔ orchestrator communication
  - Deepgram streaming STT (speech-to-text) via WebSocket API
  - ElevenLabs TTS (text-to-speech) via streaming REST API
  - Hold-to-talk mic capture with real-time interim transcripts
  - Audio streaming playback of agent responses
  - Live tool call feedback + thinking indicators
  - Automatic viewport reporting from thin client
  - Text input also supported alongside voice

### Key files
- `src/index.ts` — entry point, wires agent + sessions + server together
- `src/agent.ts` — Agent setup, model config, system prompt
- `src/tools.ts` — all agent tools (sway IPC wrappers)
- `src/sway.ts` — low-level sway IPC (calls `swaymsg`, `grim`)
- `src/cdp.ts` — Chrome DevTools Protocol helper
- `src/deepgram.ts` — Deepgram streaming STT via WebSocket
- `src/elevenlabs.ts` — ElevenLabs TTS via streaming REST
- `src/server/protocol.ts` — WebSocket message types + parsing/validation
- `src/server/session.ts` — session management (identity, viewport, roles)
- `src/server/agent-bridge.ts` — bridges agent events → sessions, prompt queue
- `src/server/voice.ts` — STT/TTS lifecycle per session
- `src/server/ws.ts` — WebSocket upgrade routing + message handling
- `src/server/http.ts` — static file server
- `src/server/vnc-proxy.ts` — raw TCP proxy to wayvnc
- `client/index.html` — voice-only thin client (fullscreen VNC + floating mic)
- `config/sway-headless.conf` — sway config for headless mode
- `.env.example` — template for API keys (Deepgram, ElevenLabs)

### Tests (vitest, 60 tests)
- `src/server/protocol.test.ts` — message parsing/validation (20 tests)
- `src/server/session.test.ts` — session lifecycle, events (17 tests)
- `src/server/agent-bridge.test.ts` — event routing, prompt queue (12 tests)
- `src/server/voice.test.ts` — STT/TTS lifecycle (11 tests)
- Run: `npm test` or `npx vitest run`

### How to run
```bash
# Sway (in tmux session 'sway')
WLR_BACKENDS=headless WLR_RENDERER=pixman XDG_RUNTIME_DIR=/tmp/sway-runtime WLR_LIBINPUT_NO_DEVICES=1 sway

# VNC TCP (in tmux session 'vnc') — for native VNC clients
XDG_RUNTIME_DIR=/tmp/sway-runtime WAYLAND_DISPLAY=wayland-1 wayvnc --output=HEADLESS-1 0.0.0.0 5900

# VNC WebSocket (in tmux session 'vnc-ws') — for noVNC in web client
XDG_RUNTIME_DIR=/tmp/sway-runtime WAYLAND_DISPLAY=wayland-1 wayvnc --websocket --output=HEADLESS-1 -S /tmp/wayvnc-ws.sock 0.0.0.0 5901

# Agent
ANTHROPIC_API_KEY=dummy XDG_RUNTIME_DIR=/tmp/sway-runtime WAYLAND_DISPLAY=wayland-1 npx tsx src/index.ts
```

Sway and VNC may already be running in tmux sessions. Check `tmux ls`.

### Environment
- Server: Ubuntu 24.04 on exe.dev VM (valley-silver.exe.xyz)
- Node 22, TypeScript, ESM modules
- Sway 1.9, wayvnc 0.7.2, grim, foot terminal
- OpenClaw is also running on this server (port 8000) — potential integration point
- Shelley (exe.dev agent) is running on port 9000

## Design decisions made

1. **Use sway, not build a custom Smithay compositor.** Sway already handles window management, input, rendering, multi-output. We control it via IPC. If we hit sway's limits later, we can swap in a custom compositor — the agent tools are the abstraction layer.

2. **Pi framework, not Shelley, as the agent runtime.** Pi has pluggable tools (`AgentTool<T>`), an event system (`Agent.subscribe()`), and `transformContext` hooks — all needed for streaming surface updates and injecting viewport state. TypeScript everywhere (frontend + backend) is also a win.

3. **Thin client model.** The compositor runs on the server. Phones, laptops, desktops connect as thin clients (VNC now, potentially better streaming later). The compositor adapts its output resolution to the client's viewport.

4. **Chat/voice is the control channel, not a window.** The conversation with the agent lives on the client. The compositor only renders "work" surfaces (terminals, browsers). Clean separation.

## What to build next (priority order)

### 1. ~~Chromium in sway~~ ✅ DONE
Chromium (Playwright's Chrome for Testing) runs headed in headless sway with `--ozone-platform=wayland --no-sandbox --disable-gpu --remote-debugging-port=9222`. Navigation via CDP (Chrome DevTools Protocol) is reliable. Agent can screenshot, read page text, and execute JS in the browser.

### 2. ~~WebSocket protocol between client and orchestrator~~ ✅ DONE
Thin client connects via WebSocket on port 8080. Protocol supports:
- Client → Server: audio (base64 PCM), text, viewport, voice_start/stop
- Server → Client: transcript, response, audio (base64 mp3), tool_call, thinking, error
- Viewport auto-reported on connect and resize
- Next: auto-trigger agent layout adaptation when viewport changes

### 3. Proactive surface inference
The high-value feature. The agent should infer layout changes from conversation context without being told:
- User mentions a URL → open browser
- Agent runs a dev server → surface the terminal showing its output
- Agent hits an error → that terminal floats up in priority
- Subagent finishes work → show the result
This likely means injecting surface state into the system prompt and/or using `transformContext`.

### 4. ~~Voice input/output~~ ✅ DONE
Deepgram STT + ElevenLabs TTS fully integrated:
- Hold-to-talk mic capture on thin client → PCM audio streamed via WebSocket
- Server streams audio to Deepgram for real-time STT with interim transcripts
- Transcribed text fed to agent, agent response sent to ElevenLabs TTS
- TTS audio streamed back to client as mp3 chunks for playback
- Requires API keys: `DEEPGRAM_API_KEY` and `ELEVENLABS_API_KEY` (see `.env.example`)

### 5. Better streaming than VNC
VNC is fine for proof of concept but has limitations (no audio, compression artifacts on text). Consider:
- Sunshine/Moonlight (hardware-encoded game streaming, sub-30ms latency)
- Custom protocol: send structured data for text surfaces, pixels only for graphical ones
- Multiple sway outputs for simultaneous phone + desktop viewing

### 6. Persistent sessions
Save/restore workspace state. When you reconnect, the workspace is as you left it. Agent remembers what you were working on.

## Longer-term vision

- The AI doesn't just manage windows — it IS your development environment
- Voice-first interaction from any device
- Subagent swarm: orchestrator dispatches to specialized agents (coding, browsing, research), each with their own terminal/browser, all visible in the workspace
- The workspace adapts in real-time: phone on the train → laptop at a café → multi-monitor at the desk, seamless
- Screenshot compositions: capture an arrangement (browser result + code + logs) as a shareable artifact

## Tech references

- Pi framework: https://github.com/badlogic/pi-mono (MIT, 18k stars)
- Shelley: https://github.com/boldsoftware/shelley (Apache 2.0)
- Sway IPC: https://man.archlinux.org/man/sway-ipc.7
- OpenClaw: running on this server, embeds Pi, multi-channel AI gateway
