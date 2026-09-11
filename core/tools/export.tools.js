// 이미지 내보내기 도구 (design §0 Tool-First) — JSON(export_service) 외에 슬라이드를
// 이미지 파일로 뽑는다. 렌더는 헤드리스 크롬이 /export 화면을 굽는 방식이라
// 편집·발표 화면과 결과가 같다.
import { register } from "./registry.js";
import { exportSlideImages, exportSlidePdf } from "../lib/slide-export.js";

// 내보낼 슬라이드를 추려 개수를 세고, 파일 이름을 만든다.
// (스크린샷 폴백은 장 수를 미리 알아야 하고, PDF는 결과 검증에 쓴다)
//
// slide_ids를 준 경우 **고른 그대로** 나간다 — 숨긴 장이라도 뺐다가 조용히 사라지면
// "골랐는데 왜 안 나오지"가 된다. 전장 내보내기일 때만 include_hidden이 의미를 갖는다.
// (client/export/export.js의 필터 순서와 반드시 같아야 한다 — 다르면 쪽수가 어긋난다)
function pickSlides(db, { service_id, slide_ids, include_hidden }) {
  const svc = db.query("SELECT id, title, date, worship_part FROM services WHERE id = ?").get(service_id);
  if (!svc) throw new Error(`unknown service: ${service_id}`);
  let rows = db.query("SELECT id, hidden FROM slides WHERE service_id = ? ORDER BY position").all(service_id);
  if (slide_ids?.length) {
    const want = new Set(slide_ids);
    rows = rows.filter((r) => want.has(r.id));
  } else if (!include_hidden) {
    rows = rows.filter((r) => !r.hidden);
  }
  if (!rows.length) throw new Error("내보낼 슬라이드가 없습니다.");
  const name = `${svc.date || ""}_${svc.worship_part || ""}_${svc.title || svc.id}`.trim().replace(/\s+/g, "-");
  return { rows, name };
}

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
    const { rows, name } = pickSlides(db, { service_id, slide_ids, include_hidden });
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

register({
  name: "export_review_pdf",
  description: "예배의 슬라이드를 PDF 한 파일로 내보낸다(준비 중 자료를 공유·리뷰받을 때). 각 장 오른쪽 아래에 번호가 찍혀 리뷰어가 '12번 오타'처럼 지목할 수 있다. 휴대폰·PC 어디서나 별도 앱 없이 열린다. 이미지 내보내기와 달리 poppler가 필요 없고 크롬만 있으면 된다. data/exports/<이름>.pdf 로 저장된다.",
  input_schema: {
    type: "object",
    properties: {
      service_id: { type: "string", description: "대상 예배 ID" },
      slide_ids: { type: "array", items: { type: "string" }, description: "이 슬라이드들만 내보내기(생략=전장)" },
      include_hidden: { type: "boolean", default: false, description: "발표에서 숨긴 슬라이드도 포함" },
      numbers: { type: "boolean", default: true, description: "각 장에 슬라이드 번호 표시(리뷰어가 지목할 수단)" },
    },
    required: ["service_id"],
  },
  handler: async ({ service_id, slide_ids, include_hidden, numbers }, ctx) => {
    const db = ctx.db;
    const { rows, name } = pickSlides(db, { service_id, slide_ids, include_hidden });
    const res = await exportSlidePdf({
      serviceId: service_id,
      slideIds: slide_ids,
      includeHidden: !!include_hidden,
      port: Number(process.env.PORT || 4321),
      name,
      numbers: numbers !== false,
    });
    // pdfinfo가 있을 때만 페이지 수를 알 수 있다. 어긋나면 조용히 넘기지 않고 알린다.
    const warning = res.pages != null && res.pages !== rows.length
      ? `예상 ${rows.length}장인데 PDF는 ${res.pages}쪽입니다. 결과를 확인하세요.`
      : undefined;
    return {
      path: res.path, filename: res.filename, bytes: res.bytes,
      pages: res.pages ?? rows.length, slides: rows.length, warning,
    };
  },
});
