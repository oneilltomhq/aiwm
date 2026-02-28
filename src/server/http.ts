/**
 * HTTP static file server for the web client.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html",
  js: "application/javascript",
  mjs: "application/javascript",
  css: "text/css",
  png: "image/png",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  json: "application/json",
  woff: "font/woff",
  woff2: "font/woff2",
};

export function createHttpServer(clientDir: string) {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const urlPath = (req.url ?? "/").split("?")[0];

    let filePath: string;
    if (urlPath === "/" || urlPath === "/index.html") {
      filePath = join(clientDir, "index.html");
    } else {
      // Strip path traversal attempts
      const safePath = urlPath.replace(/\.\.\//g, "").replace(/\.\.$/, "");
      filePath = join(clientDir, safePath);
    }

    if (existsSync(filePath)) {
      const ext = filePath.split(".").pop() ?? "html";
      res.writeHead(200, {
        "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream",
      });
      res.end(readFileSync(filePath));
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  return server;
}
