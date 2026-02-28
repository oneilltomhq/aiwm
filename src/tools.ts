/**
 * Agent tools for AI-driven window management.
 * These are the tools the orchestrator LLM can call to control the workspace.
 */
import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import * as sway from "./sway.js";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// --- spawn_terminal ---
export const spawnTerminalTool: AgentTool = {
  name: "spawn_terminal",
  label: "Spawn Terminal",
  description: "Spawn a new terminal window in the workspace. Optionally run a command in it.",
  parameters: Type.Object({
    command: Type.Optional(Type.String({ description: "Command to run in the terminal. If omitted, opens an interactive shell." })),
    title: Type.Optional(Type.String({ description: "A label for this terminal (e.g. 'dev-server', 'tests', 'logs')" })),
  }),
  async execute(_id, params) {
    const cmd = params.command
      ? `foot --title="${params.title ?? params.command}" -e bash -c '${params.command}; exec bash'`
      : `foot --title="${params.title ?? "shell"}"`;
    await sway.spawnWindow(cmd);
    // Wait for window to appear
    await new Promise(r => setTimeout(r, 500));
    const windows = await sway.getWindows();
    return {
      content: [{ type: "text", text: `Terminal spawned. ${windows.length} windows now open.` }],
      details: { windows },
    };
  },
};

// --- spawn_browser ---
export const spawnBrowserTool: AgentTool = {
  name: "spawn_browser",
  label: "Spawn Browser",
  description: "Open a Chromium browser window to a URL.",
  parameters: Type.Object({
    url: Type.String({ description: "URL to navigate to" }),
  }),
  async execute(_id, params) {
    await sway.spawnWindow(`chromium --no-sandbox --disable-gpu "${params.url}"`);
    await new Promise(r => setTimeout(r, 2000));
    const windows = await sway.getWindows();
    return {
      content: [{ type: "text", text: `Browser opened to ${params.url}. ${windows.length} windows now open.` }],
      details: { windows },
    };
  },
};

// --- arrange_workspace ---
export const arrangeWorkspaceTool: AgentTool = {
  name: "arrange_workspace",
  label: "Arrange Workspace",
  description: `Arrange windows in the workspace. You can set the layout mode, focus a specific window, ` +
    `or close windows. Use this to organize what the user sees based on context and viewport size.`,
  parameters: Type.Object({
    layout: Type.Optional(Type.Union([
      Type.Literal("tiled-horizontal"),
      Type.Literal("tiled-vertical"),
      Type.Literal("tabbed"),
      Type.Literal("stacking"),
    ], { description: "Layout mode for the current workspace" })),
    focus_window_id: Type.Optional(Type.Number({ description: "Window ID to focus/bring to front" })),
    close_window_ids: Type.Optional(Type.Array(Type.Number(), { description: "Window IDs to close" })),
  }),
  async execute(_id, params) {
    if (params.close_window_ids) {
      for (const id of params.close_window_ids) {
        await sway.closeWindow(id);
      }
    }
    if (params.layout) {
      const layoutMap: Record<string, "splith" | "splitv" | "tabbed" | "stacking"> = {
        "tiled-horizontal": "splith",
        "tiled-vertical": "splitv",
        "tabbed": "tabbed",
        "stacking": "stacking",
      };
      await sway.setLayout(layoutMap[params.layout]);
    }
    if (params.focus_window_id) {
      await sway.focusWindow(params.focus_window_id);
    }
    const windows = await sway.getWindows();
    return {
      content: [{ type: "text", text: `Workspace arranged. ${windows.length} windows: ${windows.map(w => `[${w.id}] ${w.name} (${w.rect.width}x${w.rect.height})`).join(", ")}` }],
      details: { windows },
    };
  },
};

