// 편집 UI 컨트롤러. 예배(순서) > 슬라이드 평면 구조. 모든 동작은 Tool 호출.
import { callTool, loadTheme, uploadFile, BUILTIN_THEMES } from "/shared/api.js";
import { renderSlideWithLayers, renderElements } from "/shared/layer-renderer.js";

const $ = (id) => document.getElementById(id);

const state = {
  services: [],
  serviceId: null,
  service: null,        // get_service (flat slides[])
  theme: null,
  selected: null,       // primary slide id (preview/inspector)
  selectedSet: new Set(), // multi-selection
  anchor: null,         // range-select anchor (shift+click)
  mode: "list",         // "list" | "tiles"
  editEl: null,         // selected free-element index within the primary slide
  templates: [],        // design templates (cached)
  editingTemplate: null, // { id, name, kind, draft } while editing a template's design
};

function setSingleSelection(id) {
  state.selected = id;
  state.anchor = id;
  state.selectedSet = new Set(id ? [id] : []);
  state.editEl = null;
  state.editingTemplate = null;
}

const slides = () => state.service?.slides || [];
function slideLabel(s) {
  for (const e of s.elements || []) {
    if (e.type === "text" && e.text) return e.text.split("\n")[0];
    if (e.type === "bible") return e.content?.ref || "성경 본문";
    if (e.type === "hymn") return e.content?.title || "찬송가";
    if (e.type === "reading") return e.content?.title || "교독문";
  }
  return (s.elements || [])[0] ? (s.elements[0].type) : "빈 화면";
}
const KIND_LABEL = { bible: "성경", hymn: "찬송", reading: "교독", text: "텍스트", shape: "도형", image: "이미지" };
function slideKind(s) {
  const els = s.elements || [];
  const content = els.find((e) => ["bible", "hymn", "reading"].includes(e.type));
  if (content) return KIND_LABEL[content.type];
  if (!els.length) return "빈";
  return KIND_LABEL[els[0].type] || els[0].type;
}

function elx(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// A mini live preview of a slide (shared by list rows and tiles).
// Video backgrounds are swapped for a placeholder to avoid many <video> elements.
function thumbSlide(s) {
  if (s.background?.type === "video") {
    return { ...s, background: { type: "gradient", from: "#1f2933", to: "#0b0e14", angle: 135 } };
  }
  return s;
}
function buildThumb(s) {
  const t = elx("div", "thumb");
  const stage = elx("div", "slide-layers");
  t.appendChild(stage);
  renderSlideWithLayers(stage, thumbSlide(s), state.theme);
  return t;
}

// Compute the new id order when the dragged item (and, if it's part of a
// multi-selection, the whole selected group) is dropped before `targetId`.
// The group keeps its relative order. Returns null if dropping into the group.
function groupOrderFor(targetId) {
  const ids = slides().map((s) => s.id);
  const group = (state.selectedSet.has(dragId) && state.selectedSet.size > 1)
    ? ids.filter((id) => state.selectedSet.has(id))
    : [dragId];
  if (group.includes(targetId)) return null;
  const set = new Set(group);
  const rest = ids.filter((id) => !set.has(id));
  const at = rest.indexOf(targetId);
  return [...rest.slice(0, at), ...group, ...rest.slice(at)];
}

// Shared HTML5 drag-to-reorder for any element carrying dataset.id (rows & tiles).
// Multi-selection aware: dragging a selected row moves the whole selection.
let dragId = null;
function wireDrag(el) {
  el.addEventListener("dragstart", (e) => { dragId = el.dataset.id; e.dataTransfer.effectAllowed = "move"; });
  el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("drag-over"); });
  el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
  el.addEventListener("drop", async (e) => {
    e.preventDefault();
    el.classList.remove("drag-over");
    if (!dragId) return;
    const newIds = groupOrderFor(el.dataset.id);
    dragId = null;
    if (!newIds) return;
    await callTool("reorder_slides", { service_id: state.serviceId, ordered_slide_ids: newIds });
    await refresh();
  });
}

// List-row click with multi-select (plain / ⌘·Ctrl toggle / Shift range).
function onRowClick(s, e) {
  state.editEl = null;
  state.editingTemplate = null;
  const ids = slides().map((x) => x.id);
  if (e.shiftKey && state.anchor && ids.includes(state.anchor)) {
    const a = ids.indexOf(state.anchor), b = ids.indexOf(s.id);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    state.selectedSet = new Set(ids.slice(lo, hi + 1));
    state.selected = s.id;
  } else if (e.metaKey || e.ctrlKey) {
    if (state.selectedSet.has(s.id)) state.selectedSet.delete(s.id);
    else state.selectedSet.add(s.id);
    state.selected = s.id;
    state.anchor = s.id;
  } else {
    setSingleSelection(s.id);
  }
  render();
}

// ---------- service / theme ----------
async function loadServices(selectId) {
  state.services = await callTool("list_services");
  const sel = $("service-select");
  sel.innerHTML = "";
  for (const s of state.services) {
    const o = document.createElement("option");
    o.value = s.id;
    o.textContent = `${s.date} ${s.worship_part} · ${s.title}`;
    sel.appendChild(o);
  }
  const target = selectId || state.services[0]?.id;
  if (target) { sel.value = target; await selectService(target); }
  else { state.service = null; render(); }
}

