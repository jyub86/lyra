// Tiny browser client for the HTTP tool API. Every UI action is a tool call —
// the UI is just one consumer of the registry (design §0).
export async function callTool(name, args = {}) {
  const res = await fetch(`/api/tools/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${name} failed (${res.status})`);
  return body;
}

export async function uploadFile(file) {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/upload", { method: "POST", body: fd });
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

export const BUILTIN_THEMES = [
  { id: "dark-blue", name: "다크 블루" },
  { id: "light-warm", name: "라이트 웜" },
];