// --- set_viewport ---
export const setViewportTool: AgentTool = {
  name: "set_viewport",
  label: "Set Viewport",
  description: "Change the workspace resolution. Use this when the user's device/context changes " +
    "(e.g. switching from phone to desktop, or user mentions their screen setup).",
  parameters: Type.Object({
    width: Type.Number({ description: "Viewport width in pixels" }),
    height: Type.Number({ description: "Viewport height in pixels" }),
    reason: Type.Optional(Type.String({ description: "Why you're changing the viewport (for logging)" })),
  }),
  async execute(_id, params) {
    await sway.setResolution(params.width, params.height);
    await new Promise(r => setTimeout(r, 500));
    const windows = await sway.getWindows();
    return {
      content: [{ type: "text", text: `Viewport set to ${params.width}x${params.height}. Windows re-tiled: ${windows.map(w => `[${w.id}] ${w.name} (${w.rect.width}x${w.rect.height})`).join(", ")}` }],
      details: { windows, width: params.width, height: params.height },
    };
  },
};

// --- screenshot_workspace ---
export const screenshotWorkspaceTool: AgentTool = {
  name: "screenshot_workspace",
  label: "Screenshot Workspace",
  description: "Take a screenshot of the current workspace. Use this to see what the workspace looks like " +
    "after making changes, or to share with the user.",
  parameters: Type.Object({
    reason: Type.Optional(Type.String({ description: "Why you're taking this screenshot" })),
  }),
  async execute(_id, params) {
    const path = `/tmp/aiwm-screenshot-${Date.now()}.png`;
    await sway.screenshot(path);
    return {
      content: [{ type: "text", text: `Screenshot saved to ${path}` }],
      details: { path },
    };
  },
};

// --- list_windows ---
export const listWindowsTool: AgentTool = {
  name: "list_windows",
  label: "List Windows",
  description: "List all windows currently open in the workspace with their IDs, names, and positions.",
  parameters: Type.Object({}),
  async execute(_id, _params) {
    const windows = await sway.getWindows();
    const outputs = await sway.getOutputs();
    const output = outputs[0];
    const viewport = output?.current_mode
      ? `${output.current_mode.width}x${output.current_mode.height}`
      : "unknown";
    const windowList = windows.map(w =>
      `[${w.id}] ${w.app_id ?? "unknown"} "${w.name}" — ${w.rect.width}x${w.rect.height} at (${w.rect.x},${w.rect.y})${w.focused ? " (focused)" : ""}`
    ).join("\n");
    return {
      content: [{ type: "text", text: `Viewport: ${viewport}\n\n${windowList || "No windows open."}` }],
      details: { windows, viewport },
    };
  },
};