async function selectService(id) {
  state.serviceId = id;
  state.service = await callTool("get_service", { service_id: id });
  state.theme = await loadTheme(state.service.theme_id);
  $("theme-select").value = state.service.theme_id;
  setSingleSelection(slides()[0]?.id || null);
  render();
}

async function refresh() {
  state.service = await callTool("get_service", { service_id: state.serviceId });
  const exist = new Set(slides().map((s) => s.id));
  state.selectedSet = new Set([...state.selectedSet].filter((id) => exist.has(id)));
  if (!exist.has(state.selected)) state.selected = slides()[0]?.id || null;
  if (state.selected && state.selectedSet.size === 0) state.selectedSet.add(state.selected);
  render();
}

function initThemeSelect() {
  const sel = $("theme-select");
  for (const t of BUILTIN_THEMES) {
    const o = document.createElement("option");
    o.value = t.id; o.textContent = t.name; sel.appendChild(o);
  }
  sel.onchange = async () => {
    await callTool("set_service_theme", { service_id: state.serviceId, theme_id: sel.value });
    state.theme = await loadTheme(sel.value);
    render();
  };
}

// ---------- render ----------
function render() {
  $("edit-view").hidden = state.mode !== "list";
  $("tiles-view").hidden = state.mode !== "tiles";
  $("view-list").classList.toggle("active", state.mode === "list");
  $("view-tiles").classList.toggle("active", state.mode === "tiles");
  $("order-count").textContent = state.service ? `${slides().length}장` : "";
  const editing = !!state.editingTemplate;
  $("tpl-edit-bar").hidden = !editing;
  $("canvas-bar").hidden = editing;
  if (editing) $("tpl-edit-name").textContent = state.editingTemplate.name;
  if (state.mode === "tiles") renderTiles();
  else { renderList(); renderPreview(); renderInspector(); renderDesignPanel(); renderTemplatePanel(); }
}

// The slide the canvas/design editor is operating on: the template draft while
// editing a template, otherwise the selected service slide.
function selectedSlide() {
  if (state.editingTemplate) return state.editingTemplate.draft;
  return slides().find((s) => s.id === state.selected) || null;
}
// The actual selected service slide (ignores any template draft).
function serviceSlide() {
  return slides().find((s) => s.id === state.selected) || null;
}

function renderList() {
  const root = $("slide-list");
  root.innerHTML = "";
  if (!state.service) { root.innerHTML = '<p class="muted" style="padding:12px">예배 순서가 없습니다. “+ 새 예배”로 시작하세요.</p>'; return; }
  root.appendChild(elx("p", "list-hint muted", "드래그로 이동 · ⌘/Ctrl·Shift 클릭으로 여러 개 선택해 함께 이동"));
  slides().forEach((s, i) => {
    const sel = state.selectedSet.has(s.id);
    const row = elx("div", "slide-row" + (sel ? " sel" : "") + (s.id === state.selected ? " primary" : ""));
    row.draggable = true;
    row.dataset.id = s.id;
    const meta = elx("div", "row-meta");
    meta.append(elx("span", "badge", slideKind(s)), elx("span", "label", slideLabel(s)));
    const del = elx("button", "del danger", "✕");
    del.onclick = (e) => { e.stopPropagation(); removeSlide(s.id); };
    row.append(elx("span", "num", String(i + 1)), buildThumb(s), meta, del);
    row.onclick = (e) => onRowClick(s, e);
    wireDrag(row);
    root.appendChild(row);
  });
}

function renderPreview() {
  const slide = selectedSlide();
  const prev = $("preview");
  if (!slide) { prev.replaceChildren(); $("slide-pos").textContent = "—"; return; }
  renderSlideWithLayers(prev, slide, state.theme);
  renderEditLayer();
  const idx = slides().findIndex((s) => s.id === slide.id);
  const n = state.selectedSet.size;
  $("slide-pos").textContent = n > 1 ? `${n}개 선택됨 · 드래그로 함께 이동` : `${idx + 1} / ${slides().length}`;
}

function navSlide(delta) {
  const idx = slides().findIndex((s) => s.id === state.selected);
  const next = slides()[idx + delta];
  if (next) { state.selected = next.id; render(); }
}

// ===== free-element canvas editing (Google-Slides-like) =====
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const els = () => selectedSlide()?.elements || [];

// Interactive handle layer over #preview: select / move / resize elements.
function renderEditLayer() {
  const pv = $("preview");
  if (!pv) return;
  let layer = pv.querySelector(":scope > .edit-layer");
  if (state.mode !== "list" || !selectedSlide()) { layer?.remove(); return; }
  if (!layer) {
    layer = elx("div", "edit-layer");
    layer.addEventListener("mousedown", (e) => { if (e.target === layer) selectEl(null); });
    pv.appendChild(layer);
  }
  layer.replaceChildren();
  els().forEach((el, i) => {
    const h = elx("div", "eh" + (i === state.editEl ? " sel" : ""));
    h.style.left = (el.x ?? 0.4) * 100 + "%";
    h.style.top = (el.y ?? 0.4) * 100 + "%";
    h.style.width = (el.w ?? 0.2) * 100 + "%";
    h.style.height = (el.h ?? 0.12) * 100 + "%";
    h.addEventListener("mousedown", (e) => startMove(e, i));
    if (i === state.editEl) {
      for (const pos of ["nw", "ne", "sw", "se"]) {
        const k = elx("div", "handle " + pos);
        k.addEventListener("mousedown", (e) => startResize(e, i, pos));
        h.appendChild(k);
      }
    }
    layer.appendChild(h);
  });
}

