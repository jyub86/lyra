// 진입점 — adapters 조립 + 정적 파일 서빙 (design §3, §13).
// Bun.serve owns one port for static files, the HTTP tool API, and the
// presenter WebSocket. Tools themselves live in the registry; this only wires.
import { join, normalize } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, statSync } from "node:fs";
import { handleApi } from "../adapters/http.js";
import { websocket } from "../adapters/ws.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 4321);

// Map a URL path to a file on disk (with a traversal guard).
function resolveStatic(pathname) {
  if (pathname === "/" || pathname === "/editor" || pathname === "/editor/") {
    return join(ROOT, "client/editor/index.html");
  }
  if (pathname === "/presenter" || pathname === "/presenter/") {
    return join(ROOT, "client/presenter/index.html");
  }
  let rel = null;
  if (pathname.startsWith("/shared/") || pathname.startsWith("/editor/") || pathname.startsWith("/presenter/")) {
    rel = "client" + pathname;
  } else if (pathname.startsWith("/themes/")) {
    rel = pathname.slice(1);
  } else if (pathname.startsWith("/uploads/")) {
    rel = "data" + pathname;
  }
  if (!rel) return null;
  const full = normalize(join(ROOT, rel));
  return full.startsWith(ROOT) ? full : null;
}

// Serve a file with HTTP Range support — required for <video> playback in Chrome
// (the media element requests `Range: bytes=…` and expects 206 Partial Content).
function serveFile(path, req) {
  const f = Bun.file(path);
  const size = f.size;
  const range = req.headers.get("range");
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : size - 1;
      if (Number.isNaN(start)) start = 0;
      if (Number.isNaN(end) || end >= size) end = size - 1;
      if (start > end || start >= size) {
        return new Response("range not satisfiable", { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      }
      return new Response(f.slice(start, end + 1), {
        status: 206,
        headers: {
          "Content-Type": f.type || "application/octet-stream",
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Accept-Ranges": "bytes",
          "Content-Length": String(end - start + 1),
        },
      });
    }
  }
  return new Response(f, { headers: { "Accept-Ranges": "bytes" } });
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 120,
  async fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      return server.upgrade(req) ? undefined : new Response("expected websocket", { status: 426 });
    }

    const api = await handleApi(req, url);
    if (api) return api;

    const file = resolveStatic(url.pathname);
    if (file && existsSync(file) && statSync(file).isFile()) {
      return serveFile(file, req);
    }
    return new Response("not found", { status: 404 });
  },
  websocket,
});

console.log(`Lyra → http://localhost:${server.port}  (presenter: http://localhost:${server.port}/presenter)`);
