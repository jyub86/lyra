// 경로 한 곳 — 개발(bun run)과 배포(bun build --compile) 양쪽에서 같은 답을 준다.
//
// 왜 필요한가: 컴파일하면 `import.meta.url`이 실제 디스크가 아니라 바이너리 속
// 가상 경로(`/$bunfs/root/…`)를 가리킨다. 예전처럼 거기서 `../../data`를 계산하면
// 존재하지 않는 곳을 보게 되고, 서버는 뜨는데 편집기가 404가 난다(실측으로 확인).
// 반면 `process.execPath`는 컴파일된 바이너리의 **진짜 위치**를 준다.
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

// 컴파일된 단일 실행파일인가. (bun build --compile 산출물에서만 참)
export const COMPILED = import.meta.url.includes("/$bunfs/");

// 앱이 놓인 폴더. 배포판에서는 실행파일 옆, 개발에서는 저장소 루트.
// 번들해 둔 외부 도구(tools/ffmpeg 등)를 찾을 때 기준이 된다.
export const APP_DIR = COMPILED
  ? dirname(process.execPath)
  : normalize(join(dirname(fileURLToPath(import.meta.url)), "../.."));

// 정말 쓸 수 있는지 **실제로 써 본다**.
// accessSync(W_OK)를 쓰면 안 된다 — Windows에서는 디렉터리 ACL을 제대로 보지 않고
// 읽기 전용 속성만 확인해서, Program Files 같은 곳을 "쓰기 가능"으로 통과시킨다.
// 그러면 앱은 멀쩡히 뜨고 **첫 저장에서야** 실패한다(예배 준비 도중 최악의 시점).
function canWrite(dir) {
  const probe = join(dir, ".lyra-write-test");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, "");
    return true;
  } catch { return false; }
  finally { try { rmSync(probe, { force: true }); } catch {} }
}

// OS가 정한 앱 데이터 폴더 (실행파일 옆에 못 쓸 때의 대피처).
function osDataDir() {
  const home = homedir();
  if (process.platform === "win32") return join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Lyra");
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Lyra");
  return join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), "Lyra");
}

// 사용자 데이터(예배 DB·업로드·내보내기)가 사는 곳.
// 원칙은 **실행파일 옆 data/** — 폴더째 USB에 담아 옮길 수 있는 포터블 배포가 목적이다.
// 다만 Program Files·/Applications 처럼 쓰기가 막힌 곳에 두면 앱이 아예 못 뜨므로
// 그때만 OS 앱데이터로 물러난다. LYRA_DATA로 직접 지정할 수도 있다.
function resolveDataDir() {
  if (process.env.LYRA_DATA) {
    const p = normalize(process.env.LYRA_DATA);
    mkdirSync(p, { recursive: true });
    return p;
  }
  const side = join(APP_DIR, "data");
  if (!COMPILED || canWrite(side)) return side;
  const fallback = osDataDir();
  mkdirSync(fallback, { recursive: true });
  return fallback;
}

export const DATA_DIR = resolveDataDir();
export const dataPath = (...parts) => join(DATA_DIR, ...parts);
export const appPath = (...parts) => join(APP_DIR, ...parts);
