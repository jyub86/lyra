// 이미지 내보내기 도구 (design §0 Tool-First) — JSON(export_service) 외에 슬라이드를
// 이미지 파일로 뽑는다. 렌더는 헤드리스 크롬이 /export 화면을 굽는 방식이라
// 편집·발표 화면과 결과가 같다.
import { register } from "./registry.js";
import { exportSlideImages } from "../lib/slide-export.js";

register({
  name: "export_slide_images",
  description: "예배의 슬라이드를 이미지 파일(WebP 우선, cwebp 없으면 PNG)로 내보낸다. slide_ids를 주면 그 슬라이드들만. 결과는 data/exports/<이름>/001.webp … 로 저장되고 파일 목록을 반환한다. 렌더는 헤드리스 크롬이 담당(설치 필요).",
  input_schema: {
    type: "object",
    properties: {
      service_id: { type: "string", description: "대상 예배 ID" },
      slide_ids: { type: "array", items: { type: "string" }, description: "이 슬라이드들만 내보내기(생략=전장)" },
      include_hidden: { type: "boolean", default: false, description: "발표에서 숨긴 슬라이드도 포함" },
      format: { type: "string", enum: ["webp", "png"], default: "webp", description: "webp=용량 작음(cwebp 필요), png=항상 가능" },
    },
    required: ["service_id"],
  },
  handler: async ({ service_id, slide_ids, include_hidden, format }, ctx) => {
    const db = ctx.db;
    const svc = db.query("SELECT id, title, date, worship_part FROM services WHERE id = ?").get(service_id);
    if (!svc) throw new Error(`unknown service: ${service_id}`);

    // 몇 장이 나올지 미리 센다(스크린샷 폴백에서 장 수가 필요하고, 결과 검증에도 쓴다).
    let rows = db.query("SELECT id, hidden FROM slides WHERE service_id = ? ORDER BY position").all(service_id);
    if (!include_hidden) rows = rows.filter((r) => !r.hidden);
    if (slide_ids?.length) { const want = new Set(slide_ids); rows = rows.filter((r) => want.has(r.id)); }
    if (!rows.length) throw new Error("내보낼 슬라이드가 없습니다.");

    const name = `${svc.date || ""}_${svc.worship_part || ""}_${svc.title || svc.id}`.trim().replace(/\s+/g, "-");
    const res = await exportSlideImages({
      serviceId: service_id,
      slideIds: slide_ids,
      includeHidden: !!include_hidden,
      count: rows.length,
      port: Number(process.env.PORT || 4321),
      name,
      format,
    });
    // 페이지 수가 어긋나면(렌더 화면과 DB 계산이 다르면) 조용히 넘기지 않고 알린다.
    const warning = res.files.length !== rows.length
      ? `예상 ${rows.length}장인데 ${res.files.length}장이 나왔습니다. 결과를 확인하세요.`
      : undefined;
    return { dir: res.dir, files: res.files, count: res.files.length, format: res.format, method: res.method, warning };
  },
});
