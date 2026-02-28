/**
 * Chrome DevTools Protocol (CDP) helper.
 * Communicates with Chrome/Chromium via the remote debugging port.
 */
import WebSocket from "ws";

const CDP_PORT = 9222;

interface CDPTarget {
  id: string;
  title: string;
  url: string;
  type: string;
  webSocketDebuggerUrl: string;
}

/**
 * List all CDP targets (tabs/pages).
 */
export async function listTargets(): Promise<CDPTarget[]> {
  const res = await fetch(`http://localhost:${CDP_PORT}/json`);
  return res.json() as Promise<CDPTarget[]>;
}

/**
 * Get the first page target.
 */
export async function getFirstPage(): Promise<CDPTarget | undefined> {
  const targets = await listTargets();
  return targets.find(t => t.type === "page");
}

/**
 * Send a CDP command to a specific target.
 */
export function sendCommand(wsUrl: string, method: string, params: Record<string, any> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = 1;
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`CDP command ${method} timed out`));
    }, 15000);

    ws.on("open", () => {
      ws.send(JSON.stringify({ id, method, params }));
    });
    ws.on("message", (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        clearTimeout(timeout);
        ws.close();
        if (msg.error) {
          reject(new Error(`CDP error: ${msg.error.message}`));
        } else {
          resolve(msg.result);
        }
      }
    });
    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Navigate the first browser tab to a URL.
 */
export async function navigate(url: string): Promise<{ success: boolean; title?: string; error?: string }> {
  try {
    const target = await getFirstPage();
    if (!target) return { success: false, error: "No browser tab found" };
    await sendCommand(target.webSocketDebuggerUrl, "Page.navigate", { url });
    // Wait for load
    await new Promise(r => setTimeout(r, 2000));
    // Get updated title
    const targets = await listTargets();
    const updated = targets.find(t => t.id === target.id);
    return { success: true, title: updated?.title ?? "unknown" };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Get page content as text (useful for reading what's on a page).
 */
export async function getPageContent(): Promise<string> {
  const target = await getFirstPage();
  if (!target) return "No browser tab found";
  const result = await sendCommand(target.webSocketDebuggerUrl, "Runtime.evaluate", {
    expression: "document.body.innerText",
    returnByValue: true,
  });
  return result?.result?.value ?? "";
}

/**
 * Execute JavaScript in the browser page.
 */
export async function evaluateJS(expression: string): Promise<any> {
  const target = await getFirstPage();
  if (!target) throw new Error("No browser tab found");
  const result = await sendCommand(target.webSocketDebuggerUrl, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result?.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? "JS evaluation error");
  }
  return result?.result?.value;
}

/**
 * Check if CDP is available (Chrome running with --remote-debugging-port).
 */
export async function isAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${CDP_PORT}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}
