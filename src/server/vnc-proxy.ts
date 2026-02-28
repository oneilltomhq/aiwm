/**
 * Raw TCP proxy for VNC WebSocket connections.
 *
 * Proxies a WebSocket upgrade request to wayvnc's WebSocket endpoint.
 * No WebSocket parsing on our side — just pipe bytes bidirectionally.
 */
import type { IncomingMessage } from "http";
import type { Socket } from "net";
import { createConnection } from "net";

const DEFAULT_VNC_WS_PORT = 5901;

export function proxyVncWebSocket(
  req: IncomingMessage,
  clientSocket: Socket,
  head: Buffer,
  upstreamPort = DEFAULT_VNC_WS_PORT,
): void {
  const upstream = createConnection({ host: "127.0.0.1", port: upstreamPort }, () => {
    // Reconstruct the HTTP upgrade request to send to wayvnc
    let reqLine = `GET ${req.url ?? "/"} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const key = req.rawHeaders[i];
      const val = req.rawHeaders[i + 1];
      if (key.toLowerCase() === "host") {
        reqLine += `Host: 127.0.0.1:${upstreamPort}\r\n`;
      } else {
        reqLine += `${key}: ${val}\r\n`;
      }
    }
    reqLine += "\r\n";
    upstream.write(reqLine);
    if (head.length > 0) upstream.write(head);

    // Pipe bidirectionally
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  upstream.on("error", (err) => {
    console.error("[vnc-proxy] Upstream error:", err.message);
    clientSocket.destroy();
  });

  clientSocket.on("error", (err) => {
    console.error("[vnc-proxy] Client socket error:", err.message);
    upstream.destroy();
  });

  clientSocket.on("close", () => upstream.destroy());
  upstream.on("close", () => clientSocket.destroy());
}
