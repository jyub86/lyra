// dist/ 의 빌드 결과를 배포용 zip + checksums.txt 로 묶는다.
//
//   bun run scripts/build.js --all      먼저 세 플랫폼 빌드
//   bun run scripts/release.js          → dist/release/*.zip + checksums.txt
//
// checksums.txt 는 **자동 업데이트의 안전장치**다. apply_update가 내려받은 파일의
// SHA256을 여기에 적힌 값과 대조하고, 목록이 없으면 설치를 아예 거부한다.
// 따라서 릴리스에 zip만 올리고 이 파일을 빼먹으면 자동 업데이트가 동작하지 않는다.
import { readdirSync, statSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const OUT = join(DIST, "release");
const { version } = await Bun.file(join(ROOT, "package.json")).json();

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, base, out);
    else out.push(relative(base, full));
  }
  return out;
}

const builds = readdirSync(DIST).filter((n) => n.startsWith(`Lyra-${version}-`) && statSync(join(DIST, n)).isDirectory());
if (!builds.length) {
  console.error(`dist/ 에 Lyra-${version}-* 폴더가 없습니다. 먼저 'bun run scripts/build.js --all' 을 실행하세요.`);
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const sums = [];
for (const name of builds) {
  const dir = join(DIST, name);
  const files = {};
  for (const rel of walk(dir)) {
    // 실행 권한을 zip에 **직접 기록**해야 한다. 안 그러면 압축을 푼 사용자에게
    // rw-r--r-- 로 떨어져 더블클릭이 안 된다(실측으로 걸렸다).
    // zip의 외부속성 상위 16비트 = unix 모드, os=3 은 Unix 표기를 뜻한다.
    const mode = rel.endsWith(".txt") ? 0o644 : 0o755;
    files[`${name}/${rel}`] = [new Uint8Array(readFileSync(join(dir, rel))), { attrs: mode << 16, os: 3 }];
  }
  const zipped = zipSync(files, { level: 6 });
  const zipName = `${name}.zip`;
  writeFileSync(join(OUT, zipName), zipped);
  const sha = new Bun.CryptoHasher("sha256").update(zipped).digest("hex");
  sums.push(`${sha}  ${zipName}`);
  console.log(`${zipName}  ${(zipped.length / 1048576).toFixed(0)}MB`);
}

writeFileSync(join(OUT, "checksums.txt"), sums.join("\n") + "\n");
console.log(`\ndist/release/ 에 ${builds.length}개 zip + checksums.txt`);
console.log(`\n업로드: gh release create v${version} dist/release/* --title "Lyra ${version}" --notes "..."`);
console.log("⚠️  checksums.txt 를 반드시 함께 올리세요 — 없으면 자동 업데이트가 거부됩니다.");
