// 자동 업데이트 — GitHub Releases에서 새 버전을 받아 실행파일을 바꿔치기한다.
//
// 포터블 배포(실행파일 + data/)이므로 설치 관리자가 없다. 대신:
//   1) check_update  : Releases API로 최신 버전을 확인만 한다(받지 않는다)
//   2) apply_update  : 내 플랫폼용 zip을 받아 **검증 후** 실행파일을 교체한다
//
// 실행 중인 파일 교체: mac·Windows 모두 "실행 중인 파일을 지우거나 덮어쓰기"는 막혀도
// **이름 바꾸기는 허용**된다. 그래서 헌 파일을 .old로 옮기고 새 파일을 제자리에 둔 뒤,
// 다음 실행 때 .old를 지운다. 두 OS에 같은 구현이 통한다.
//
// 안전: HTTPS·고정 저장소만. 릴리스에 올린 SHA256 목록(checksums.txt)이 있으면 반드시 대조하고,
// 없으면 받지 않는다 — 내려받은 것을 그대로 실행하는 경로라 여기서 타협하면 안 된다.
import { register } from "./registry.js";
import { readFileSync, writeFileSync, renameSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { ASSETS } from "../assets.generated.js";
import { COMPILED, APP_DIR } from "../lib/paths.js";

// LYRA_REPO는 개발 중 테스트 저장소를 가리키기 위한 것 — **사용자 문서에 넣지 말 것**.
// 업데이트 출처를 바꾸는 값이라 남이 설정할 수 있으면 임의 코드를 받게 된다.
const REPO = process.env.LYRA_REPO || "jyub86/lyra";
// LYRA_UPDATE_API도 같은 성격(테스트용 가짜 릴리스 서버를 물릴 때). 기본은 GitHub.
const API_BASE = process.env.LYRA_UPDATE_API || "https://api.github.com";
const API = `${API_BASE}/repos/${REPO}/releases/latest`;

// 예배 준비 중 네트워크가 불안정해도 매달리지 않게. 릴리스 조회는 짧게, 내려받기는 넉넉히.
const META_TIMEOUT = 8000;
const DOWNLOAD_TIMEOUT = 10 * 60 * 1000;
// 받을 수 있는 최대 크기(현재 가장 큰 배포판이 117MB). 터무니없는 응답을 메모리에 올리지 않는다.
const MAX_ASSET_BYTES = 400 * 1024 * 1024;

export const VERSION = (() => {
  try { return JSON.parse(readFileSync(ASSETS.get("@package.json"), "utf8")).version; }
  catch { return "0.0.0"; }
})();

// 이 컴퓨터가 받아야 할 배포 이름 (scripts/build.js의 TARGETS와 같은 문자열)
export function platformKey() {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return process.arch === "arm64" ? "mac-apple-silicon" : "mac-intel";
  return null;   // 리눅스 배포는 아직 없다
}

// "1.2.10" > "1.2.9" 가 되도록 숫자로 비교한다(문자열 비교면 거꾸로 나온다).
export function isNewer(latest, current) {
  const a = String(latest).replace(/^v/, "").split(".").map(Number);
  const b = String(current).replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

// 릴리스 조회 결과를 잠시 재사용한다.
// 편집기를 새로고침할 때마다 check_update가 불리는데, GitHub 비인증 API는 **IP당 시간당 60회**라
// 작업 중 새로고침이 잦으면 한도에 걸려 조용히 실패한다("업데이트가 안 뜬다"로만 보여 원인 찾기 어렵다).
const CACHE_MS = 6 * 60 * 60 * 1000;
let cache = { at: 0, data: null };

async function latestRelease({ force = false } = {}) {
  if (!force && cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
  const res = await fetch(API, {
    headers: { accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(META_TIMEOUT),
  });
  if (!res.ok) throw new Error(`릴리스 정보를 가져오지 못했습니다 (HTTP ${res.status})`);
  const data = await res.json();
  cache = { at: Date.now(), data };
  return data;
}

async function download(url, { timeout = DOWNLOAD_TIMEOUT, max = MAX_ASSET_BYTES } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`내려받기 실패 (HTTP ${res.status})`);
  const len = Number(res.headers.get("content-length") || 0);
  if (len > max) throw new Error(`파일이 너무 큽니다 (${(len / 1048576).toFixed(0)}MB)`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > max) throw new Error(`파일이 너무 큽니다 (${(buf.length / 1048576).toFixed(0)}MB)`);
  return buf;
}

// 실행파일을 새 것으로 바꾼다. 실행 중인 파일이라 OS마다 허용되는 동작이 다르다.
//  · POSIX: 기존 파일 **위로 rename이 원자적으로** 되고 실행 중인 프로세스도 멀쩡하다(실측).
//           → 한 번에 끝나므로 "실행파일이 사라진 중간 상태"가 아예 없다.
//  · Windows: 실행 중인 파일 위로는 못 옮긴다. 대신 **이름 바꾸기는 허용**되므로
//           헌 파일을 .old로 비켜 두고 새 파일을 제자리에 놓는다(다음 실행 때 .old 삭제).
function swapBinary(current, next, old) {
  if (process.platform !== "win32") {
    renameSync(next, current);   // 원자적 교체
    return;
  }
  rmSync(old, { force: true });
  renameSync(current, old);
  try {
    renameSync(next, current);
  } catch (e) {
    renameSync(old, current);    // 되돌린다 — 실패한 채로 두면 앱이 사라진다
    throw new Error(`교체 실패: ${e.message}`);
  }
}

register({
  name: "check_update",
  description: "새 버전이 나왔는지 GitHub Releases에서 확인한다(내려받지는 않는다). " +
    "개발 모드(소스 실행)에서는 확인하지 않는다.",
  read: true,
  input_schema: {
    type: "object",
    properties: { force: { type: "boolean", default: false, description: "캐시를 무시하고 지금 다시 확인" } },
  },
  handler: async ({ force }) => {
    if (!COMPILED) return { current: VERSION, available: false, reason: "개발 모드에서는 업데이트를 확인하지 않습니다" };
    const key = platformKey();
    if (!key) return { current: VERSION, available: false, reason: "이 운영체제용 배포판이 없습니다" };
    try {
      const rel = await latestRelease({ force });
      const latest = String(rel.tag_name || "").replace(/^v/, "");
      const asset = (rel.assets || []).find((a) => a.name.includes(key) && a.name.endsWith(".zip"));
      return {
        current: VERSION,
        latest,
        available: !!asset && isNewer(latest, VERSION),
        notes: rel.body || "",
        published_at: rel.published_at,
        asset: asset?.name,
        size: asset?.size,
      };
    } catch (e) {
      return { current: VERSION, available: false, reason: e.message };
    }
  },
});

register({
  name: "apply_update",
  description: "새 버전을 내려받아 실행파일을 교체한다. 받은 파일은 릴리스의 checksums.txt와 " +
    "SHA256을 대조해 검증하며, 대조할 수 없으면 중단한다. 교체 후에는 Lyra를 다시 시작해야 한다. " +
    "예배·업로드 자료(data 폴더)는 건드리지 않는다.",
  input_schema: { type: "object", properties: {} },
  handler: async () => {
    if (!COMPILED) throw new Error("개발 모드에서는 업데이트할 수 없습니다 (git pull 을 쓰세요)");
    const key = platformKey();
    if (!key) throw new Error("이 운영체제용 배포판이 없습니다");

    const rel = await latestRelease({ force: true });   // 설치 직전엔 캐시를 믿지 않는다
    const latest = String(rel.tag_name || "").replace(/^v/, "");
    if (!isNewer(latest, VERSION)) return { ok: true, updated: false, message: `이미 최신입니다 (${VERSION})` };

    const asset = (rel.assets || []).find((a) => a.name.includes(key) && a.name.endsWith(".zip"));
    if (!asset) throw new Error(`이 운영체제용 파일이 릴리스에 없습니다 (${key})`);

    // 1) 체크섬 목록 먼저 — 없으면 아예 받지 않는다.
    const sumAsset = (rel.assets || []).find((a) => a.name === "checksums.txt");
    if (!sumAsset) throw new Error("릴리스에 checksums.txt가 없어 무결성을 확인할 수 없습니다. 수동으로 받아 주세요.");
    const sums = new TextDecoder().decode(await download(sumAsset.browser_download_url, { timeout: META_TIMEOUT, max: 1 << 20 }));
    const want = sums.split("\n").map((l) => l.trim().split(/\s+/))
      .find((p) => p[1]?.replace(/^\*/, "") === asset.name)?.[0];
    if (!want) throw new Error(`checksums.txt 에 ${asset.name} 항목이 없습니다`);

    // 2) 내려받아 대조
    const buf = await download(asset.browser_download_url);
    const got = new Bun.CryptoHasher("sha256").update(buf).digest("hex");
    if (got !== want.toLowerCase()) throw new Error("내려받은 파일의 체크섬이 맞지 않습니다 (중단)");

    // 3) zip에서 실행파일만 꺼낸다
    const files = unzipSync(buf);
    const exeName = process.platform === "win32" ? "Lyra.exe" : "Lyra";
    const entry = Object.keys(files).find((n) => n.split("/").pop() === exeName);
    if (!entry) throw new Error(`압축 안에 ${exeName} 이 없습니다`);

    // 4) 교체
    const cur = process.execPath;
    const next = join(APP_DIR, `${exeName}.new`);
    writeFileSync(next, files[entry]);
    if (process.platform !== "win32") chmodSync(next, 0o755);
    try {
      swapBinary(cur, next, join(APP_DIR, `${exeName}.old`));
    } catch (e) {
      rmSync(next, { force: true });   // 반쯤 받아 둔 파일을 남기지 않는다
      throw e;
    }
    return { ok: true, updated: true, from: VERSION, to: latest, restart_required: true };
  },
});

// 지난 업데이트가 남긴 .old 파일 정리 (다음 실행 때 지워진다)
export function cleanupOldBinary() {
  if (!COMPILED) return;
  const exeName = process.platform === "win32" ? "Lyra.exe" : "Lyra";
  try { rmSync(join(APP_DIR, `${exeName}.old`), { force: true }); } catch {}
}

register({
  name: "get_version",
  description: "지금 실행 중인 Lyra의 버전과 실행 방식(배포판/개발 모드)을 반환한다.",
  read: true,
  input_schema: { type: "object", properties: {} },
  handler: () => ({ version: VERSION, compiled: COMPILED, platform: platformKey() || process.platform }),
});
