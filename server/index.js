// 진입점 — adapters 조립 + 정적 파일 서빙 (design §3, §13).
// Bun.serve owns one port for static files, the HTTP tool API, and the
// presenter WebSocket. Tools themselves live in the registry; this only wires.
import { normalize } from "node:path";
import { existsSync, statSync } from "node:fs";
import { handleApi } from "../adapters/http.js";
import { websocket } from "../adapters/ws.js";
import { closeDb } from "../core/db/index.js";
import { ASSETS } from "../core/assets.generated.js";
import { DATA_DIR, dataPath, COMPILED } from "../core/lib/paths.js";

const PORT = Number(process.env.PORT || 4321);

const INDEX_OF = {
  "/": "/editor/index.html", "/editor": "/editor/index.html", "/editor/": "/editor/index.html",
  "/presenter": "/presenter/index.html", "/presenter/": "/presenter/index.html",
  // 헤드리스 크롬이 이미지/PDF로 굽는 전용 화면
  "/export": "/export/index.html", "/export/": "/export/index.html",
};

// URL → 디스크 경로.
// 앱 자산(편집기·발표·테마·폰트)은 ASSETS 표에서 찾는다. 개발 모드에선 디스크의 실제
// 경로가, 단일 실행파일에선 바이너리에 심긴 경로가 나온다 — 서버 코드는 한 갈래로 유지.
// 사용자 데이터(uploads·render-cache)만 실제 데이터 폴더에서 읽는다.
function resolveStatic(pathname) {
  const url = INDEX_OF[pathname] || pathname;

  const asset = ASSETS.get(url);
  if (asset) return asset;

  // 사용자가 올린 파일·렌더 캐시 (데이터 폴더, 경로 이탈 방지)
  if (url.startsWith("/uploads/") || url.startsWith("/render-cache/")) {
    const full = normalize(dataPath(url));
    return full.startsWith(DATA_DIR) ? full : null;
  }
  return null;
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
      // 연결 역할을 소켓에 실어 발표 화면(presenter) 접속 수를 센다. 역할 미지정(구버전
      // 클라이언트 등)은 "viewer"로 취급 → 발표 화면으로 오인해 "발표중"이 켜지지 않게 한다.
      const role = url.searchParams.get("role") || "viewer";
      return server.upgrade(req, { data: { role } }) ? undefined : new Response("expected websocket", { status: 426 });
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
// 지난 업데이트가 남긴 헌 실행파일 정리 (교체는 다음 실행 때 마무리된다)
try { (await import("../core/tools/update.tools.js")).cleanupOldBinary(); } catch {}

// 사용자가 data/source/ 에 넣어 둔 성경·찬송·교독문을 첫 실행에 등록한다.
// (배포판엔 저작권 자료가 없으므로 "파일 넣고 다시 켜면 된다"가 성립해야 한다)
try {
  const { autoSeed } = await import("../core/db/seed/index.js");
  const added = autoSeed();
  for (const [file, r] of Object.entries(added)) console.log(`  · 콘텐츠 등록: ${file} ${JSON.stringify(r)}`);
} catch (e) {
  console.error("  ⚠️  콘텐츠 자동 등록 실패:", e.message);
}

console.log(`Lyra → http://localhost:${server.port}  (presenter: http://localhost:${server.port}/presenter)`);
for (const ip of lanAddresses()) console.log(`  · 다른 기기(같은 네트워크): http://${ip}:${server.port}`);
// 데이터가 어디에 쌓이는지 알려준다 — 배포판에서는 실행파일 옆이 아닐 수도 있다(쓰기 권한).
console.log(`  · 데이터 폴더: ${DATA_DIR}${COMPILED ? "" : "  (개발 모드)"}`);

// 종료 시 DB를 깨끗이 닫는다(창 닫기/Ctrl+C/종료 신호). 진행 중인 -journal도 정리.
let closing = false;
function shutdown() {
  if (closing) return; closing = true;
  try { closeDb(); } catch {}
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, shutdown);

// 서버가 켜진 뒤 기본 브라우저로 편집기를 연다.
// **배포판(단일 실행파일)은 기본으로 연다** — 더블클릭했는데 검은 창만 뜨고 아무 일도
// 안 일어나면 쓸 수가 없다(런처가 하던 일을 여기서 물려받는다).
// 개발 모드는 예전처럼 LYRA_OPEN=1 일 때만 — 서버를 자주 재시작하는데 매번 탭이 열리면 성가시다.
// LYRA_OPEN=0 으로 배포판에서도 끌 수 있다.
if (process.env.LYRA_OPEN ? process.env.LYRA_OPEN !== "0" : COMPILED) {
  const url = `http://localhost:${server.port}`;
  const cmd = process.platform === "darwin" ? ["open", url]
    : process.platform === "win32" ? ["cmd", "/c", "start", "", url]
      : ["xdg-open", url];
  try { Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }); } catch {}
}
