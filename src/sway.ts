/**
 * Low-level sway IPC wrapper.
 * All compositor control goes through here.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { readdirSync } from "fs";

const execFileAsync = promisify(execFile);

function findSwaySocket(): string | undefined {
  if (process.env.SWAYSOCK) return process.env.SWAYSOCK;
  const dir = process.env.XDG_RUNTIME_DIR ?? "/tmp/sway-runtime";
  try {
    const sock = readdirSync(dir).find((f: string) => f.startsWith("sway-ipc."));
    return sock ? `${dir}/${sock}` : undefined;
  } catch {
    return undefined;
  }
}

const SWAYSOCK = findSwaySocket();

if (!SWAYSOCK) {
  console.warn("Warning: No sway IPC socket found. Sway commands will fail.");
}

export async function swaymsg(...args: string[]): Promise<any> {
  const env = { ...process.env, SWAYSOCK };
  const { stdout } = await execFileAsync("swaymsg", args, { env });
  try {
    return JSON.parse(stdout);
  } catch {
    return stdout.trim();
  }
}

export async function swaymsgRaw(...args: string[]): Promise<string> {
  const env = { ...process.env, SWAYSOCK };
  const { stdout } = await execFileAsync("swaymsg", args, { env });
  return stdout.trim();
}

// --- High-level helpers ---

export interface SwayWindow {
  id: number;
  name: string;
  app_id: string | null;
  rect: { x: number; y: number; width: number; height: number };
  focused: boolean;
}

export async function getWindows(): Promise<SwayWindow[]> {
  const tree = await swaymsg("-t", "get_tree");
  const windows: SwayWindow[] = [];
  function walk(node: any) {
    if (node.type === "con" && node.name && node.pid) {
      windows.push({
        id: node.id,
        name: node.name,
        app_id: node.app_id,
        rect: node.rect,
        focused: node.focused,
      });
    }
    for (const child of node.nodes ?? []) walk(child);
    for (const child of node.floating_nodes ?? []) walk(child);
  }
  walk(tree);
  return windows;
}

export async function getOutputs(): Promise<any[]> {
  return swaymsg("-t", "get_outputs");
}

export async function setResolution(width: number, height: number, output = "HEADLESS-1"): Promise<void> {
  await swaymsg("output", output, "resolution", `${width}x${height}`);
}

export async function spawnWindow(command: string): Promise<void> {
  const env_prefix = `WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY ?? "wayland-1"}`;
  await swaymsg("exec", `${env_prefix} ${command}`);
}

export async function focusWindow(conId: number): Promise<void> {
  await swaymsg(`[con_id=${conId}]`, "focus");
}

export async function closeWindow(conId: number): Promise<void> {
  await swaymsg(`[con_id=${conId}]`, "kill");
}

export async function setLayout(layout: "splitv" | "splith" | "tabbed" | "stacking"): Promise<void> {
  await swaymsg("layout", layout);
}

export async function moveWindow(conId: number, direction: "left" | "right" | "up" | "down"): Promise<void> {
  await swaymsg(`[con_id=${conId}]`, "focus");
  await swaymsg("move", direction);
}

export async function resizeWindow(conId: number, widthPpt: number): Promise<void> {
  await swaymsg(`[con_id=${conId}]`, "resize", "set", `${widthPpt}`, "ppt", "0", "ppt");
}

export async function screenshot(outputPath: string): Promise<string> {
  const env = {
    ...process.env,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? "/tmp/sway-runtime",
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ?? "wayland-1",
  };
  await execFileAsync("grim", [outputPath], { env });
  return outputPath;
}

// --- Input injection (wtype / ydotool) ---

const inputEnv = {
  ...process.env,
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? "/tmp/sway-runtime",
  WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ?? "wayland-1",
};

/**
 * Type text into the currently focused window using wtype.
 */
export async function typeText(text: string): Promise<void> {
  await execFileAsync("wtype", ["--", text], { env: inputEnv });
}

/**
 * Send a key combination using wtype.
 * Examples: "Return", "Tab", "BackSpace", "Left", "Home", "F5"
 * Modifiers: "ctrl", "alt", "shift", "logo"
 */
export async function sendKey(key: string, modifiers: string[] = []): Promise<void> {
  const args: string[] = [];
  for (const mod of modifiers) {
    args.push("-M", mod);
  }
  args.push("-k", key);
  for (const mod of [...modifiers].reverse()) {
    args.push("-m", mod);
  }
  await execFileAsync("wtype", args, { env: inputEnv });
}

/**
 * Click at a position using ydotool.
 * button: 0=left, 1=right, 2=middle
 */
export async function clickAt(x: number, y: number, button: number = 0): Promise<void> {
  // ydotool uses absolute positioning with mousemove --absolute
  await execFileAsync("ydotool", ["mousemove", "--absolute", "-x", String(x), "-y", String(y)], {});
  await execFileAsync("ydotool", ["click", String(button)], {});
}

/**
 * Scroll at current mouse position.
 * direction: "up" or "down", amount is number of scroll clicks.
 */
export async function scroll(direction: "up" | "down", amount: number = 3): Promise<void> {
  const delta = direction === "up" ? `-${amount}` : String(amount);
  await execFileAsync("ydotool", ["mousemove", "-w", delta], {});
}
