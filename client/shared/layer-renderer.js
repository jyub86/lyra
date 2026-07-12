// Layer compositor (v4). A slide = background + elements. Every element
// (text/shape/image + content elements bible/hymn/reading) is rendered here, so
// editor preview, tiles, and presenter render identically. Content elements draw
// their fetched `content` snapshot at the element's font size/color/align.

export function applyTheme(root, theme) {
  const c = (theme && theme.colors) || {};
  const f = (theme && theme.font) || {};
  const set = (k, v) => v != null && root.style.setProperty(k, v);
  set("--text", c.text || "#ffffff");
  set("--accent", c.accent || "#7aa2f7");
  set("--muted", c.muted || "#c0caf5");
  set("--leader", c.leader || c.accent || "#7aa2f7");
  set("--congregation", c.congregation || "#e0af68");
  set("--font-family", f.family || "sans-serif");
}

export function renderBackground(bgEl, bg) {
  bgEl.replaceChildren();
  bgEl.style.cssText = "";
  if (!bg || bg.type === "color") {
    bgEl.style.background = (bg && bg.value) || "#000";
  } else if (bg.type === "gradient") {
    bgEl.style.background = `linear-gradient(${bg.angle ?? 135}deg, ${bg.from}, ${bg.to})`;
  } else if (bg.type === "image") {
    bgEl.style.backgroundImage = `url("${bg.url}")`;
    bgEl.style.backgroundSize = bg.fit || "cover";
    bgEl.style.backgroundPosition = "center";
  } else if (bg.type === "video") {
    const v = document.createElement("video");
    v.src = bg.url; v.autoplay = true; v.muted = bg.muted !== false; v.loop = bg.loop !== false; v.playsInline = true;
    v.className = "bg-video";
    if (bg.playback_rate) v.playbackRate = bg.playback_rate;
    bgEl.appendChild(v); v.play?.().catch(() => {});
  }
  const dim = bg && bg.overlay_dim;
  if (dim && dim > 0) { const d = document.createElement("div"); d.className = "bg-dim"; d.style.background = `rgba(0,0,0,${dim})`; bgEl.appendChild(d); }
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// substitute {token} placeholders from values (missing → "")
function fmtStr(str, vals) {
  return String(str).replace(/\{(\w+)\}/g, (_, k) => (vals[k] != null ? String(vals[k]) : ""));
}

// ----- content element bodies (bible / hymn / reading) -----
// field: "all" (default) | "ref" | "text". `format` customizes the ref line.
function renderBibleBody(root, c, showNumbers, field, format) {
  field = field || "all";
  if (field === "ref") { root.textContent = fmtStr(format || "{ref}", { ref: c?.ref }); return; }
  if (field !== "text" && c?.ref) root.appendChild(el("div", "ce-ref", c.ref));
  const body = el("div", "ce-body");
  for (const v of c?.verses || []) {
    const row = el("span", "ce-verse");
    if (showNumbers !== false) row.appendChild(el("sup", "ce-verse-no", String(v.verse)));
    row.appendChild(el("span", null, (showNumbers !== false ? " " : "") + v.text));
    body.appendChild(row);
    body.appendChild(document.createTextNode(" "));
  }
  root.appendChild(body);
}
// field: "all" | "title" | "label" | "lyrics". `format` customizes title/label text.
function renderHymnBody(root, c, field, format) {
  field = field || "all";
  if (field === "title") { root.textContent = fmtStr(format || "{number}장 {title}", { number: c?.number, title: c?.title }); return; }
  if (field === "label") { root.textContent = fmtStr(format || "{label}", { label: c?.label }); return; }
  if (field === "lyrics") { for (const line of c?.lines || []) root.appendChild(el("div", "ce-line", line)); return; }
  const head = el("div", "ce-head");
  if (c?.number) head.appendChild(el("span", "ce-no", `${c.number}장`));
  if (c?.title) head.appendChild(el("span", null, " " + c.title));
  root.appendChild(head);
  if (c?.label) root.appendChild(el("div", "ce-label", c.label));
  for (const line of c?.lines || []) root.appendChild(el("div", "ce-line", line));
}
// field: "all" | "title" | "body" | "leader" | "congregation" | "unison".
// role fields render only that role (separate styleable element); all/body stay
// interleaved (call-response) with per-role tag colors + optional tags.
const ROLE_TAG = { leader: "인도자", congregation: "회중", unison: "다같이" };
function renderReadingBody(root, c, field, format, opts = {}) {
  field = field || "all";
  const titleText = c?.title ? fmtStr(format || "{number}번 {title}", { number: c?.number, title: c?.title }) : "";
  if (field === "title") { root.textContent = titleText; return; }
  const onlyRole = ROLE_TAG[field] ? field : null; // "leader"|"congregation"|"unison"
  if (!onlyRole && field !== "body" && titleText) root.appendChild(el("div", "ce-ref", titleText));
  const roleColor = { leader: opts.leader_color, congregation: opts.congregation_color, unison: opts.unison_color };
  for (const seg of c?.segments || []) {
    if (onlyRole && seg.role !== onlyRole) continue;
    const row = el("div", `ce-seg role-${seg.role}`);
    if (!onlyRole && opts.show_tags !== false && ROLE_TAG[seg.role]) {
      const t = el("span", "ce-tag", ROLE_TAG[seg.role]);
      if (roleColor[seg.role]) t.style.background = roleColor[seg.role];
      row.appendChild(t);
    }
    row.appendChild(el("span", null, seg.text));
    root.appendChild(row);
  }
}

// vertical align → flex justify-content (column). default: 가운데(center).
function vAlign(v) {
  return v === "top" ? "flex-start" : v === "bottom" ? "flex-end" : "center";
}

// 텍스트 효과: 그림자 · 외곽선(테두리). em 기준이라 글자 크기에 비례.
function applyTextEffects(n, e) {
  if (e.shadow) {
    const blur = e.shadow_blur ?? 0.12;
    n.style.textShadow = `0.05em 0.06em ${blur}em ${e.shadow_color || "#000000"}`;
  }
  if (e.outline_width) {
    n.style.webkitTextStroke = `${e.outline_width}px ${e.outline_color || "#000000"}`;
    n.style.paintOrder = "stroke fill";   // 외곽선이 글자를 덜 먹도록
  }
}

// 리치 텍스트(부분 색상 등) HTML 위생 처리 — span/font/b/i/u/br/div/p + 안전한 style만 허용.
const RT_TAGS = new Set(["SPAN", "FONT", "B", "STRONG", "I", "EM", "U", "BR", "DIV", "P"]);
const RT_STYLE = /^(color|font-weight|font-style|text-decoration|background-color)$/i;
function filterStyle(style) {
  return String(style).split(";").map((s) => s.trim()).filter(Boolean)
    .filter((s) => RT_STYLE.test(s.split(":")[0].trim())).join("; ");
}
function sanitizeHtml(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = String(html);
  const walk = (node) => {
    for (const c of [...node.childNodes]) {
      if (c.nodeType === 1) {
        if (!RT_TAGS.has(c.tagName)) { c.replaceWith(...c.childNodes); continue; } // 허용 안 된 태그는 벗겨냄
        for (const a of [...c.attributes]) {
          if (a.name === "color") continue;                                        // <font color>
          if (a.name === "style") { const f = filterStyle(a.value); if (f) c.setAttribute("style", f); else c.removeAttribute("style"); continue; }
          c.removeAttribute(a.name);                                               // 나머지 속성(onclick 등) 제거
        }
        walk(c);
      } else if (c.nodeType !== 3) { c.remove(); }                                 // 텍스트 노드 외 기타 제거
    }
  };
  walk(tpl.content);
  return tpl.innerHTML;
}

function placeElement(n, e) {
  n.style.left = (e.x ?? 0.4) * 100 + "%";
  n.style.top = (e.y ?? 0.4) * 100 + "%";
  n.style.width = (e.w ?? 0.3) * 100 + "%";
  n.style.height = (e.h ?? 0.15) * 100 + "%";
}

// Render the elements layer. opts.live=true(발표)면 영상 요소가 소리를 낸다(편집/썸네일은 음소거).
export function renderElements(root, elements, opts = {}) {
  root.replaceChildren();
  for (const e of elements || []) {
    let n;
    if (e.type === "image") {
      n = document.createElement("img");
      n.className = "el el-image"; n.src = e.url; if (e.fit) n.style.objectFit = e.fit;
    } else if (e.type === "video") {
      // 영상 요소(로컬 업로드 /uploads/… 또는 URL). 소리는 발표에서만.
      n = document.createElement("video");
      n.className = "el el-video";
      if (e.url) n.src = e.url;
      n.style.objectFit = e.fit || "contain";
      n.loop = e.loop !== false;
      n.autoplay = true; n.playsInline = true;
      n.muted = opts.live ? !!e.muted : true;   // 편집 미리보기·썸네일은 항상 음소거
      if (e.controls) n.controls = true;
      if (e.playback_rate) n.playbackRate = e.playback_rate;
      n.play?.().catch(() => {});
    } else if (e.type === "shape") {
      n = el("div", "el el-shape el-" + (e.shape || "rect"));
      n.style.background = e.shape === "line" ? "transparent" : (e.fill || "transparent");
      const sw = e.stroke_width ?? (e.shape === "line" ? 2 : 0);
      if (e.shape === "line") n.style.borderTop = `${sw / 10}cqw solid ${e.stroke || "#fff"}`;
      else if (sw) n.style.border = `${sw / 10}cqw solid ${e.stroke || "#fff"}`;
      if (e.shape === "ellipse") n.style.borderRadius = "50%";
      else if (e.radius) n.style.borderRadius = (e.radius / 10) + "cqw";
    } else if (e.type === "bible" || e.type === "hymn" || e.type === "reading") {
      n = el("div", "el el-content el-" + e.type);
      n.style.fontSize = (e.size ?? 3.2) + "cqw";
      if (e.color) n.style.color = e.color;
      if (e.font) n.style.fontFamily = `'${e.font}', var(--font-family, sans-serif)`;
      n.style.textAlign = e.align || "center";
      n.style.justifyContent = vAlign(e.valign);
      n.style.fontWeight = e.weight || 600;
      if (e.line_height) n.style.lineHeight = e.line_height;
      if (e.type === "bible") renderBibleBody(n, e.content, e.show_numbers, e.field, e.format);
      else if (e.type === "hymn") renderHymnBody(n, e.content, e.field, e.format);
      else renderReadingBody(n, e.content, e.field, e.format, {
        leader_color: e.leader_color, congregation_color: e.congregation_color, unison_color: e.unison_color, show_tags: e.show_tags,
      });
      applyTextEffects(n, e);   // 성경/가사도 그림자·외곽선(영상 위 가독성)
    } else {
      n = el("div", "el el-text");
      if (e.html) n.innerHTML = sanitizeHtml(e.html);   // 부분 색상 등 리치 텍스트
      else n.textContent = e.text ?? "";
      n.style.fontSize = (e.size ?? 4) + "cqw";
      if (e.color) n.style.color = e.color;
      if (e.font) n.style.fontFamily = `'${e.font}', var(--font-family, sans-serif)`;
      n.style.textAlign = e.align || "center";
      n.style.justifyContent = vAlign(e.valign);
      if (e.line_height) n.style.lineHeight = e.line_height;
      n.style.fontWeight = e.weight || 600;
      applyTextEffects(n, e);
    }
    placeElement(n, e);
    if (e.opacity != null) n.style.opacity = e.opacity;   // 요소 투명도(0~1). 기본=불투명
    root.appendChild(n);
  }
}

export function renderSlideWithLayers(container, slide, theme, opts = {}) {
  container.classList.add("slide-layers");
  applyTheme(container, theme);

  let bgEl = container.querySelector(":scope > .layer-bg");
  let elemEl = container.querySelector(":scope > .layer-elements");
  if (!bgEl) {
    container.replaceChildren();
    bgEl = mk("layer-bg"); elemEl = mk("layer-elements");
    container.append(bgEl, elemEl);
  }
  const bg = slide.background ?? (theme && theme.background) ?? { type: "color", value: "#000" };
  renderBackground(bgEl, bg);
  renderElements(elemEl, slide.elements || [], opts);
}

function mk(cls) { const n = document.createElement("div"); n.className = cls; return n; }
