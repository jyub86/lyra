// 예배 공유 패키지(.lyra) — 예배 하나를 파일 하나로 주고받는다.
//
// 왜 JSON 대신 패키지인가: export_service는 첨부(배경 영상·이미지·음악)를 base64로 JSON 안에
// 넣는다. base64는 1.33배로 부풀고(실측 398MB 영상 → 531MB JSON), 브라우저가 그 문자열과
// Blob을 통째로 메모리에 들고 있어야 해서 큰 예배는 내보내다 죽는다.
// → zip 컨테이너에 파일을 **그대로** 담고, 서버가 디스크에 구운 뒤 스트리밍으로 내려준다.
//
// 구조 (안의 service.json은 기존 worship-service/v2 그대로 → 코드·호환성 유지):
//   service.json          assets 배열은 비우고 asset_refs(url·bytes·sha256)만 남긴다
//   assets/<저장명>        uploads의 파일명을 그대로 쓴다
//
// 압축은 하지 않는다(level 0). mp4·webm·webp·png는 이미 압축돼 있어 재압축해도 거의 안 줄고
// 시간만 오래 걸린다. 이미지 내보내기(zipSync level 0)와 같은 정책.
//
// 파일명을 그대로 두는 이유: 가져올 때 uploads에 같은 이름이 있으면 **그 파일을 재사용**한다.
// 저장명이 ULID라 이름이 같으면 같은 파일이다 → 같은 배경 영상을 쓰는 예배를 여러 개
// 가져와도 디스크에 한 번만 저장되고, url 재매핑도 필요 없다.
import { register, execute } from "./registry.js";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { zipSync, unzipSync, strFromU8, strToU8 } from "fflate";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DATA_DIR = normalize(join(ROOT, "data"));
const UPLOAD_DIR = join(DATA_DIR, "uploads");
const OUT_DIR = join(DATA_DIR, "exports");
const SHARE_FORMAT = "worship-service/v2";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// "/uploads/…" → 실제 경로. 경로 이탈 차단.
function assetPath(url) {
  const full = normalize(join(DATA_DIR, String(url || "")));
  return full.startsWith(DATA_DIR) ? full : null;
}

// 파일명에 쓸 수 없는 문자를 정리(예배 제목이 그대로 파일명이 된다).
const safeName = (s) => String(s || "service").replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_").slice(0, 80);

register({
  name: "export_service_package",
  description: "예배 하나를 .lyra 패키지(zip) 파일로 내보낸다. 배경 영상·이미지·음악을 파일 그대로 담아 " +
    "base64 JSON보다 작고 메모리를 쓰지 않는다. include_assets=false면 **첨부를 빼고 참조만** 담는다 " +
    "— 받는 쪽에 같은 파일이 이미 있을 때(매주 같은 배경 영상) 수백 MB가 수십 KB가 된다.",
  input_schema: {
    type: "object",
    properties: {
      service_id: { type: "string" },
      include_assets: { type: "boolean", default: true, description: "false면 첨부 파일을 빼고 참조만 담는다" },
    },
    required: ["service_id"],
  },
  handler: async ({ service_id, include_assets = true }, ctx) => {
    // 첨부는 여기서 직접 담으므로 base64는 만들지 않는다(메모리·시간 절약).
    const payload = await execute("export_service", { service_id, assets: false }, ctx);
    const refs = payload.asset_refs || [];

    const files = {};
    const included = [];
    const skipped = [];
    for (const r of refs) {
      const p = assetPath(r.url);
      if (!p || !existsSync(p)) { skipped.push({ url: r.url, reason: "파일 없음" }); continue; }
      const buf = new Uint8Array(readFileSync(p));
      r.sha256 = sha256(buf);
      r.bytes = buf.length;
      if (include_assets) { files[`assets/${basename(r.url)}`] = buf; included.push(r.url); }
    }
    // asset_refs는 항상 남긴다 — 첨부를 뺐어도 받는 쪽이 "무엇이 필요한지" 알 수 있어야 한다.
    payload.assets = [];
    payload.asset_refs = refs;
    payload.package = { include_assets, created_at: new Date().toISOString() };
    files["service.json"] = strToU8(JSON.stringify(payload, null, 2));

    mkdirSync(OUT_DIR, { recursive: true });
    // 첨부 포함/제외를 이름으로 구분한다 — 같은 이름이면 한쪽이 다른 쪽을 덮어써서
    // "첨부가 든 줄 알았는데 참조뿐"인 파일을 건네게 된다(실제로 그렇게 당했다).
    const suffix = include_assets ? "" : "_참조만";
    const name = `${payload.date || "service"}_${safeName(payload.worship_part)}_${safeName(payload.title)}${suffix}.lyra`;
    const out = join(OUT_DIR, name);
    writeFileSync(out, zipSync(files, { level: 0 }));   // 이미 압축된 미디어 → 재압축 안 함
    return {
      path: out, filename: name, bytes: statSync(out).size,
      slides: (payload.slides || []).length,
      assets: included.length, assets_total: refs.length, skipped,
      include_assets,
    };
  },
});