// --- bash (standard agent tool) ---
export const bashTool: AgentTool = {
  name: "bash",
  label: "Run Command",
  description: "Execute a bash command on the server and return its output.",
  parameters: Type.Object({
    command: Type.String({ description: "The bash command to execute" }),
  }),
  async execute(_id, params, signal) {
    try {
      const { stdout, stderr } = await execFileAsync("bash", ["-c", params.command], {
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        signal: signal ?? undefined,
      });
      const output = (stdout + stderr).trim();
      return {
        content: [{ type: "text", text: output || "(no output)" }],
        details: { exitCode: 0 },
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}\n${err.stderr ?? ""}` }],
        details: { exitCode: err.code ?? 1 },
      };
    }
  },
};

// --- type_text ---
export const typeTextTool: AgentTool = {
  name: "type_text",
  label: "Type Text",
  description: "Type text into the currently focused window. Use this to enter commands in terminals, " +
    "type into text fields in browsers, fill forms, write code in editors, etc. " +
    "Focus the target window first with arrange_workspace if needed.",
  parameters: Type.Object({
    text: Type.String({ description: "The text to type" }),
    window_id: Type.Optional(Type.Number({ description: "Window ID to focus before typing. If omitted, types into currently focused window." })),
    press_enter: Type.Optional(Type.Boolean({ description: "Press Enter after typing the text. Useful for running commands." })),
  }),
  async execute(_id, params) {
    if (params.window_id) {
      await sway.focusWindow(params.window_id);
      await new Promise(r => setTimeout(r, 100));
    }
    await sway.typeText(params.text);
    if (params.press_enter) {
      await new Promise(r => setTimeout(r, 50));
      await sway.sendKey("Return");
    }
    return {
      content: [{ type: "text", text: `Typed "${params.text.substring(0, 100)}${params.text.length > 100 ? '...' : ''}"${params.press_enter ? ' + Enter' : ''} into ${params.window_id ? `window ${params.window_id}` : 'focused window'}` }],
      details: {},
    };
  },
};

// --- send_key ---
export const sendKeyTool: AgentTool = {
  name: "send_key",
  label: "Send Key",
  description: "Send a key press or key combination to the focused window. " +
    "Use for navigation (arrow keys, Tab, Enter), shortcuts (Ctrl+C, Ctrl+S, Alt+Left), " +
    "or special keys (Escape, F5, Home, End, Page_Up, Page_Down).",
  parameters: Type.Object({
    key: Type.String({ description: 'The key to press. Examples: "Return", "Tab", "Escape", "BackSpace", "Left", "Right", "Up", "Down", "Home", "End", "Page_Up", "Page_Down", "F5", "space", "a", "1"' }),
    modifiers: Type.Optional(Type.Array(Type.String(), { description: 'Modifier keys to hold. Options: "ctrl", "alt", "shift", "logo"' })),
    window_id: Type.Optional(Type.Number({ description: "Window ID to focus before sending the key." })),
    repeat: Type.Optional(Type.Number({ description: "Number of times to press this key. Default 1." })),
  }),
  async execute(_id, params) {
    if (params.window_id) {
      await sway.focusWindow(params.window_id);
      await new Promise(r => setTimeout(r, 100));
    }
    const times = params.repeat ?? 1;
    for (let i = 0; i < times; i++) {
      await sway.sendKey(params.key, params.modifiers ?? []);
      if (times > 1) await new Promise(r => setTimeout(r, 30));
    }
    const modStr = params.modifiers?.length ? params.modifiers.join("+") + "+" : "";
    return {
      content: [{ type: "text", text: `Sent ${modStr}${params.key}${times > 1 ? ` ×${times}` : ''}` }],
      details: {},
    };
  },
};

// --- click ---
export const clickTool: AgentTool = {
  name: "click",
  label: "Click",
  description: "Click at a specific position on the screen. Use screenshot_workspace to see coordinates first. " +
    "Useful for clicking buttons in GUIs, browser elements, etc.",
  parameters: Type.Object({
    x: Type.Number({ description: "X coordinate in pixels" }),
    y: Type.Number({ description: "Y coordinate in pixels" }),
    button: Type.Optional(Type.Union([
      Type.Literal("left"),
      Type.Literal("right"),
      Type.Literal("middle"),
    ], { description: "Mouse button. Default: left" })),
  }),
  async execute(_id, params) {
    const buttonMap: Record<string, number> = { left: 0, right: 1, middle: 2 };
    const btn = buttonMap[params.button ?? "left"];
    await sway.clickAt(params.x, params.y, btn);
    return {
      content: [{ type: "text", text: `Clicked ${params.button ?? 'left'} at (${params.x}, ${params.y})` }],
      details: {},
    };
  },
};

// --- scroll ---
export const scrollTool: AgentTool = {
  name: "scroll",
  label: "Scroll",
  description: "Scroll up or down in the focused window.",
  parameters: Type.Object({
    direction: Type.Union([Type.Literal("up"), Type.Literal("down")]),
    amount: Type.Optional(Type.Number({ description: "Number of scroll clicks. Default 3." })),
  }),
  async execute(_id, params) {
    await sway.scroll(params.direction, params.amount ?? 3);
    return {
      content: [{ type: "text", text: `Scrolled ${params.direction} ${params.amount ?? 3} clicks` }],
      details: {},
    };
  },
};

export const allTools: AgentTool[] = [
  spawnTerminalTool,
  spawnBrowserTool,
  arrangeWorkspaceTool,
  setViewportTool,
  screenshotWorkspaceTool,
  listWindowsTool,
  bashTool,
  typeTextTool,
  sendKeyTool,
  clickTool,
  scrollTool,
];
