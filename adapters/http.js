// HTTP 어댑터 (UI 전용 얇은 래퍼) — design §13.
// POST /api/tools/:name (write), GET /api/tools/:name (read tools only),
// GET /api/tools (list). All routes funnel through registry.execute — same path
// as CLI/MCP, no per-tool routing.
import { loadTools, schemas, get, execute } from "../core/tools/registry.js";
import { saveUpload } from "../core/lib/uploads.js";
import { fileToSlides } from "../core/lib/pdf-import.js";

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
    try {
      const slides = await fileToSlides(file.name, await file.arrayBuffer());
      const slide_ids = [];
      for (const s of slides) slide_ids.push((await execute("add_slide", { service_id: serviceId, ...s })).slide_id);
      return json({ slide_ids });
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
    return json(await execute(name, args));
  } catch (e) {
    const status = e.code === "INVALID_INPUT" ? 400 : 500;
    return json({ error: e.message, code: e.code, errors: e.errors }, status);
  }
}
