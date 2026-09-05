// System tools (design §0 Tool-First) — 실행 환경 정보.
import { register } from "./registry.js";
import { networkInterfaces, platform, release } from "node:os";
import { findPoppler } from "../lib/poppler.js";
import { officeImportAvailable } from "../lib/pdf-import.js";
import { findCwebp } from "../lib/webp.js";
import { findChrome } from "../lib/chrome.js";
import { ffmpegAvailable } from "../lib/ffmpeg.js";

register({
  name: "list_network_addresses",
  description: "이 서버 머신의 LAN IPv4 주소 목록을 반환한다. 같은 네트워크의 다른 기기에서 접속 주소를 만들 때 쓴다.",
  read: true,
  input_schema: { type: "object", properties: {} },
  handler: () => {
    const addresses = [];
    for (const list of Object.values(networkInterfaces())) {
      for (const ni of list || []) {
        if (ni.family === "IPv4" && !ni.internal) addresses.push(ni.address);
      }
    }
    return { addresses };
  },
});

// 옮겨 간 PC(특히 윈도우)에서 "왜 이 기능만 안 되지"를 한 번에 확인하기 위한 점검표.
// 설치가 덜 된 항목과 그때 못 쓰는 기능을 같이 알려준다.
register({
  name: "check_environment",
  description: "실행 환경 점검 — 필수 모듈(pdfjs-dist·fflate) 설치 여부와 선택 외부 프로그램(LibreOffice·poppler·cwebp) 탐지 결과를 반환한다. 다른 PC로 옮긴 뒤 기능이 안 될 때 원인 확인용.",
  read: true,
  input_schema: { type: "object", properties: {} },
  handler: async () => {
    const mod = async (spec) => { try { await import(spec); return true; } catch { return false; } };
    const deps = {
      "pdfjs-dist": await mod("pdfjs-dist/legacy/build/pdf.mjs"),   // 성구 추출 · PDF 읽기
      fflate: await mod("fflate"),                                   // 라이브러리 PPT 내용 검색
    };
    const externals = {
      chrome: !!findChrome(),                      // 슬라이드 → 이미지 내보내기 렌더
      libreoffice: officeImportAvailable(),        // .pptx/.ppt/.odp 가져오기
      pdftoppm: !!findPoppler("pdftoppm"),         // PDF → 이미지 슬라이드 · 이미지 내보내기 가속
      pdftotext: !!findPoppler("pdftotext"),       // PDF 내용 검색(성구는 없어도 동작)
      cwebp: !!findCwebp(),                        // 이미지 WebP 변환(용량↓, 없으면 PNG)
      ffmpeg: ffmpegAvailable(),                    // 배경 영상 루프 변환(make_loop_video)
    };
    const missing = [];
    if (!deps["pdfjs-dist"]) missing.push("pdfjs-dist 없음 → 성구 추출 불가. Lyra 폴더에서 `bun install`");
    if (!deps.fflate) missing.push("fflate 없음 → 라이브러리 내용 검색 불가. `bun install`");
    if (!externals.libreoffice) missing.push("LibreOffice 없음 → PPT 가져오기 불가 (설치 파일로 설치)");
    if (!externals.pdftoppm) missing.push("poppler 없음 → PDF 가져오기 불가 · 이미지 내보내기가 장당 스크린샷으로 느려짐 (tools/ 폴더에 압축 해제)");
    if (!externals.chrome) missing.push("크롬 없음 → 이미지 내보내기 불가 (크롬·엣지 설치 또는 LYRA_CHROME 지정)");
    if (!externals.ffmpeg) missing.push("ffmpeg 없음 → 배경 영상 루프 변환 불가 (mac: brew install ffmpeg · Win: tools/ 폴더나 PATH에 ffmpeg.exe·ffprobe.exe)");
    return {
      platform: `${platform()} ${release()}`,
      bun: Bun.version,
      cwd: process.cwd(),
      deps,
      externals,
      ok: missing.length === 0,
      missing,
    };
  },
});
