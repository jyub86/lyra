// 성구(성경 참조) 도구 — 주보 PDF의 빨강 성구나 직접 입력한 참조를 성경 본문
// 슬라이드로 추가한다. 참조 파싱은 core/lib/bible-ref.js(구 pdf_to_pptx 로직 포팅),
// PDF 빨강 추출은 core/lib/pdf-refs.js(pdf.js). 슬라이드 생성은 기존 성경 템플릿
// (builtin-bible / add_bible_slides)을 재사용한다.
import { register, execute } from "./registry.js";
import { readFileSync } from "node:fs";
import { parseBibleRefs } from "../lib/bible-ref.js";
import { extractRefsFromPdf } from "../lib/pdf-refs.js";

register({
  name: "parse_bible_refs",
  description: "자유 텍스트(예: '요 3:16-18, 롬 8:1')를 구조화된 성경 참조 배열로 파싱한다. 문맥(직전 책/장)을 추적해 '18', '16절' 같은 부분 참조도 해석. 슬라이드 생성 전 미리보기용.",
  read: true,
  input_schema: {
    type: "object",
    properties: { text: { type: "string", description: "성경 참조 문자열" } },
    required: ["text"],
  },
  handler: ({ text }) => ({ refs: parseBibleRefs(text) }),
});

register({
  name: "extract_bible_refs_from_pdf",
  description: "PDF(서버 경로)에서 빨강으로 표기된 성구를 추출해 참조 배열로 반환한다(슬라이드 생성 없이 조회만). 주 본문(제목의 요6:1-15 등)을 문맥으로 절만 있는 참조도 해석. 브라우저 업로드는 POST /api/bible-refs/extract.",
  read: true,
  input_schema: {
    type: "object",
    properties: { path: { type: "string", description: "서버의 PDF 파일 경로" } },
    required: ["path"],
  },
  handler: async ({ path }) => await extractRefsFromPdf(readFileSync(path)),
});

// 참조 배열/텍스트 → 성경 본문 슬라이드. 각 참조를 성경 템플릿(builtin-bible)으로
// 추가하고, position부터 순서대로 삽입한다. 해석 실패 참조는 unresolved로 반환.
export async function addBibleRefSlides({ service_id, text, refs, layout, position }, ctx) {
  const list = refs && refs.length ? refs : parseBibleRefs(text || "");
  if (!list.length) throw new Error("해석된 성경 참조가 없습니다. 입력 형식을 확인하세요(예: 요 3:16-18, 롬 8:1).");
  const slide_ids = [];
  const added = [];
  const unresolved = [];
  let pos = position;
  for (const r of list) {
    try {
      const res = await execute("apply_template", {
        template_id: "builtin-bible", service_id,
        params: { book: r.book, chapter: r.chapter, verse_start: r.verse_start, verse_end: r.verse_end, layout: layout || "auto" },
        position: pos,
      }, ctx);
      const ids = res.slide_ids || [];
      slide_ids.push(...ids);
      added.push(r.ref);
      if (pos != null) pos += ids.length; // 다음 참조는 이 슬라이드들 뒤에
    } catch (e) {
      unresolved.push({ ref: r.ref, error: e.message });
    }
  }
  return { slide_ids, added, unresolved };
}

register({
  name: "add_bible_ref_slides",
  description: "성경 참조(자유 텍스트 text 또는 구조화된 refs)를 성경 본문 슬라이드로 예배 순서에 추가한다. 성경 템플릿 디자인·자동 분할 적용. 주보 PDF는 먼저 extract_bible_refs_from_pdf로 참조를 얻어 넘긴다.",
  input_schema: {
    type: "object",
    properties: {
      service_id: { type: "string" },
      text: { type: "string", description: "성경 참조 문자열(예: '요 3:16-18, 롬 8:1'). refs가 없을 때 파싱." },
      refs: {
        type: "array",
        description: "구조화된 참조 배열(parse_bible_refs 결과). 있으면 text 대신 사용.",
        items: {
          type: "object",
          properties: { book: { type: "string" }, chapter: { type: "integer" }, verse_start: { type: "integer" }, verse_end: { type: "integer" } },
          required: ["book", "chapter", "verse_start", "verse_end"],
        },
      },
      layout: { type: "string", enum: ["auto", "one-per-verse", "all-in-one"], default: "auto" },
      position: { type: "integer", description: "삽입 시작 위치(생략 시 맨 끝)" },
    },
    required: ["service_id"],
  },
  handler: (args, ctx) => addBibleRefSlides(args, ctx),
});