// Lightweight repaint during drag (no background rebuild → no video reload).
function repaintEls() {
  const ov = $("preview")?.querySelector(":scope > .layer-elements");
  if (ov) renderElements(ov, els());
  renderEditLayer();
}

function selectEl(i) {
  state.editEl = i;
  if (i != null) showTab("design");
  renderEditLayer();
  renderDesignPanel();
}

function startMove(e, i) {
  if (e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  if (state.editEl !== i) selectEl(i);
  const rect = $("preview").getBoundingClientRect();
  const el = els()[i];
  const sx = e.clientX, sy = e.clientY, ox = el.x ?? 0.4, oy = el.y ?? 0.4;
  const mv = (ev) => {
    el.x = clamp01(ox + (ev.clientX - sx) / rect.width);
    el.y = clamp01(oy + (ev.clientY - sy) / rect.height);
    repaintEls();
  };
  const up = () => { document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); commitEls(); };
  document.addEventListener("mousemove", mv);
  document.addEventListener("mouseup", up);
}

function startResize(e, i, pos) {
  e.preventDefault(); e.stopPropagation();
  const rect = $("preview").getBoundingClientRect();
  const el = els()[i];
  const sx = e.clientX, sy = e.clientY;
  const o = { x: el.x ?? 0.4, y: el.y ?? 0.4, w: el.w ?? 0.2, h: el.h ?? 0.12 };
  const mv = (ev) => {
    const dx = (ev.clientX - sx) / rect.width, dy = (ev.clientY - sy) / rect.height;
    if (pos.includes("e")) el.w = Math.max(0.03, o.w + dx);
    if (pos.includes("s")) el.h = Math.max(0.03, o.h + dy);
    if (pos.includes("w")) { el.w = Math.max(0.03, o.w - dx); el.x = o.x + dx; }
    if (pos.includes("n")) { el.h = Math.max(0.03, o.h - dy); el.y = o.y + dy; }
    repaintEls();
  };
  const up = () => { document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); commitEls(); };
  document.addEventListener("mousemove", mv);
  document.addEventListener("mouseup", up);
}

async function commitEls() {
  if (state.editingTemplate) { repaintEls(); return; } // draft: local only
  const slide = selectedSlide();
  if (!slide) return;
  await callTool("set_slide_elements", { slide_id: slide.id, elements: slide.elements || [] });
  await refresh();
}

const ADD_DEFAULTS = {
  text: () => ({ type: "text", x: 0.34, y: 0.42, w: 0.32, h: 0.12, text: "텍스트", size: 4, color: "#ffffff", align: "center", weight: 600 }),
  rect: () => ({ type: "shape", shape: "rect", x: 0.4, y: 0.4, w: 0.2, h: 0.16, fill: "#7aa2f7", stroke: "#ffffff", stroke_width: 0, radius: 6 }),
  ellipse: () => ({ type: "shape", shape: "ellipse", x: 0.4, y: 0.4, w: 0.18, h: 0.18, fill: "#7aa2f7", stroke: "#ffffff", stroke_width: 0 }),
  line: () => ({ type: "shape", shape: "line", x: 0.3, y: 0.5, w: 0.4, h: 0.02, stroke: "#ffffff", stroke_width: 3 }),
  // content elements: added empty → user fills params in the design panel + 다시 가져오기
  bible: () => ({ type: "bible", x: 0.1, y: 0.25, w: 0.8, h: 0.5, size: 3.2, align: "center", weight: 600, line_height: 1.5, show_numbers: true, params: {}, content: null }),
  hymn: () => ({ type: "hymn", x: 0.1, y: 0.25, w: 0.8, h: 0.5, size: 3.2, align: "center", weight: 600, params: {}, content: null }),
  reading: () => ({ type: "reading", x: 0.08, y: 0.2, w: 0.84, h: 0.6, size: 2.9, align: "center", weight: 600, params: {}, content: null }),
};

async function addElement(kind, extra) {
  const slide = selectedSlide();
  if (!slide) { msg("add-msg", "슬라이드를 먼저 선택하세요.", true); return; }
  const el = kind === "image" ? { type: "image", x: 0.35, y: 0.32, w: 0.3, h: 0.3, ...extra } : ADD_DEFAULTS[kind]();
  slide.elements = [...(slide.elements || []), el];
  state.editEl = slide.elements.length - 1;
  await commitEls();
  selectEl(state.editEl);
}

function deleteEl(i) {
  const slide = selectedSlide();
  if (!slide || i == null) return;
  slide.elements = (slide.elements || []).filter((_, j) => j !== i);
  state.editEl = null;
  commitEls();
}

function moveElZ(i, toFront) {
  const slide = selectedSlide();
  const arr = slide?.elements;
  if (!arr || i == null) return;
  const [el] = arr.splice(i, 1);
  if (toFront) { arr.push(el); state.editEl = arr.length - 1; }
  else { arr.unshift(el); state.editEl = 0; }
  commitEls();
}

