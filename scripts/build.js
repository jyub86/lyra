// 배포용 단일 실행파일을 만든다 (bun build --compile).
//
//   bun run scripts/build.js            현재 OS용 하나
//   bun run scripts/build.js --all      mac(arm64/x64) + windows(x64) 전부
//
// 산출물: dist/Lyra-<버전>-<플랫폼>/  (실행파일 + README + 빈 data/)
// 사용자는 압축을 풀고 더블클릭만 하면 된다 — Bun 설치도, 인터넷도, 터미널도 필요 없다.
// 자산(편집기·발표 화면·테마·폰트·schema.sql)은 바이너리 안에 들어간다.
import { existsSync, mkdirSync, rmSync, writeFileSync, statSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const { version } = await Bun.file(join(ROOT, "package.json")).json();

// Bun 타깃 → 배포 이름 / 실행파일 이름
const TARGETS = {
  "bun-darwin-arm64": { name: "mac-apple-silicon", exe: "Lyra" },
  "bun-darwin-x64": { name: "mac-intel", exe: "Lyra" },
  "bun-windows-x64": { name: "windows", exe: "Lyra.exe" },
};

const HERE = `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const args = process.argv.slice(2);
const wanted = args.includes("--all") ? Object.keys(TARGETS) : [TARGETS[HERE] ? HERE : "bun-darwin-arm64"];

// 자산 목록을 먼저 새로 만든다 — client/를 고쳤는데 빌드에 안 들어가는 사고를 막는다.
console.log("자산 목록 생성…");
await Bun.$`bun run ${join(ROOT, "scripts/gen-assets.js")}`.cwd(ROOT);

const README = `Lyra — 주일예배 프레젠테이션

■ 실행
  이 폴더의 Lyra 를 더블클릭하세요. 잠시 뒤 브라우저가 열리면서 편집기가 나타납니다.
  같이 떠 있는 검은 창이 Lyra 본체입니다 — 예배가 끝날 때까지 닫지 마세요.
  (닫으면 Lyra가 종료되고 발표 화면도 함께 꺼집니다.)

  · macOS에서 "확인되지 않은 개발자" 경고가 뜨면
    Lyra를 마우스 오른쪽 클릭 → [열기] → [열기] 를 한 번만 해주세요.
  · Windows에서 "PC를 보호했습니다" 창이 뜨면
    [추가 정보] → [실행] 을 눌러주세요.

■ 데이터
  예배·이미지·영상은 모두 이 폴더의 data/ 안에 저장됩니다.
  폴더째 USB에 복사해 다른 PC에서 그대로 이어서 쓸 수 있습니다.
  (쓰기가 막힌 위치에 두면 사용자 폴더로 자동 대피합니다 — 실행 시 안내됩니다.)

■ 성경·찬송가·교독문
  저작권 자료라서 배포판에는 들어 있지 않습니다.
  준비한 bible.json / hymns.json / readings.json 을 data/source/ 에 넣고
  Lyra를 다시 실행하면 자동으로 등록됩니다.
  (없어도 자유 슬라이드·이미지·PPT 가져오기는 그대로 쓸 수 있습니다.)

■ 선택 기능에 필요한 프로그램 (없어도 나머지는 동작합니다)
  · 크롬       PDF·이미지로 내보내기
  · LibreOffice  PPT 파일 가져오기
  · poppler     PDF 가져오기·내용 검색
  · ffmpeg      배경 영상 루프 굽기

버전 ${version}
`;

for (const target of wanted) {
  const t = TARGETS[target];
  const outDir = join(DIST, `Lyra-${version}-${t.name}`);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, "data"), { recursive: true });

  const exe = join(outDir, t.exe);
  process.stdout.write(`${t.name} 빌드 중… `);
  const t0 = Date.now();
  await Bun.$`bun build ${join(ROOT, "server/index.js")} --compile --target=${target} --outfile=${exe}`
    .cwd(ROOT).quiet();
  writeFileSync(join(outDir, "README.txt"), README);   // 한글 파일명은 zip에서 깨진다(ASCII 유지)
  const mb = (statSync(exe).size / 1048576).toFixed(0);
  console.log(`${mb}MB · ${((Date.now() - t0) / 1000).toFixed(1)}초 → ${outDir.replace(ROOT + "/", "")}`);
}

console.log("\n완료. dist/ 폴더를 압축해 배포하세요.");
