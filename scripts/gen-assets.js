// 정적 자산(편집기·발표 화면·테마·폰트)을 바이너리에 심기 위한 목록을 만든다.
//
// Bun은 `import p from "./a.css" with { type: "file" }` 로 가져온 파일만 실행파일에
// 넣어준다. 폴더를 통째로 넣는 문법은 없으므로 이 스크립트가 파일을 훑어 import 목록을
// 만든다. 개발 모드에서는 같은 import가 **디스크의 실제 경로**를 돌려주므로
// (실측 확인) 서버 코드는 한 갈래로 유지된다 — 고친 client 파일이 새로고침만으로 반영된다.
//
// 실행: bun run scripts/gen-assets.js   (build.js가 빌드 전에 자동 실행)
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "core", "assets.generated.js");

// [디스크 폴더, 브라우저에서의 URL 접두어]
const TREES = [
  ["client/shared", "/shared"],
  ["client/editor", "/editor"],
  ["client/presenter", "/presenter"],
  ["client/export", "/export"],
  ["themes", "/themes"],
  ["data/fonts", "/fonts"],      // 폰트는 사용자 데이터가 아니라 앱의 일부 → 함께 심는다
];
const EXTRA = [
  // 코드가 fs로 읽는 파일 (키는 임의 이름)
  ["core/db/schema.sql", "@schema.sql"],
  ["package.json", "@package.json"],   // 버전 표시·업데이트 확인용
];

// 요소 짝짓기 규칙을 편집기 쪽으로 복사해 둔다.
// 원본은 **core/lib/element-match.js 하나뿐**이고 이 사본은 생성물이다(직접 고치지 말 것).
// Bun 번들러가 같은 파일을 "모듈"이자 "임베드 자산"으로 동시에 다룰 수 없어서 사본이 필요하다.
// 이 스크립트는 빌드와 `bun run dev` 앞에서 항상 돌므로 사본이 낡을 틈이 없다.
function syncSharedRule() {
  const src = join(ROOT, "core/lib/element-match.js");
  const dst = join(ROOT, "client/shared/element-match.js");
  const body = readFileSync(src, "utf8");
  const head = "// ⚠️ 자동 생성 — core/lib/element-match.js 의 사본입니다. 원본을 고치세요.\n";
  const next = head + body;
  if (!existsSync(dst) || readFileSync(dst, "utf8") !== next) writeFileSync(dst, next);
}
syncSharedRule();

const SKIP = /(^\.|\.map$|\.DS_Store)/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.test(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const entries = [];
const warnings = [];
for (const [rel, prefix] of TREES) {
  const base = join(ROOT, rel);
  let files = [];
  try { files = walk(base); } catch { files = []; }
  // 비어 있으면 **소리 내어 알린다** — 예전엔 조용히 건너뛰어서, 폰트를 빌드하지 않은 채로
  // 만든 배포판이 경고 하나 없이 "글꼴 0종" 상태로 나갔다.
  if (!files.length) warnings.push(`${rel} 이(가) 비어 있습니다 → ${prefix} 자산 없이 빌드됩니다`);
  for (const f of files) {
    entries.push([`${prefix}/${relative(base, f).split("\\").join("/")}`, relative(ROOT, f).split("\\").join("/")]);
  }
}
for (const [rel, key] of EXTRA) entries.push([key, rel]);
entries.sort((a, b) => a[0].localeCompare(b[0]));

const lines = [
  "// ⚠️ 자동 생성 파일 — 직접 고치지 마세요. `bun run scripts/gen-assets.js`",
  "// 정적 자산을 단일 실행파일에 심는다(개발 모드에선 디스크 실제 경로를 돌려준다).",
];
entries.forEach(([, file], i) => lines.push(`import a${i} from ${JSON.stringify("../" + file)} with { type: "file" };`));
lines.push("", "export const ASSETS = new Map([");
entries.forEach(([url], i) => lines.push(`  [${JSON.stringify(url)}, a${i}],`));
lines.push("]);", "");

writeFileSync(OUT, lines.join("\n"));
console.log(`자산 ${entries.length}개 → ${relative(ROOT, OUT)}`);
for (const [, prefix] of TREES) {
  const n = entries.filter(([u]) => u.startsWith(prefix + "/")).length;
  console.log(`  ${String(n).padStart(4)}  ${prefix}`);
}
for (const w of warnings) console.warn(`  ⚠️  ${w}`);
if (warnings.length) console.warn("     (폰트는 `bun run scripts/build-fonts.js` 로 만듭니다)");