// ----- 디자인 패널 (선택한 요소 속성) -----
const CONTENT_PARAMS = {
  bible: [["책(이름/약칭)", "book", "text"], ["장", "chapter", "int"], ["시작 절", "verse_start", "int"], ["끝 절", "verse_end", "int"]],
  hymn: [["찬송가 번호", "number", "int"], ["절(선택)", "verse_no", "int"]],
  reading: [["교독문 번호", "number", "int"]],
};
// 표시 항목 — 콘텐츠 요소가 어느 부분을 보여줄지 (분리 배치용)
const FIELD_OPTIONS = {
  bible: [["all", "전체"], ["ref", "구절(요 3:16)"], ["text", "본문만"]],
  hymn: [["all", "전체"], ["title", "제목/장"], ["label", "절"], ["lyrics", "가사만"]],
  reading: [["all", "전체"], ["title", "제목"], ["body", "본문만"]],
};

function renderDesignPanel() {
  const empty = $("el-empty"), body = $("el-props");
  const el = state.editEl != null ? els()[state.editEl] : null;
  if (!el) { empty.hidden = false; body.hidden = true; return; }
  empty.hidden = true; body.hidden = false;
  body.replaceChildren();

  // field that edits el[field]; live on input, persist on change
  const field = (label, type, fieldName, opts = {}) => {
    const wrap = elx("label", null, label);
    let input;
    if (type === "textarea") { input = document.createElement("textarea"); input.rows = 2; input.value = el[fieldName] ?? ""; }
    else if (type === "check") { input = document.createElement("input"); input.type = "checkbox"; input.checked = el[fieldName] !== false; }
    else if (type === "select") {
      input = document.createElement("select");
      for (const [v, t] of opts.options) { const o = document.createElement("option"); o.value = v; o.textContent = t; input.appendChild(o); }
      input.value = el[fieldName] ?? opts.options[0][0];
    } else {
      input = document.createElement("input"); input.type = type;
      if (type === "range") { input.min = opts.min; input.max = opts.max; input.step = opts.step; }
      input.value = el[fieldName] ?? opts.def ?? "";
    }
    const apply = (commit) => {
      el[fieldName] = type === "check" ? input.checked : (type === "range" || opts.num ? Number(input.value) : input.value);
      repaintEls();
      if (commit) commitEls();
    };
    input.addEventListener("input", () => apply(false));
    input.addEventListener("change", () => apply(true));
    wrap.appendChild(input);
    body.appendChild(wrap);
  };

  if (el.type === "text") {
    field("내용", "textarea", "text");
    field("글자 크기", "range", "size", { min: 1.5, max: 12, step: 0.25, num: true });
    field("색", "color", "color", { def: "#ffffff" });
    field("굵기", "select", "weight", { options: [["400", "보통"], ["600", "중간"], ["700", "굵게"], ["800", "더 굵게"]] });
    field("정렬", "select", "align", { options: [["center", "가운데"], ["left", "왼쪽"], ["right", "오른쪽"]] });
  } else if (el.type === "shape") {
    if (el.shape !== "line") {
      field("채움색", "color", "fill", { def: "#7aa2f7" });
      field("테두리색", "color", "stroke", { def: "#ffffff" });
      field("테두리 두께", "range", "stroke_width", { min: 0, max: 12, step: 1, num: true });
      if (el.shape === "rect") field("모서리", "range", "radius", { min: 0, max: 40, step: 1, num: true });
    } else {
      field("선 색", "color", "stroke", { def: "#ffffff" });
      field("선 두께", "range", "stroke_width", { min: 1, max: 14, step: 1, num: true });
    }
  } else if (el.type === "image") {
    body.appendChild(elx("p", "muted", "이미지는 캔버스에서 드래그·크기조절하세요."));
  } else if (["bible", "hymn", "reading"].includes(el.type)) {
    { // 표시 항목(field): 바꾸면 즉시 반영 + 패널 갱신(절 번호 표시 노출 여부)
      const wrap = elx("label", null, "표시 항목");
      const sel = document.createElement("select");
      for (const [v, t] of FIELD_OPTIONS[el.type]) { const o = document.createElement("option"); o.value = v; o.textContent = t; sel.appendChild(o); }
      sel.value = el.field ?? "all";
      sel.onchange = () => { el.field = sel.value; repaintEls(); commitEls(); renderDesignPanel(); };
      wrap.appendChild(sel); body.appendChild(wrap);
    }
    field("글자 크기", "range", "size", { min: 1.5, max: 10, step: 0.25, num: true, def: 3.2 });
    field("색", "color", "color", { def: "#ffffff" });
    field("정렬", "select", "align", { options: [["center", "가운데"], ["left", "왼쪽"], ["right", "오른쪽"]] });
    field("굵기", "select", "weight", { options: [["400", "보통"], ["600", "중간"], ["700", "굵게"], ["800", "더 굵게"]] });
    if (el.type === "bible" && (el.field ?? "all") !== "ref") field("절 번호 표시", "check", "show_numbers");
    body.appendChild(elx("div", "section-title", "내용 (params)"));
    for (const [label, name, ptype] of CONTENT_PARAMS[el.type]) {
      const wrap = elx("label", null, label);
      const input = document.createElement("input");
      input.type = ptype === "int" ? "number" : "text";
      input.value = el.params?.[name] ?? "";
      input.onchange = () => { el.params = { ...(el.params || {}), [name]: ptype === "int" ? Number(input.value) : input.value }; };
      wrap.appendChild(input); body.appendChild(wrap);
    }
    const refetch = elx("button", "mini accent", "다시 가져오기"); refetch.onclick = () => fetchContentElement(state.editEl);
    body.appendChild(refetch);
  }

  const actions = elx("div", "el-actions");
  const front = elx("button", "mini", "맨 앞으로"); front.onclick = () => moveElZ(state.editEl, true);
  const back = elx("button", "mini", "맨 뒤로"); back.onclick = () => moveElZ(state.editEl, false);
  const del = elx("button", "mini danger", "삭제"); del.onclick = () => deleteEl(state.editEl);
  actions.append(front, back, del);
  body.appendChild(actions);
}

