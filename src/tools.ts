/**
 * Agent tools for AI-driven window management.
 * These are the tools the orchestrator LLM can call to control the workspace.
 */
import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import * as sway from "./sway.js";
import * as cdp from "./cdp.js";
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
    // Check if Chrome is already running with CDP
    const cdpAvailable = await cdp.isAvailable();
    if (cdpAvailable) {
      // Navigate existing browser
      const result = await cdp.navigate(params.url);
      const windows = await sway.getWindows();
      return {
        content: [{ type: "text", text: `Navigated existing browser to ${params.url} (${result.title}). ${windows.length} windows open.` }],
        details: { windows, cdp: true },
      };
    }
    // Launch new Chrome with CDP enabled
    const chromePath = `${process.env.HOME}/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome`;
    const flags = [
      "--no-sandbox",
      "--disable-gpu",
      "--ozone-platform=wayland",
      "--enable-features=UseOzonePlatform",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=9222",
    ].join(" ");
    await sway.spawnWindow(`${chromePath} ${flags} "${params.url}"`);
    await new Promise(r => setTimeout(r, 4000));
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

// --- navigate_browser ---
export const navigateBrowserTool: AgentTool = {
  name: "navigate_browser",
  label: "Navigate Browser",
  description: "Navigate the browser to a new URL using Chrome DevTools Protocol (CDP). " +
    "This is the reliable way to navigate — avoids address bar typing issues.",
  parameters: Type.Object({
    url: Type.String({ description: "URL to navigate to" }),
  }),
  async execute(_id, params) {
    const result = await cdp.navigate(params.url);
    if (!result.success) {
      return {
        content: [{ type: "text", text: `Navigation failed: ${result.error}. Is a browser open with CDP enabled?` }],
        details: { error: true },
      };
    }
    return {
      content: [{ type: "text", text: `Navigated to ${params.url} — page title: "${result.title}"` }],
      details: { title: result.title },
    };
  },
};

// --- read_browser ---
export const readBrowserTool: AgentTool = {
  name: "read_browser",
  label: "Read Browser",
  description: "Read the text content of the current browser page. Useful for understanding what's " +
    "displayed without needing a screenshot. Returns the page's visible text.",
  parameters: Type.Object({}),
  async execute(_id, _params) {
    try {
      const targets = await cdp.listTargets();
      const page = targets.find(t => t.type === "page");
      if (!page) {
        return { content: [{ type: "text", text: "No browser tab found." }], details: {} };
      }
      const text = await cdp.getPageContent();
      const truncated = text.length > 3000 ? text.substring(0, 3000) + "\n... (truncated)" : text;
      return {
        content: [{ type: "text", text: `Page: ${page.title}\nURL: ${page.url}\n\n${truncated}` }],
        details: { url: page.url, title: page.title, fullLength: text.length },
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Failed to read browser: ${err.message}` }],
        details: { error: true },
      };
    }
  },
};

// --- browser_js ---
export const browserJsTool: AgentTool = {
  name: "browser_js",
  label: "Execute Browser JS",
  description: "Execute JavaScript in the browser page. Use for interacting with web apps, " +
    "clicking elements by selector, filling forms, extracting data, etc. " +
    "Example: document.querySelector('button.submit').click()",
  parameters: Type.Object({
    expression: Type.String({ description: "JavaScript expression to evaluate in the browser page" }),
  }),
  async execute(_id, params) {
    try {
      const result = await cdp.evaluateJS(params.expression);
      const text = result === undefined ? "(undefined)" : JSON.stringify(result);
      return {
        content: [{ type: "text", text: `Result: ${text}` }],
        details: { result },
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `JS error: ${err.message}` }],
        details: { error: true },
      };
    }
  },
};

// --- click ---
export const clickTool: AgentTool = {
  name: "click",
  label: "Click",
  description: "Click at a specific position on the screen using ydotool. Requires /dev/uinput access. " +
    "Use screenshot_workspace to see coordinates first. " +
    "For browser interaction, prefer navigate_browser or send_key with Tab to navigate between elements.",
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
    try {
      await sway.clickAt(params.x, params.y, btn);
      return {
        content: [{ type: "text", text: `Clicked ${params.button ?? 'left'} at (${params.x}, ${params.y})` }],
        details: {},
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Click failed (ydotool requires /dev/uinput): ${err.message}. Use keyboard navigation instead (Tab, Enter, send_key).` }],
        details: { error: true },
      };
    }
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
  navigateBrowserTool,
  readBrowserTool,
  browserJsTool,
  clickTool,
  scrollTool,
];
