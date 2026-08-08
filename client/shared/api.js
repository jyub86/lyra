// Tiny browser client for the HTTP tool API. Every UI action is a tool call —
// the UI is just one consumer of the registry (design §0).

// 이 탭의 식별자. 서버가 "내용 바뀜"을 모든 클라이언트에 알릴 때 이 값을 함께 실어보내,
// 각 탭이 자기가 만든 변경은 무시하고 남의 변경만 반영하게 한다(둘이서 동시 편집).
export const CLIENT_ID = (crypto.randomUUID?.() || String(Math.random()).slice(2)) + "";

export async function callTool(name, args = {}) {
  const res = await fetch(`/api/tools/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-lyra-client": CLIENT_ID },
    body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${name} failed (${res.status})`);
  return body;
}

export async function uploadFile(file) {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/upload", { method: "POST", body: fd, headers: { "x-lyra-client": CLIENT_ID } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "업로드 실패");
  return body; // { url, filename }
}

const themeCache = new Map();
export async function loadTheme(id) {
  if (themeCache.has(id)) return themeCache.get(id);
  const theme = await fetch(`/themes/${id}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  themeCache.set(id, theme);
  return theme;
}

// Merge per-service overrides { background?, accent?, font? } onto a base theme.
// accent also drives the ref/label/leader color. font = 서비스 기본 글꼴(family).
// Returns a fresh object.
export function mergeTheme(base, overrides) {
  const t = base ? structuredClone(base) : { colors: {}, font: {} };
  if (!overrides) return t;
  if (overrides.background) t.background = overrides.background;
  if (overrides.accent) {
    t.colors = { ...(t.colors || {}) };
    t.colors.accent = overrides.accent;
    t.colors.leader = overrides.accent;
  }
  if (overrides.font) {
    t.font = { ...(t.font || {}) };
    t.font.family = `'${overrides.font}', ${t.font.family || "sans-serif"}`;
  }
  return t;
}

// Load a service's effective theme (base preset + its color overrides).
export async function loadServiceTheme(service) {
  return mergeTheme(await loadTheme(service?.theme_id || "dark-blue"), service?.theme_overrides);
}

export const BUILTIN_THEMES = [
  { id: "dark-blue", name: "다크 블루" },
  { id: "light-warm", name: "라이트 웜" },
  { id: "black", name: "블랙" },
];