// re-fetch a content element's snapshot from its params via read tools
async function fetchContentElement(i) {
  const el = els()[i];
  if (!el) return;
  const p = el.params || {};
  try {
    if (el.type === "bible") {
      const r = await callTool("get_bible_passage", { book: p.book, chapter: p.chapter, verse_start: p.verse_start, verse_end: p.verse_end });
      const ref = `${r.short_name || r.book_name} ${p.chapter}:${p.verse_start}${p.verse_end > p.verse_start ? "-" + p.verse_end : ""}`;
      el.content = { ref, verses: r.verses };
    } else if (el.type === "hymn") {
      const h = await callTool("get_hymn", { number: p.number });
      const v = (h.verses || []).find((x) => x.verse_no === (p.verse_no || 1)) || h.verses?.[0];
      el.content = { number: h.number, title: h.title, label: v?.label, lines: v?.lines || [] };
    } else if (el.type === "reading") {
      const rd = await callTool("get_reading", { number: p.number });
      el.content = { number: rd.number, title: rd.title, segments: rd.segments };
    }
    repaintEls();
    commitEls();
  } catch (e) { alert("가져오기 실패: " + e.message); }
}

// ===== 디자인 템플릿 =====
function slideDesign(slide) {
  return { background: slide.background, elements: slide.elements };
}

async function loadTemplates() {
  state.templates = await callTool("list_templates").catch(() => []);
  renderTemplatePanel();
  renderAddTypeSelect();
}

// management list: save current slide's design into a template, rename, reset/delete
function renderTemplatePanel() {
  const list = $("tpl-list");
  if (!list) return;
  list.replaceChildren();
  if (!state.templates?.length) { list.appendChild(elx("p", "muted", "템플릿이 없습니다.")); return; }
  let lastKind = null;
  for (const t of state.templates) {
    if (t.kind !== lastKind) { list.appendChild(elx("div", "tpl-group", t.kind === "builtin" ? "기본 종류" : "내 템플릿")); lastKind = t.kind; }
    const row = elx("div", "tpl-row");
    const name = elx("span", "tpl-name", t.name);
    name.title = "클릭하면 디자인 편집";
    name.onclick = () => editTemplate(t.id);
    const acts = elx("div", "tpl-acts");
    const edit = elx("button", "mini accent", "✎ 편집"); edit.title = "디자인 불러와서 편집"; edit.onclick = () => editTemplate(t.id);
    const stamp = elx("button", "mini", "이 디자인"); stamp.title = "현재 선택 슬라이드의 디자인을 이 템플릿에 저장"; stamp.onclick = () => updateTemplate(t.id);
    const ren = elx("button", "mini", "이름"); ren.onclick = () => renameTemplate(t.id, t.name);
    const last = elx("button", "mini" + (t.kind === "builtin" ? "" : " danger"), t.kind === "builtin" ? "초기화" : "삭제");
    last.onclick = () => (t.kind === "builtin" ? resetTemplate(t.id) : deleteTemplate(t.id));
    acts.append(edit, stamp, ren, last);
    row.append(name, acts);
    list.appendChild(row);
  }
}

async function saveCurrentAsTemplate() {
  const slide = serviceSlide();
  if (!slide) { msg("tpl-msg", "슬라이드를 먼저 선택하세요.", true); return; }
  const name = prompt("새 디자인 템플릿 이름", slideLabel(slide) || "새 템플릿");
  if (!name) return;
  await callTool("save_template", { name, slide: slideDesign(slide) });
  msg("tpl-msg", `“${name}” 저장됨`);
  await loadTemplates();
}
async function updateTemplate(id) {
  const slide = serviceSlide();
  if (!slide) { msg("tpl-msg", "디자인 소스 슬라이드를 선택하세요.", true); return; }
  const t = state.templates.find((x) => x.id === id);
  const what = t?.kind === "builtin" ? "이 종류의 디자인(배경·요소 배치/스타일)" : "이 템플릿";
  if (!confirm(`현재 슬라이드 디자인으로 ${what}을 저장할까요?`)) return;
  await callTool("update_template", { template_id: id, slide: slideDesign(slide) });
  msg("tpl-msg", "디자인 저장됨");
  await loadTemplates();
}
async function renameTemplate(id, cur) {
  const name = prompt("새 이름", cur);
  if (!name) return;
  await callTool("update_template", { template_id: id, name });
  await loadTemplates();
}
async function resetTemplate(id) {
  if (!confirm("이 종류의 디자인을 초기화할까요?")) return;
  await callTool("update_template", { template_id: id, reset: true });
  msg("tpl-msg", "초기화됨");
  await loadTemplates();
}
async function deleteTemplate(id) {
  if (!confirm("이 템플릿을 삭제할까요?")) return;
  await callTool("delete_template", { template_id: id });
  await loadTemplates();
}

