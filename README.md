# AIWM — AI Window Manager

An AI-driven workspace compositor. An LLM agent controls a headless [sway](https://swaywm.org/) compositor on a server, spawning and arranging real applications (terminals, browsers) based on conversation context and the viewer's device.

**The core idea:** nobody is doing AI-driven window management. The agent decides what you need to see. You talk to it from your phone on the train; it shows you one focused pane. You sit down at your desk; it spreads out across your monitors. Same server, same windows, adapted to your viewport.

## What works today (proof of concept)

- **Headless sway** running on a server with no GPU (software rendering via pixman)
- **Pi agent framework** ([github.com/badlogic/pi-mono](https://github.com/badlogic/pi-mono)) as the orchestrator, with custom tools wrapping sway IPC
- **Viewport adaptation:** same compositor, different layouts:
  - Desktop (2560×1440): windows tiled side by side
  - Phone (1080×2400): stacking/tabbed layout, AI picks the most relevant surface to focus
- **VNC streaming** via wayvnc for thin client access
- **AI layout decisions:** when told "phone," the agent chose stacking mode and focused htop as the highest-priority monitoring view

### Agent tools

| Tool | What it does |
|------|--------------|
| `spawn_terminal` | Open a terminal, optionally running a command |
| `spawn_browser` | Open Chromium to a URL |
| `arrange_workspace` | Change layout (tiled/tabbed/stacking), focus/close windows |
| `set_viewport` | Change display resolution (phone ↔ desktop) |
| `screenshot_workspace` | Capture current workspace state |
| `list_windows` | List all windows with IDs, sizes, positions |
| `bash` | Run any command on the server |

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Server                                         │
│                                                 │
│  ┌───────────┐    sway IPC     ┌──────────────┐ │
│  │ Pi agent   │───────────────▶│ Headless sway │ │
│  │ (orchestr.)│                │ (compositor)  │ │
│  └─────┬─────┘                └──────┬───────┘ │
│        │                             │          │
│        │ WebSocket (future)    VNC stream       │
│        │                             │          │
│  ┌─────▼─────────────────────────────▼───────┐  │
│  │          wayvnc (port 5900)               │  │
│  └───────────────────────────────────────────┘  │
└──────────────────────┬──────────────────────────┘
                       │
          ┌────────────┼────────────┐
          │            │            │
     ┌────▼───┐  ┌─────▼────┐ ┌────▼────┐
     │ Phone  │  │  Laptop  │ │ Desktop │
     │1080x   │  │ 1920x    │ │ 3840x   │
     │2400    │  │ 1080     │ │ 2160    │
     └────────┘  └──────────┘ └─────────┘
     (VNC client on each — thin clients)
```

## Running

```bash
# 1. Install dependencies
sudo apt install sway wayvnc grim foot jq
npm install

# 2. Start headless sway
mkdir -p /tmp/sway-runtime && chmod 700 /tmp/sway-runtime
WLR_BACKENDS=headless WLR_RENDERER=pixman XDG_RUNTIME_DIR=/tmp/sway-runtime sway &

# 3. Start VNC streaming
XDG_RUNTIME_DIR=/tmp/sway-runtime WAYLAND_DISPLAY=wayland-1 \
  wayvnc --output=HEADLESS-1 0.0.0.0 5900 &

# 4. Start the AI orchestrator
ANTHROPIC_API_KEY=dummy XDG_RUNTIME_DIR=/tmp/sway-runtime \
  WAYLAND_DISPLAY=wayland-1 npx tsx src/index.ts
```

On exe.dev, the `ANTHROPIC_API_KEY=dummy` works because requests route through the exe.dev LLM gateway. Outside exe.dev, set a real Anthropic API key.

## Roadmap

See [AGENTS.md](./AGENTS.md) for detailed next steps.

## License

TBD