// .lyra(zip) 또는 예전 .json 페이로드를 모두 받는다.
// zip은 앞 2바이트가 "PK" → 그걸로 구분한다(확장자를 믿지 않는다).
function readPackage(bytes) {
  const isZip = bytes.length > 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!isZip) {
    try { return { payload: JSON.parse(new TextDecoder().decode(bytes)), entries: {} }; }
    catch { throw new Error("패키지를 읽지 못했습니다(.lyra 또는 예배 JSON이 아닙니다)"); }
  }
  const entries = unzipSync(bytes);
  const meta = entries["service.json"];
  if (!meta) throw new Error(".lyra 안에 service.json이 없습니다");
  return { payload: JSON.parse(strFromU8(meta)), entries };
}

register({
  name: "import_service_package",
  description: "예배 패키지(.lyra) 또는 예배 JSON 파일을 읽어 새 예배로 가져온다. " +
    "첨부는 uploads에 같은 이름이 이미 있으면 재사용하고(디스크 절약), 패키지에 없으면 " +
    "무엇이 빠졌는지 알려주되 나머지는 정상 가져온다.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "서버의 .lyra 또는 .json 파일 경로" },
      title: { type: "string", description: "가져올 제목(생략 시 패키지 제목)" },
    },
    required: ["path"],
  },
  handler: async ({ path, title }, ctx) => {
    if (!existsSync(path)) throw new Error(`파일이 없습니다: ${path}`);
    return importPackageBytes(new Uint8Array(readFileSync(path)), title, ctx);
  },
});

// 업로드된 바이트에서 바로 가져오기(HTTP 멀티파트가 쓴다).
export async function importPackageBytes(bytes, title, ctx) {
  const { payload, entries } = readPackage(bytes);
  if (payload.format !== SHARE_FORMAT) {
    throw new Error(`지원하지 않는 형식입니다: ${payload.format ?? "알 수 없음"}`);
  }

  // 첨부 복원: ① uploads에 같은 이름이 있으면 재사용 ② 패키지에 있으면 꺼내 쓰기 ③ 없으면 기록
  mkdirSync(UPLOAD_DIR, { recursive: true });
  const restored = [], reused = [], missing = [];
  for (const r of payload.asset_refs || []) {
    const name = basename(String(r.url || ""));
    if (!name) continue;
    const dest = join(UPLOAD_DIR, name);
    if (existsSync(dest)) { reused.push(r.url); continue; }
    const data = entries[`assets/${name}`];
    if (!data) { missing.push(r.url); continue; }
    writeFileSync(dest, data);
    restored.push(r.url);
  }

  // 예전 JSON(assets base64 포함)도 계속 받는다 → import_service가 그 경로를 이미 처리한다.
  const svc = await execute("import_service", { payload, title }, ctx);
  return { ...svc, restored: restored.length, reused: reused.length, missing };
}