// ----- 템플릿 디자인 불러와서 편집 -----
// sample content so built-in content elements / bound text show how the design looks
const SAMPLE_CONTENT = {
  bible: { ref: "요 3:16", verses: [{ verse: 16, text: "하나님이 세상을 이처럼 사랑하사 독생자를 주셨으니" }] },
  hymn: { number: 1, title: "찬송 제목", label: "1절", lines: ["가사 첫째 줄", "가사 둘째 줄"] },
  reading: { number: 1, title: "교독문", segments: [{ role: "leader", text: "인도자 본문" }, { role: "congregation", text: "회중 본문" }] },
};
const SAMPLE_BIND = { title: "제목", subtitle: "부제", label: "순서 구분", lyrics: "가사 첫째 줄\n가사 둘째 줄", items: "광고 항목 1\n광고 항목 2" };

// build an editable draft slide from a template. custom = its design as-is;
// built-in = element layout with sample content/text filled (bind kept).
function draftFromTemplate(tpl) {
  const spec = tpl.spec || {};
  const elements = (spec.elements || []).map((e) => {
    const c = structuredClone(e);
    if (tpl.kind === "builtin") {
      if (SAMPLE_CONTENT[e.type]) c.content = structuredClone(SAMPLE_CONTENT[e.type]);
      else if (e.type === "text" && e.bind) c.text = SAMPLE_BIND[e.bind] ?? e.text ?? "";
    }
    return c;
  });
  return { background: spec.background ?? null, elements };
}

async function editTemplate(id) {
  const tpl = await callTool("get_template", { template_id: id });
  state.editingTemplate = { id, name: tpl.name, kind: tpl.kind, draft: draftFromTemplate(tpl) };
  state.editEl = null;
  state.mode = "list";
  showTab("design");
  render();
}
async function saveTemplateEdit() {
  const et = state.editingTemplate;
  if (!et) return;
  await callTool("update_template", { template_id: et.id, slide: et.draft });
  state.editingTemplate = null;
  await loadTemplates();
  render();
  msg("tpl-msg", "템플릿에 저장됨");
}
function cancelTemplateEdit() {
  state.editingTemplate = null;
  render();
}


// ---------- tiles ----------
function renderTiles() {
  const grid = $("tile-grid");
  grid.innerHTML = "";
  slides().forEach((s, i) => {
    const sel = state.selectedSet.has(s.id);
    const tile = elx("div", "tile" + (sel ? " sel" : "") + (s.id === state.selected ? " primary" : ""));
    tile.draggable = true;
    tile.dataset.id = s.id;
    const cap = elx("div", "cap");
    cap.innerHTML = `<span class="num">${i + 1}</span><span class="badge">${slideKind(s)}</span><span class="label">${slideLabel(s)}</span><button class="del danger">✕</button>`;
    cap.querySelector(".del").onclick = (e) => { e.stopPropagation(); removeSlide(s.id); };
    tile.append(buildThumb(s), cap);
    tile.onclick = (e) => onRowClick(s, e);   // same multi-select model as the list
    tile.ondblclick = () => presentIndex(i);
    wireDrag(tile);
    grid.appendChild(tile);
  });
}

// ---------- add slide (unified: pick any template + schema-driven params) ----------
const PARAM_LABELS = {
  title: "제목", subtitle: "부제", label: "구분 제목",
  book: "책 (이름/약칭)", chapter: "장", verse_start: "시작 절", verse_end: "끝 절", layout: "분할",
  number: "번호", verse_nos: "절 (예: 1,3)", lines_per_slide: "줄/슬라이드",
  segments_per_slide: "세그먼트/슬라이드", sections: "가사 (한 줄씩)", items: "광고 항목 (한 줄씩)",
};

// populate the type/template dropdown (기본 종류 + 내 템플릿) from state.templates
function renderAddTypeSelect() {
  const sel = $("add-type");
  const cur = sel.value;
  sel.innerHTML = "";
  const gB = document.createElement("optgroup"); gB.label = "기본 종류";
  const gC = document.createElement("optgroup"); gC.label = "내 템플릿";
  for (const t of state.templates) {
    const o = document.createElement("option"); o.value = t.id; o.textContent = t.name;
    (t.kind === "builtin" ? gB : gC).appendChild(o);
  }
  sel.appendChild(gB);
  if (gC.children.length) sel.appendChild(gC);
  if (cur && state.templates.some((t) => t.id === cur)) sel.value = cur;
  renderAddFields();
}

