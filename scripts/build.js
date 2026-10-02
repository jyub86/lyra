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

  · macOS — "악성 코드가 없음을 확인할 수 없습니다" 경고가 뜨면 (공증 전이라 그렇습니다)
      방법 1 (제일 확실) — 터미널에서 이 폴더로 이동해 한 번만 실행:
            xattr -dr com.apple.quarantine .
      방법 2 — 경고창에서 [완료] → 시스템 설정 → 개인정보 보호 및 보안 →
            아래로 스크롤 → 보안 항목의 [그래도 열기] → 암호 확인 → [열기]
      ※ macOS 15(Sequoia)부터는 "오른쪽 클릭 → 열기"로는 통과되지 않습니다.
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

// macOS 실행파일 서명.
//
// **반드시 해야 한다.** `bun build --compile` 은 자산을 Mach-O 뒤에 덧붙이는데 그게 링커의
// ad-hoc 서명을 깨뜨린다(`codesign --verify` → "code or signature have been modified").
// 내 맥에서는 격리 속성이 없어 그냥 실행되지만, **인터넷에서 받으면 Gatekeeper가 전체 검증을
// 돌려 "손상되었기 때문에 열 수 없습니다. 휴지통으로 이동"** 이라고 띄운다(0.1.1 실기에서 발생).
// 사용자는 이걸 보고 바이러스로 오해하고 지운다 — 배포에서 가장 치명적인 첫인상.
//
// LYRA_SIGN_IDENTITY 가 있으면 Developer ID로 서명한다(+ LYRA_NOTARY_PROFILE 이 있으면 공증까지).
// 없으면 ad-hoc(`-`)으로 서명한다 — 서명은 유효해지지만 공증은 아니라서 첫 실행에
// "확인되지 않은 개발자" 안내가 뜬다(우클릭 → 열기로 통과 가능).
async function signMac(exe, label) {
  const identity = process.env.LYRA_SIGN_IDENTITY || "-";
  const adhoc = identity === "-";
  await Bun.$`codesign --force --timestamp=${adhoc ? "none" : "http://timestamp.apple.com/ts01"} ${adhoc ? [] : ["--options", "runtime"]} --sign ${identity} ${exe}`.quiet();
  // 서명이 실제로 유효한지 확인하고 넘어간다 — 조용히 깨진 채 배포되면 안 된다.
  await Bun.$`codesign --verify --strict ${exe}`.quiet();
  return adhoc ? "ad-hoc 서명" : `서명: ${identity.replace(/\(.*/, "").trim()}`;
}

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

  let note = "";
  if (target.startsWith("bun-darwin")) {
    if (process.platform !== "darwin") {
      note = " ⚠️ 서명 안 됨(맥에서 빌드해야 함 — 받는 쪽에서 '손상됨'이 뜬다)";
    } else {
      note = " · " + await signMac(exe, t.name);
    }
  }

  writeFileSync(join(outDir, "README.txt"), README);   // 한글 파일명은 zip에서 깨진다(ASCII 유지)
  const mb = (statSync(exe).size / 1048576).toFixed(0);
  console.log(`${mb}MB · ${((Date.now() - t0) / 1000).toFixed(1)}초${note}`);
}

console.log("\n완료. dist/ 폴더를 압축해 배포하세요.");
