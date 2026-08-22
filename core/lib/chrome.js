// 헤드리스 크롬 실행파일 경로 탐지 — 슬라이드를 이미지/PDF로 굽는 데 쓴다.
// poppler.js·webp.js와 같은 방식: PATH → LYRA_CHROME → tools/ 드롭인 → 일반 설치 위치.
// 크롬(또는 엣지·크로미움)은 이 앱을 쓰는 PC엔 이미 있으므로 새 의존성이 아니다.
import { existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

function bundleDirs() {
  const dirs = [];
  try {
    for (const name of readdirSync(join(ROOT, "tools"))) {
      const base = join(ROOT, "tools", name);
      dirs.push(base, join(base, "bin"));
    }
  } catch {}
  return dirs;
}

export function findChrome() {
  if (process.env.LYRA_CHROME && existsSync(process.env.LYRA_CHROME)) return process.env.LYRA_CHROME;
  const win = process.platform === "win32";
  const mac = process.platform === "darwin";

  const exes = win
    ? ["chrome.exe", "msedge.exe", "chromium.exe"]
    : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"];
  for (const e of exes) { const p = Bun.which(e); if (p) return p; }

  const candidates = [];
  if (mac) {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    );
  } else if (win) {
    for (const base of ["C:\\Program Files", "C:\\Program Files (x86)", process.env.LOCALAPPDATA || ""]) {
      if (!base) continue;
      candidates.push(
        join(base, "Google\\Chrome\\Application\\chrome.exe"),
        join(base, "Microsoft\\Edge\\Application\\msedge.exe"),
        join(base, "Chromium\\Application\\chrome.exe"),
      );
    }
  } else {
    candidates.push("/usr/bin/google-chrome", "/usr/bin/chromium", "/snap/bin/chromium", "/usr/bin/microsoft-edge");
  }
  for (const d of bundleDirs()) for (const e of exes) candidates.push(join(d, e));

  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

export function chromeAvailable() { return !!findChrome(); }