// build the input form from the selected template's params_schema
function renderAddFields() {
  const tpl = state.templates.find((t) => t.id === $("add-type").value);
  const wrap = $("add-fields");
  wrap.innerHTML = "";
  const props = tpl?.params_schema?.properties || {};
  for (const [key, def] of Object.entries(props)) {
    wrap.appendChild(elx("label", null, PARAM_LABELS[key] || key));
    let input;
    if (def.enum) {
      input = document.createElement("select");
      for (const v of def.enum) { const o = document.createElement("option"); o.value = o.textContent = v; input.appendChild(o); }
      if (def.default != null) input.value = def.default;
    } else if (key === "lyrics" || key === "sections" || key === "items" || def.type === "array") {
      input = document.createElement("textarea");
      input.rows = (key === "lyrics" || key === "sections") ? 5 : 3;
      input.placeholder = (key === "lyrics" || key === "sections") ? "가사 한 줄씩" : key === "items" ? "항목 한 줄씩" : "쉼표로 구분";
    } else {
      input = document.createElement("input");
      input.type = (def.type === "integer" || def.type === "number") ? "number" : "text";
      if (def.default != null) input.value = def.default;
    }
    input.dataset.key = key;
    input.dataset.dtype = def.type || "string";
    wrap.appendChild(input);
  }
}

function collectParams(tpl) {
  const params = {};
  for (const [key, def] of Object.entries(tpl?.params_schema?.properties || {})) {
    const input = $("add-fields").querySelector(`[data-key="${key}"]`);
    if (!input) continue;
    const v = input.value.trim();
    if (key === "sections") {
      const lines = v.split("\n").map((s) => s.trim()).filter(Boolean);
      if (lines.length) params.sections = [{ label: "", lines }];
    } else if (key === "items") {
      params.items = v.split("\n").map((s) => s.trim()).filter(Boolean);
    } else if (def.type === "array") {
      if (v) params[key] = v.split(",").map((x) => Number(x.trim())).filter((x) => !Number.isNaN(x));
    } else if (v === "") {
      // skip empty optional field
    } else if (def.type === "integer" || def.type === "number") {
      params[key] = Number(v);
    } else {
      params[key] = v;
    }
  }
  return params;
}

async function addSlide() {
  const templateId = $("add-type").value;
  if (!state.serviceId) return msg("add-msg", "예배 순서가 없습니다.", true);
  const tpl = state.templates.find((t) => t.id === templateId);
  if (!tpl) return msg("add-msg", "추가할 종류/템플릿을 선택하세요.", true);
  try {
    await callTool("apply_template", { template_id: templateId, service_id: state.serviceId, params: collectParams(tpl) });
    msg("add-msg", `“${tpl.name}” 추가됨`);
    await refresh();
  } catch (e) { msg("add-msg", e.message, true); }
}

// ---------- inspector ----------
function renderInspector() {
  const slide = selectedSlide();
  const empty = $("inspect-empty"), body = $("inspect-body");
  if (!slide) { empty.hidden = false; body.hidden = true; return; }
  empty.hidden = true; body.hidden = false;
  $("insp-bg-type").value = slide.background?.type || "theme";
  renderBgFields(slide.background);
}

const BG_FIELDS = {
  theme: [],
  color: [["value", "색 (#hex)", "color:#1a1a2e"]],
  gradient: [["from", "시작색", "color:#1a1a2e"], ["to", "끝색", "color:#16213e"], ["angle", "각도", "number:135"]],
  image: [["url", "이미지 URL", "text"], ["overlay_dim", "어둡게(0~1)", "number:0.35"]],
  video: [["url", "영상 URL", "text"], ["loop", "반복", "check:1"], ["muted", "음소거", "check:1"], ["overlay_dim", "어둡게(0~1)", "number:0.4"]],
};

function renderBgFields(bg) {
  const type = $("insp-bg-type").value;
  const wrap = $("insp-bg-fields");
  wrap.innerHTML = "";
  for (const [key, label, kind] of BG_FIELDS[type] || []) {
    const l = document.createElement("label"); l.textContent = label; wrap.appendChild(l);
    let input;
    if (kind.startsWith("check")) { input = document.createElement("input"); input.type = "checkbox"; input.checked = bg ? bg[key] !== false : kind.endsWith("1"); }
    else if (kind.startsWith("color")) { input = document.createElement("input"); input.type = "color"; input.value = bg?.[key] || kind.split(":")[1]; }
    else { input = document.createElement("input"); input.type = kind.startsWith("number") ? "number" : "text"; input.value = bg?.[key] ?? (kind.includes(":") ? kind.split(":")[1] : ""); }
    input.id = "bg-" + key;
    wrap.appendChild(input);
  }
  if (type === "image" || type === "video") {
    const file = document.createElement("input");
    file.type = "file"; file.accept = type === "video" ? "video/*" : "image/*";
    file.onchange = async () => {
      if (!file.files[0]) return;
      msg("insp-msg", "업로드 중…");
      try { const { url } = await uploadFile(file.files[0]); $("bg-url").value = url; msg("insp-msg", "업로드 완료"); }
      catch (e) { msg("insp-msg", e.message, true); }
    };
    wrap.appendChild(file);
  }
}

function buildBackground() {
  const type = $("insp-bg-type").value;
  const g = (k) => $("bg-" + k);
  if (type === "theme") return null;
  if (type === "color") return { type, value: g("value").value };
  if (type === "gradient") return { type, from: g("from").value, to: g("to").value, angle: +g("angle").value };
  if (type === "image") return { type, url: g("url").value, fit: "cover", overlay_dim: +g("overlay_dim").value };
  if (type === "video") return { type, url: g("url").value, loop: g("loop").checked, muted: g("muted").checked, overlay_dim: +g("overlay_dim").value };
  return null;
}

