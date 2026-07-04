// Font tools — self-hosted 무료 웹폰트 목록 (design §0 Tool-First).
// 폰트 파일·CSS·매니페스트는 `bun run scripts/build-fonts.js`가 data/fonts/에 생성.
// 요소(text/bible/hymn/reading)의 `font`=family 문자열, 서비스 기본은 theme_overrides.font.
import { register } from "./registry.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST = join(dirname(fileURLToPath(import.meta.url)), "../../data/fonts/fonts.json");

register({
  name: "list_fonts",
  description: "사용 가능한 self-host 웹폰트 목록을 반환한다. 각 항목의 family를 요소 font 또는 서비스 기본 글꼴로 지정한다.",
  read: true,
  input_schema: { type: "object", properties: {} },
  handler: () => {
    try { return { fonts: JSON.parse(readFileSync(MANIFEST, "utf8")) }; }
    catch { return { fonts: [] }; }
  },
});
