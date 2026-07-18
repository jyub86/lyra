// 진입점 — adapters 조립 + 정적 파일 서빙 (design §3, §13).
// Bun.serve owns one port for static files, the HTTP tool API, and the
// presenter WebSocket. Tools themselves live in the registry; this only wires.
import { join, normalize } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, statSync } from "node:fs";
import { handleApi } from "../adapters/http.js";
import { websocket } from "../adapters/ws.js";
import { closeDb } from "../core/db/index.js";

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
  } else if (pathname.startsWith("/uploads/") || pathname.startsWith("/fonts/") || pathname.startsWith("/render-cache/")) {
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
  // 큰 예배 내보내기(JSON에 이미지 base64 포함, 수백 MB)도 가져올 수 있게 본문 한도 상향.
  // (기본 128MB) — 이미지 다수/고해상도 덱은 이를 쉽게 넘긴다.
  maxRequestBodySize: 2 * 1024 * 1024 * 1024, // 2GB
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

// LAN 주소도 함께 안내 (같은 네트워크의 다른 기기에서 접속용).
import { networkInterfaces } from "node:os";
function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}
console.log(`Lyra → http://localhost:${server.port}  (presenter: http://localhost:${server.port}/presenter)`);
for (const ip of lanAddresses()) console.log(`  · 다른 기기(같은 네트워크): http://${ip}:${server.port}`);

// 종료 시 DB를 깨끗이 닫는다(창 닫기/Ctrl+C/종료 신호). 진행 중인 -journal도 정리.
let closing = false;
function shutdown() {
  if (closing) return; closing = true;
  try { closeDb(); } catch {}
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, shutdown);

// LYRA_OPEN=1 이면 서버가 켜진 뒤 기본 브라우저로 편집기를 연다(더블클릭 런처용).
if (process.env.LYRA_OPEN) {
  const url = `http://localhost:${server.port}`;
  const cmd = process.platform === "darwin" ? ["open", url]
    : process.platform === "win32" ? ["cmd", "/c", "start", "", url]
      : ["xdg-open", url];
  try { Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }); } catch {}
}