async function saveInspector() {
  const slide = selectedSlide();
  if (!slide) return;
  try {
    const bg = buildBackground();
    if (state.editingTemplate) {
      slide.background = bg;
      renderPreview();
    } else {
      await callTool("set_slide_background", { slide_id: slide.id, background: bg });
      await refresh();
    }
    msg("insp-msg", "배경 저장됨");
  } catch (e) { msg("insp-msg", e.message, true); }
}

// ---------- mutations ----------
async function removeSlide(id) {
  await callTool("remove_slide", { slide_id: id });
  state.selectedSet.delete(id);
  if (state.selected === id) state.selected = null;
  await refresh();
}
async function deleteSelected() {
  const ids = [...state.selectedSet];
  if (!ids.length) return;
  if (ids.length > 1 && !confirm(`${ids.length}개 슬라이드를 삭제할까요?`)) return;
  for (const id of ids) await callTool("remove_slide", { slide_id: id });
  state.selectedSet.clear(); state.selected = null; state.anchor = null;
  await refresh();
}
async function newService() {
  const title = prompt("예배 제목", "주일 예배"); if (!title) return;
  const date = prompt("날짜 (YYYY-MM-DD)", new Date().toISOString().slice(0, 10)); if (!date) return;
  const worship_part = prompt("예배부 (1부/2부/연합)", "1부") || "1부";
  const { service_id } = await callTool("create_service", { title, date, worship_part });
  await loadServices(service_id);
}
async function presentIndex(i) {
  try { await callTool("present_goto", { service_id: state.serviceId, page_index: i }); msg("add-msg", "발표 화면으로 전송"); }
  catch (e) { msg("add-msg", e.message, true); }
}
function presentHere() {
  const i = slides().findIndex((s) => s.id === state.selected);
  if (i >= 0) presentIndex(i);
}

// ---------- export / import ----------
async function exportService() {
  const payload = await callTool("export_service", { service_id: state.serviceId });
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${payload.date || "service"}_${payload.worship_part || ""}_${payload.title || "예배"}.json`.replace(/\s+/g, "-");
  a.click();
  URL.revokeObjectURL(a.href);
}
async function importService(file) {
  try {
    const payload = JSON.parse(await file.text());
    const { service_id } = await callTool("import_service", { payload });
    await loadServices(service_id);
    msg("add-msg", "가져오기 완료");
  } catch (e) { alert("가져오기 실패: " + e.message); }
}

function msg(id, text, err) { const el = $(id); if (!el) return; el.textContent = text; el.className = "msg" + (err ? " err" : ""); }

// ---------- wire ----------
function showTab(name) {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === name));
  document.querySelectorAll(".tab-body").forEach((b) => { b.hidden = b.id !== "tab-" + name; });
}
function initTabs() {
  document.querySelectorAll(".tab").forEach((t) => { t.onclick = () => showTab(t.dataset.tab); });
}

function init() {
  initThemeSelect();
  initTabs();
  renderAddFields();
  $("service-select").onchange = (e) => selectService(e.target.value);
  $("new-service").onclick = newService;
  $("view-list").onclick = () => { state.mode = "list"; render(); };
  $("view-tiles").onclick = () => { state.mode = "tiles"; render(); };
  $("add-type").onchange = renderAddFields;
  $("add-slide-btn").onclick = addSlide;
  $("prev-slide").onclick = () => navSlide(-1);
  $("next-slide").onclick = () => navSlide(1);
  $("del-slide").onclick = deleteSelected;
  $("present-here").onclick = presentHere;
  $("insp-bg-type").onchange = () => renderBgFields(selectedSlide()?.background);
  $("insp-save").onclick = saveInspector;

  // element toolbar + design panel
  document.querySelectorAll(".canvas-tools [data-add]").forEach((b) => {
    b.onclick = () => (b.dataset.add === "image" ? $("el-image-file").click() : addElement(b.dataset.add));
  });
  $("el-image-file").onchange = async (e) => {
    if (!e.target.files[0]) return;
    try { const { url } = await uploadFile(e.target.files[0]); await addElement("image", { url }); }
    catch (err) { msg("add-msg", err.message, true); }
    e.target.value = "";
  };
  // keyboard: Delete removes selected element, arrows nudge
  document.addEventListener("keydown", (e) => {
    if (state.mode !== "list" || state.editEl == null) return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    const el = els()[state.editEl];
    if (!el) return;
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteEl(state.editEl); }
    else if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      const d = 0.005;
      if (e.key === "ArrowLeft") el.x = clamp01((el.x ?? 0.4) - d);
      if (e.key === "ArrowRight") el.x = clamp01((el.x ?? 0.4) + d);
      if (e.key === "ArrowUp") el.y = clamp01((el.y ?? 0.4) - d);
      if (e.key === "ArrowDown") el.y = clamp01((el.y ?? 0.4) + d);
      repaintEls();
      clearTimeout(window.__nudgeT);
      window.__nudgeT = setTimeout(commitEls, 300);
    }
  });

  $("export-btn").onclick = exportService;
  $("import-btn").onclick = () => $("import-file").click();
  $("import-file").onchange = (e) => e.target.files[0] && importService(e.target.files[0]);
  $("tpl-save").onclick = saveCurrentAsTemplate;
  $("tpl-edit-save").onclick = saveTemplateEdit;
  $("tpl-edit-cancel").onclick = cancelTemplateEdit;
  loadServices();
  loadTemplates();
}

init();
