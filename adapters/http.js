// HTTP 어댑터 (UI 전용 얇은 래퍼) — design §13.
// POST /api/tools/:name (write), GET /api/tools/:name (read tools only),
// GET /api/tools (list). All routes funnel through registry.execute — same path
// as CLI/MCP, no per-tool routing.
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadTools, schemas, get, execute } from "../core/tools/registry.js";
import { getDb } from "../core/db/index.js";
import { bus } from "../core/lib/bus.js";
import { saveUpload } from "../core/lib/uploads.js";
import { fileToSlides } from "../core/lib/pdf-import.js";
import { extractRefsFromPdf } from "../core/lib/pdf-refs.js";
import { insertSlides } from "../core/tools/slide.tools.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// Query params are strings; try JSON for each (numbers/booleans), else keep string.
function parseQuery(params) {
  const out = {};
  for (const [k, v] of params) {
    try { out[k] = JSON.parse(v); } catch { out[k] = v; }
  }
  return out;
}

export async function handleApi(req, url) {
  if (!url.pathname.startsWith("/api/")) return null;
  await loadTools();

  // 변경을 일으킨 탭(클라이언트) id. "내용 바뀜" 알림에 실어보내 그 탭만 다시 안 불러오게 한다.
  const origin = req.headers.get("x-lyra-client") || null;
  const ctx = () => ({ db: getDb(), bus, origin });

  if (url.pathname === "/api/tools" && req.method === "GET") {
    return json(schemas());
  }

  // Thin UI convenience: multipart file upload (avoids base64 through JSON).
  if (url.pathname === "/api/upload" && req.method === "POST") {
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!file || typeof file === "string") return json({ error: "no file" }, 400);
    return json(await saveUpload(file.name, await file.arrayBuffer()));
  }

  // Import existing slides: PDF (per page) or image → image-element slides.
  if (url.pathname === "/api/import" && req.method === "POST") {
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    const serviceId = url.searchParams.get("service_id") || form?.get("service_id");
    if (!file || typeof file === "string") return json({ error: "no file" }, 400);
    if (!serviceId) return json({ error: "service_id required" }, 400);
    // position 지정 시 그 위치부터 순서대로 삽입(선택 슬라이드 아래로), 생략 시 맨 끝.
    const posRaw = url.searchParams.get("position");
    let position = posRaw != null && posRaw !== "" ? Number(posRaw) : undefined;
    try {
      const db = getDb();
      if (!db.query("SELECT id FROM services WHERE id = ?").get(serviceId)) return json({ error: `unknown service: ${serviceId}` }, 404);
      const slides = await fileToSlides(file.name, await file.arrayBuffer());
      // 페이지별 add_slide 반복 대신 한 트랜잭션으로 일괄 삽입 + "changed" 이벤트 1회
      // (발표 화면이 매 페이지마다 전체를 다시 불러오는 것 방지).
      const slide_ids = insertSlides(db, serviceId, slides, position);
      bus.emit("changed", { tool: "import_pdf", origin });
      return json({ slide_ids });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }

  // 예배 순서 가져오기(멀티파트). 큰 JSON(이미지 base64 포함, 수백 MB)을 클라이언트가
  // 파싱/재직렬화하지 않고 파일 그대로 전송 → 서버가 한 번만 파싱해 import_service 호출.
  if (url.pathname === "/api/import-service" && req.method === "POST") {
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    const title = form?.get("title") || undefined;
    if (!file || typeof file === "string") return json({ error: "no file" }, 400);
    try {
      // .lyra 패키지(zip)와 예전 JSON을 모두 받는다 — 매직바이트로 알아서 갈린다.
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { importPackageBytes } = await import("../core/tools/package.tools.js");
      return json(await importPackageBytes(bytes, title ? String(title) : undefined, ctx()));
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }

  // 주보 PDF에서 빨강 성구 추출(멀티파트). 슬라이드는 만들지 않고 참조만 반환 →
  // UI에서 검토 후 add_bible_ref_slides로 추가.
  if (url.pathname === "/api/bible-refs/extract" && req.method === "POST") {
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!file || typeof file === "string") return json({ error: "no file" }, 400);
    try {
      return json(await extractRefsFromPdf(new Uint8Array(await file.arrayBuffer())));
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }

  // 슬라이드 → 이미지 내보내기 후 zip 하나로 내려준다. 파일 수백 개를 브라우저가
  // 한 장씩 받는 것보다 낫고, 폴더 경로를 클라이언트에 노출하지 않아도 된다.
  if (url.pathname === "/api/export/images" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    try {
      const res = await execute("export_slide_images", body, ctx());
      const { zipSync } = await import("fflate");
      const files = {};
      for (const f of res.files) files[f] = new Uint8Array(readFileSync(join(res.dir, f)));
      const zip = zipSync(files, { level: 0 });   // 이미 압축된 WebP/PNG → 재압축 안 함(빠름)
      const name = basename(res.dir) + ".zip";
      return new Response(zip, {
        headers: {
          "content-type": "application/zip",
          // 한글 파일명은 RFC 5987 형식으로 넘긴다(브라우저가 그대로 저장하게).
          "content-disposition": `attachment; filename="export.zip"; filename*=UTF-8''${encodeURIComponent(name)}`,
          "x-lyra-count": String(res.count),
          "x-lyra-method": res.method,
        },
      });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }

  // 예배 → .lyra 패키지. 서버가 파일로 굽고 그 파일을 **스트리밍**으로 내려준다.
  // (JSON+base64는 브라우저가 수백 MB 문자열을 메모리에 들어야 해서 큰 예배에서 실패했다)
  if (url.pathname === "/api/export/package" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    try {
      const res = await execute("export_service_package", body, ctx());
      return new Response(Bun.file(res.path), {
        headers: {
          "content-type": "application/zip",
          "content-length": String(res.bytes),
          "content-disposition": `attachment; filename="service.lyra"; filename*=UTF-8''${encodeURIComponent(res.filename)}`,
          "x-lyra-assets": `${res.assets}/${res.assets_total}`,
          "x-lyra-slides": String(res.slides),
        },
      });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }

  const m = url.pathname.match(/^\/api\/tools\/([A-Za-z0-9_]+)$/);
  if (!m) return json({ error: "not found" }, 404);

  const name = m[1];
  const tool = get(name);
  if (!tool) return json({ error: `unknown tool: ${name}` }, 404);

  let args = {};
  if (req.method === "GET") {
    if (!tool.read) return json({ error: `${name} is a write tool; use POST` }, 405);
    args = parseQuery(url.searchParams);
  } else if (req.method === "POST") {
    args = await req.json().catch(() => ({}));
  } else {
    return json({ error: "method not allowed" }, 405);
  }

  try {
    return json(await execute(name, args, ctx()));
  } catch (e) {
    const status = e.code === "INVALID_INPUT" ? 400 : 500;
    return json({ error: e.message, code: e.code, errors: e.errors }, status);
  }
}
