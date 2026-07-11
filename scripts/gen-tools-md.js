#!/usr/bin/env bun
// 레지스트리에서 전체 도구 레퍼런스(docs/tools.md)를 생성한다. 도구 추가/변경 후 재실행:
//   bun run scripts/gen-tools-md.js
// 자동 생성이라 항상 코드와 일치(드리프트 없음). 개념·워크플로우 가이드는 docs/AGENTS.md.
import { loadTools, list } from "../core/tools/registry.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

await loadTools();
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// 카테고리(파일 구성과 동일) + 순서. 목록에 없는 도구는 "기타"로.
const CATEGORIES = [
  ["읽기 · 콘텐츠 검색 (LLM 그라운딩)", ["list_bible_books", "get_bible_passage", "search_bible", "get_hymn", "search_hymn", "get_reading", "search_reading"]],
  ["예배(Service)", ["list_services", "get_service", "create_service", "update_service", "duplicate_service", "delete_service", "set_service_theme", "set_service_transition", "export_service", "import_service"]],
  ["슬라이드(Slide)", ["add_slide", "update_slide", "set_slide_elements", "set_slide_background", "set_slide_hidden", "reorder_slides", "remove_slide", "set_service_slides"]],
  ["콘텐츠 슬라이드 생성 (고가치)", ["add_bible_slides", "add_hymn_slides", "add_reading_slides", "add_praise_slides", "add_announcement_slide"]],
  ["템플릿(Template)", ["list_templates", "get_template", "save_template", "apply_template", "update_template", "delete_template", "reset_templates"]],
  ["미디어 · 임포트", ["upload_media", "import_pdf", "set_video_background"]],
  ["PPT 라이브러리", ["get_library_dir", "set_library_dir", "index_library", "search_library"]],
  ["테마 · 폰트", ["list_fonts"]],
  ["발표 제어", ["get_presentation_state", "present_goto", "present_blackout", "present_reload"]],
  ["시스템", ["list_network_addresses"]],
];

const byName = new Map(list().map((t) => [t.name, t]));
const assigned = new Set();

function paramsTable(schema) {
  const props = schema?.properties || {};
  const required = new Set(schema?.required || []);
  const keys = Object.keys(props);
  if (!keys.length) return "_(입력 없음)_\n";
  let out = "| 파라미터 | 타입 | 필수 | 기본값 | 설명 |\n|---|---|---|---|---|\n";
  for (const k of keys) {
    const p = props[k] || {};
    const type = p.type + (p.enum ? ` (${p.enum.join("\\|")})` : "") + (p.items?.type ? `[${p.items.type}]` : "");
    const def = p.default !== undefined ? "`" + JSON.stringify(p.default) + "`" : "";
    const desc = (p.description || "").replace(/\|/g, "\\|");
    out += `| \`${k}\` | ${type || ""} | ${required.has(k) ? "✔" : ""} | ${def} | ${desc} |\n`;
  }
  return out;
}

function toolBlock(t) {
  const rw = t.read ? "읽기 전용" : "쓰기";
  return `### \`${t.name}\`  _(${rw})_\n\n${t.description}\n\n${paramsTable(t.input_schema)}\n`;
}

let md = `# Lyra 도구 레퍼런스 (자동 생성)

> \`bun run scripts/gen-tools-md.js\` 로 레지스트리에서 자동 생성됩니다 — 항상 코드와 일치.
> 개념 모델·연결 방법·워크플로우는 [AGENTS.md](./AGENTS.md) 참고.
> 런타임에서 최신 스키마 확인: CLI \`bun run cli schema <이름>\`, MCP \`tools/list\`.

총 **${list().length}개** 도구.

`;

for (const [title, names] of CATEGORIES) {
  const tools = names.map((n) => byName.get(n)).filter(Boolean);
  tools.forEach((t) => assigned.add(t.name));
  if (!tools.length) continue;
  md += `## ${title}\n\n`;
  for (const t of tools) md += toolBlock(t);
}
const rest = list().filter((t) => !assigned.has(t.name));
if (rest.length) {
  md += `## 기타\n\n`;
  for (const t of rest) md += toolBlock(t);
}

mkdirSync(join(ROOT, "docs"), { recursive: true });
writeFileSync(join(ROOT, "docs/tools.md"), md);
console.log(`docs/tools.md 생성 — ${list().length}개 도구`);
