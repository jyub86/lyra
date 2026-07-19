// 편집 UI 컨트롤러. 예배(순서) > 슬라이드 평면 구조. 모든 동작은 Tool 호출.
import { callTool, loadServiceTheme, uploadFile, BUILTIN_THEMES } from "/shared/api.js";
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
  editEl: null,         // primary selected element index (design panel/resize)
  editElSet: new Set(), // selected element indices (drag-marquee multi-select)
  inlineEdit: null,     // 캔버스에서 인라인 편집 중인 텍스트 요소 index (null=아님)
  templates: [],        // design templates (cached)
  editingTemplate: null, // { id, name, kind, draft } while editing a template's design
  fonts: [],            // self-host 웹폰트 목록 (list_fonts)
};

// 글꼴 <select>를 "테마 기본" + 용도 그룹(optgroup)으로 채운다. current=현재 family.
function fillFontSelect(sel, current) {
  sel.replaceChildren();
  const base = document.createElement("option"); base.value = ""; base.textContent = "테마 기본"; sel.appendChild(base);
  const groups = {};
  for (const f of state.fonts) (groups[f.group] ??= []).push(f);
  for (const [g, list] of Object.entries(groups)) {
    const og = document.createElement("optgroup"); og.label = g;
    for (const f of list) { const o = document.createElement("option"); o.value = f.family; o.textContent = f.label; og.appendChild(o); }
    sel.appendChild(og);
  }
  sel.value = current ?? "";
}

// 잠깐 뜨는 알림(복사/붙여넣기 등 피드백).
let toastT = null;
function toast(text) {
  let t = document.getElementById("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; document.body.appendChild(t); }
  t.textContent = text; t.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 1400);
}

function setSingleSelection(id) {
  state.selected = id;
  state.anchor = id;
  state.selectedSet = new Set(id ? [id] : []);
  state.editEl = null;
  state.editElSet = new Set();
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
  let out = s;
  // 영상 배경/요소는 썸네일에서 <video> 대신 플레이스홀더로(여러 개 동시 재생 방지)
  if (s.background?.type === "video") {
    out = { ...out, background: { type: "gradient", from: "#1f2933", to: "#0b0e14", angle: 135 } };
  }
  if ((s.elements || []).some((e) => e.type === "video")) {
    out = { ...out, elements: (out.elements || []).map((e) =>
      e.type === "video" ? { type: "shape", shape: "rect", x: e.x, y: e.y, w: e.w, h: e.h, fill: "#0b0e14", stroke: "#556", stroke_width: 1 } : e) };
  }
  return out;
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
  state.editElSet = new Set();
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
  // 초기 로드(명시적 선택 없음)에선 현재 발표 중인 예배를 우선 선택 → 진행 중 발표를 끊지 않고 동기화.
  let target = selectId;
  if (!target) {
    const ps = await callTool("get_presentation_state").catch(() => ({}));
    target = (ps?.service_id && state.services.some((s) => s.id === ps.service_id)) ? ps.service_id : state.services[0]?.id;
  }
  if (target) { sel.value = target; await selectService(target); }
  else { state.service = null; render(); }
}

async function selectService(id) {
  state.serviceId = id;
  state.service = await callTool("get_service", { service_id: id });
  state.theme = await loadServiceTheme(state.service);
  syncThemeControls();
  setSingleSelection(slides()[0]?.id || null);
  resetHistory();          // 새 예배 → 실행취소 기록 초기화(현재 상태를 기준으로)
  render();
  // 발표 화면 동기화: 현재 편집 중인 예배를 발표 대상으로(다르면 첫 슬라이드로, 같으면 유지).
  // 새 세션을 열면 발표 화면 재오픈·새로고침도 이 예배를 따라온다.
  callTool("present_set_service", { service_id: id }).catch(() => {});
}

// ===== 실행취소 / 다시실행 (⌘/Ctrl+Z · ⌘/Ctrl+Shift+Z) =====
// 슬라이드 전체 스냅샷을 선형 스택으로 기록. 각 커밋 후 refresh()에서 자동 기록.
let history = [], histIdx = -1, suppressHistory = false;
function snapshotSlides() {
  return slides().map((s) => ({
    id: s.id,
    elements: structuredClone(s.elements || []),
    background: s.background ? structuredClone(s.background) : null,
    transition: s.transition || "fade",
    hidden: s.hidden ? 1 : 0,
  }));
}
function recordState() {
  if (suppressHistory || !state.service) return;
  const snap = snapshotSlides();
  if (histIdx >= 0 && JSON.stringify(snap) === JSON.stringify(history[histIdx])) return; // 변화 없음
  history = history.slice(0, histIdx + 1);   // redo 가지 잘라내기
  history.push(snap);
  if (history.length > 60) history.shift();
  histIdx = history.length - 1;
  updateUndoButtons();
}
function resetHistory() { history = []; histIdx = -1; suppressHistory = false; recordState(); }
function updateUndoButtons() {
  const u = $("undo-btn"), r = $("redo-btn");
  if (u) u.disabled = histIdx <= 0;
  if (r) r.disabled = histIdx >= history.length - 1;
}
async function restoreSnapshot(snap) {
  suppressHistory = true;
  try {
    await callTool("set_service_slides", { service_id: state.serviceId, slides: snap });
    await refresh();
  } finally { suppressHistory = false; }
  updateUndoButtons();
}
async function undo() {
  if (histIdx <= 0) { toast("더 되돌릴 게 없어요"); return; }
  histIdx--;
  await restoreSnapshot(history[histIdx]);
  toast("실행 취소");
}
async function redo() {
  if (histIdx >= history.length - 1) { toast("다시 실행할 게 없어요"); return; }
  histIdx++;
  await restoreSnapshot(history[histIdx]);
  toast("다시 실행");
}

// reflect the service's theme/color/transition into the topbar controls
function syncThemeControls() {
  const s = state.service;
  if (!s) return;
  $("theme-select").value = s.theme_id;
  $("bg-color").value = state.theme?.background?.value || "#1a1a2e";
  $("accent-color").value = state.theme?.colors?.accent || "#7aa2f7";
  $("font-select").value = s.theme_overrides?.font || "";
  $("transition-select").value = s.transition || "none";
}

async function refresh() {
  state.service = await callTool("get_service", { service_id: state.serviceId });
  const exist = new Set(slides().map((s) => s.id));
  state.selectedSet = new Set([...state.selectedSet].filter((id) => exist.has(id)));
  if (!exist.has(state.selected)) state.selected = slides()[0]?.id || null;
  if (state.selected && state.selectedSet.size === 0) state.selectedSet.add(state.selected);
  recordState();   // 커밋된 변경을 실행취소 스택에 기록(복원 중이면 무시)
  render();
}

async function reloadTheme() {
  state.service = await callTool("get_service", { service_id: state.serviceId });
  state.theme = await loadServiceTheme(state.service);
  syncThemeControls();
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
    await reloadTheme();
  };
  // custom colors: background (테마 기본 배경) + accent (메인)
  const setOverride = async (patch) => {
    const cur = state.service?.theme_overrides || {};
    await callTool("set_service_theme", { service_id: state.serviceId, overrides: { ...cur, ...patch } });
    await reloadTheme();
  };
  $("bg-color").onchange = (e) => setOverride({ background: { type: "color", value: e.target.value } });
  $("accent-color").onchange = (e) => setOverride({ accent: e.target.value });
  $("font-select").onchange = (e) => setOverride({ font: e.target.value || undefined });
  $("theme-reset").onclick = async () => {
    await callTool("set_service_theme", { service_id: state.serviceId, overrides: null });
    await reloadTheme();
  };
  $("transition-select").onchange = async (e) => {
    await callTool("set_service_transition", { service_id: state.serviceId, transition: e.target.value });
    state.service.transition = e.target.value;
    try { await callTool("present_reload"); } catch {}
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
    const row = elx("div", "slide-row" + (sel ? " sel" : "") + (s.id === state.selected ? " primary" : "") + (s.hidden ? " hidden" : ""));
    row.draggable = true;
    row.dataset.id = s.id;
    const meta = elx("div", "row-meta");
    meta.append(elx("span", "badge", slideKind(s)), elx("span", "label", slideLabel(s)));
    const hide = elx("button", "hide" + (s.hidden ? " on" : ""), s.hidden ? "⊘" : "◉");
    hide.title = s.hidden ? "발표에 다시 보이기" : "발표에서 숨기기";
    hide.onclick = (e) => { e.stopPropagation(); toggleHidden(s.id); };
    const del = elx("button", "del danger", "✕");
    del.onclick = (e) => { e.stopPropagation(); removeSlide(s.id); };
    row.append(elx("span", "num", String(i + 1)), buildThumb(s), meta, hide, del);
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

// ---- snapping to canvas edges/center (0, 0.5, 1) with visual guides ----
const SNAP_TARGETS = [0, 0.5, 1];
const SNAP_TOL = 0.012;
let activeGuides = { v: null, h: null }; // fractions where guide lines show

// Snap a moving box: try aligning its left/center/right (x-axis) and
// top/middle/bottom (y-axis) to targets. Returns adjusted {x,y} + records guides.
function snapMove(x, y, w, h) {
  activeGuides = { v: null, h: null };
  const axis = (start, size) => {
    let best = null;
    for (const [lineOffset, key] of [[0, "s"], [size / 2, "c"], [size, "e"]]) {
      for (const t of SNAP_TARGETS) {
        const d = Math.abs(start + lineOffset - t);
        if (d < SNAP_TOL && (!best || d < best.d)) best = { d, newStart: t - lineOffset, guide: t };
      }
    }
    return best;
  };
  const bx = axis(x, w), by = axis(y, h);
  if (bx) { x = bx.newStart; activeGuides.v = bx.guide; }
  if (by) { y = by.newStart; activeGuides.h = by.guide; }
  return { x, y };
}

// Snap a single dragged edge value to targets (for resize).
function snapEdge(v) {
  for (const t of SNAP_TARGETS) if (Math.abs(v - t) < SNAP_TOL) return t;
  return v;
}

function renderGuides() {
  const layer = $("preview")?.querySelector(":scope > .edit-layer");
  if (!layer) return;
  layer.querySelectorAll(".guide-v, .guide-h").forEach((n) => n.remove());
  if (activeGuides.v != null) { const g = elx("div", "guide-v"); g.style.left = activeGuides.v * 100 + "%"; layer.appendChild(g); }
  if (activeGuides.h != null) { const g = elx("div", "guide-h"); g.style.top = activeGuides.h * 100 + "%"; layer.appendChild(g); }
}
function clearGuides() { activeGuides = { v: null, h: null }; renderGuides(); }

// Interactive handle layer over #preview: select / move / resize elements.
function renderEditLayer() {
  const pv = $("preview");
  if (!pv) return;
  let layer = pv.querySelector(":scope > .edit-layer");
  if (state.mode !== "list" || !selectedSlide()) { layer?.remove(); return; }
  if (!layer) {
    layer = elx("div", "edit-layer");
    // 빈 곳에서 드래그 → 마퀴 멀티선택(클릭만 하면 선택 해제)
    layer.addEventListener("mousedown", (e) => { if (e.target === layer) startMarquee(e); });
    // 더블클릭 → '내용' 입력 포커스. selectEl이 매번 .eh 노드를 교체하므로 리스너는
    // (교체되지 않는) 레이어에 위임한다. 요소 인덱스는 capture 단계 mousedown으로 추적
    // (요소의 stopPropagation 이전에 실행). 트리거는 브라우저 네이티브 dblclick(정확한 임계값).
    layer._dblIndex = -1;
    layer.addEventListener("mousedown", (e) => {
      const eh = e.target.closest(".eh");
      layer._dblIndex = eh ? Number(eh.dataset.elIndex) : -1;
    }, true);
    layer.addEventListener("dblclick", (e) => {
      e.preventDefault();
      if (layer._dblIndex < 0) return;
      // 텍스트·성경/찬송/교독 본문은 캔버스에서 바로 인라인 편집(전체/일부 글꼴·색), 그 외는 패널.
      const t = els()[layer._dblIndex]?.type;
      if (["text", "bible", "hymn", "reading"].includes(t)) startInlineEdit(layer._dblIndex);
      else focusElementContent(layer._dblIndex);
    });
    pv.appendChild(layer);
  }
  layer.replaceChildren();
  els().forEach((el, i) => {
    const h = elx("div", "eh" + (state.editElSet.has(i) ? " sel" : ""));
    h.dataset.elIndex = i;
    h.style.left = (el.x ?? 0.4) * 100 + "%";
    h.style.top = (el.y ?? 0.4) * 100 + "%";
    h.style.width = (el.w ?? 0.2) * 100 + "%";
    h.style.height = (el.h ?? 0.12) * 100 + "%";
    h.addEventListener("mousedown", (e) => startMove(e, i));
    // 리사이즈 핸들은 단일 선택일 때만(다중은 이동만)
    if (i === state.editEl && state.editElSet.size === 1) {
      for (const pos of ["nw", "ne", "sw", "se"]) {
        const k = elx("div", "handle " + pos);
        k.addEventListener("mousedown", (e) => startResize(e, i, pos));
        h.appendChild(k);
      }
    }
    layer.appendChild(h);
  });
}

// 캔버스 빈 곳에서 드래그해 사각형 안(겹치는) 요소들을 다중 선택.
function startMarquee(e) {
  if (e.button !== 0) return;
  const pv = $("preview");
  const layer = pv.querySelector(":scope > .edit-layer");
  const rect = pv.getBoundingClientRect();
  const x0 = clamp01((e.clientX - rect.left) / rect.width);
  const y0 = clamp01((e.clientY - rect.top) / rect.height);
  const box = elx("div", "marquee");
  layer.appendChild(box);
  let moved = false, x1 = x0, y1 = y0;
  const draw = () => {
    box.style.left = Math.min(x0, x1) * 100 + "%";
    box.style.top = Math.min(y0, y1) * 100 + "%";
    box.style.width = Math.abs(x1 - x0) * 100 + "%";
    box.style.height = Math.abs(y1 - y0) * 100 + "%";
  };
  draw();
  const mv = (ev) => {
    moved = true;
    x1 = clamp01((ev.clientX - rect.left) / rect.width);
    y1 = clamp01((ev.clientY - rect.top) / rect.height);
    draw();
  };
  const up = () => {
    document.removeEventListener("mousemove", mv);
    document.removeEventListener("mouseup", up);
    box.remove();
    if (!moved) { selectEl(null); return; }   // 클릭만 → 선택 해제
    const mx0 = Math.min(x0, x1), my0 = Math.min(y0, y1), mx1 = Math.max(x0, x1), my1 = Math.max(y0, y1);
    const hit = [];
    els().forEach((el, i) => {
      const ex0 = el.x ?? 0.4, ey0 = el.y ?? 0.4, ex1 = ex0 + (el.w ?? 0.2), ey1 = ey0 + (el.h ?? 0.12);
      if (ex0 < mx1 && ex1 > mx0 && ey0 < my1 && ey1 > my0) hit.push(i); // AABB 겹침
    });
    selectEls(hit);
  };
  document.addEventListener("mousemove", mv);
  document.addEventListener("mouseup", up);
}

// Lightweight repaint during drag (no background rebuild → no video reload).
function repaintEls() {
  const ov = $("preview")?.querySelector(":scope > .layer-elements");
  if (ov) renderElements(ov, els());
  renderEditLayer();
}

function selectEl(i) {
  state.editEl = i;
  state.editElSet = i == null ? new Set() : new Set([i]);
  if (i != null) showTab("design");
  renderEditLayer();
  renderDesignPanel();
}

// 여러 요소를 한 번에 선택(마퀴). 첫 요소를 primary(디자인 패널)로.
function selectEls(indices) {
  state.editElSet = new Set(indices);
  state.editEl = indices.length ? indices[0] : null;
  if (indices.length) showTab("design");
  renderEditLayer();
  renderDesignPanel();
}

// 요소를 선택하고 디자인 패널의 '내용' 입력으로 포커스를 옮긴다(더블클릭 시).
// 텍스트 요소면 '내용' textarea, 콘텐츠 요소는 첫 편집 입력에 포커스한다.
function focusElementContent(i) {
  selectEl(i);                                     // 선택 + 디자인 탭 + 패널 렌더
  const body = $("el-props");
  const input = body?.querySelector('[data-field="text"]') || body?.querySelector("textarea, input[type='text'], input:not([type])");
  if (input) {
    input.focus();
    if (input.setSelectionRange) input.setSelectionRange(input.value.length, input.value.length); // 커서 끝으로
  }
}

// 입력 중(텍스트 필드·contentEditable)인지 — 전역 단축키(Del/방향키/복사 등)가
// 편집을 가로채지 않도록 가드에 사용.
function isTypingTarget() {
  const a = document.activeElement;
  if (!a) return false;
  return a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT" || a.isContentEditable;
}

// ----- 인라인 편집용 플로팅 서식 바 (드래그로 글자 선택 → 색/굵기 적용) -----
// 색 도구가 캔버스 위에 떠서, 선택을 유지한 채 부분 색상을 적용한다(패널로 가면 선택이 풀림).
// 스와치=최근 쓴 색 6종(부족하면 기본색으로 채움). 버튼은 mousedown 기본동작을 막아
// 편집 포커스를 뺏지 않는다 → 색이 확실히 적용됨.
const FMT_DEFAULT_COLORS = ["#ffffff", "#ffd43b", "#ff6b6b", "#4dabf7", "#69db7c", "#000000"];
function fmtSwatchColors() {
  const out = [...recentColors()];                    // 최근 색 우선
  for (const c of FMT_DEFAULT_COLORS) { if (out.length >= 6) break; if (!out.includes(c.toLowerCase())) out.push(c); }
  return out.slice(0, 6);
}
let fmtBar = null, fmtNode = null, fmtRange = null;
function getFmtBar() {
  if (fmtBar && fmtBar.isConnected) return fmtBar;
  const bar = elx("div", "inline-fmt"); bar.hidden = true;
  bar.appendChild(elx("div", "fmt-swatches"));        // 최근 색(보여줄 때마다 채움)
  // 커스텀 색(네이티브 피커). 피커는 포커스를 가져가지만 저장된 선택을 복원해 적용한다(preventDefault 안 함=피커 열림).
  const custom = document.createElement("input");
  custom.type = "color"; custom.className = "fmt-color"; custom.value = "#ffcc00"; custom.title = "커스텀 색";
  custom.addEventListener("input", () => applyColor(custom.value));
  bar.appendChild(custom);
  const keepFocus = (b) => { b.onmousedown = (e) => e.preventDefault(); return b; };  // 편집 포커스 유지
  const mk = (label, title, fn) => { const b = keepFocus(elx("button", "fmt-btn", label)); b.title = title; b.onclick = () => applyFmt(fn); return b; };
  bar.append(mk("B", "굵게", () => document.execCommand("bold")));
  // 글꼴 선택(선택 영역에 적용). 첫 옵션은 안내용.
  const fontSel = document.createElement("select"); fontSel.className = "fmt-font"; fontSel.title = "선택 글자 글꼴";
  const ph = document.createElement("option"); ph.value = ""; ph.textContent = "글꼴"; fontSel.appendChild(ph);
  fillFontSelect(fontSel, "");
  fontSel.querySelectorAll("option").forEach((o) => { if (o.value === "" && o.textContent !== "글꼴") o.remove(); }); // "테마 기본" 중복 제거
  fontSel.addEventListener("change", () => { if (fontSel.value) applyFmt(() => document.execCommand("fontName", false, fontSel.value)); fontSel.value = ""; });
  bar.append(fontSel, mk("✕", "서식 지움", () => document.execCommand("removeFormat")));
  document.body.appendChild(bar);
  fmtBar = bar; return bar;
}
// 최근 색 스와치를 다시 그린다(바를 띄울 때마다). 최근에 쓴 색이 앞으로 온다.
function renderFmtSwatches() {
  const sws = fmtBar?.querySelector(".fmt-swatches");
  if (!sws) return;
  sws.replaceChildren();
  for (const c of fmtSwatchColors()) {
    const sw = elx("button", "fmt-sw"); sw.style.background = c; sw.title = c;
    sw.onmousedown = (e) => e.preventDefault();       // 포커스 유지(색 확실히 적용)
    sw.onclick = () => applyColor(c);
    sws.appendChild(sw);
  }
}
function applyColor(hex) {
  applyFmt(() => document.execCommand("foreColor", false, hex));
  pushRecentColor(hex);                                // 방금 쓴 색을 최근 목록 맨 앞으로
}
function hideFmtBar() { if (fmtBar) fmtBar.hidden = true; }
function fmtBarHasFocus() { return !!(fmtBar && fmtBar.contains(document.activeElement)); }
// 저장해둔 선택영역을 복원한 뒤 서식 적용 → el에 라이브 저장(커밋은 blur).
function applyFmt(fn) {
  if (fmtNode == null || state.inlineEdit == null) return;
  fmtNode.focus();
  if (fmtRange) { const s = window.getSelection(); s.removeAllRanges(); s.addRange(fmtRange); }
  fn();
  const s2 = window.getSelection();
  if (s2.rangeCount && !s2.getRangeAt(0).collapsed) fmtRange = s2.getRangeAt(0).cloneRange();  // 적용 후 갱신
  const el = els()[state.inlineEdit];
  if (el) { el.html = fmtNode.innerHTML; el.text = fmtNode.innerText; }
}
// 편집 대상 = 렌더된 텍스트의 내부 블록(.el-text-inner).
function inlineNode(i) {
  const box = $("preview")?.querySelectorAll(":scope > .layer-elements > .el")[i];
  return box ? (box.querySelector(".el-text-inner") || box) : null;
}
// 인라인 편집 중, 노드 안에서 드래그 선택하면 서식 바를 선택 위에 띄운다.
document.addEventListener("selectionchange", () => {
  if (state.inlineEdit == null) { hideFmtBar(); return; }
  if (fmtBarHasFocus()) return;                       // 바(커스텀 색 피커) 조작 중엔 유지
  const node = inlineNode(state.inlineEdit);
  const sel = window.getSelection();
  if (!node || !sel.rangeCount) { hideFmtBar(); return; }
  const range = sel.getRangeAt(0);
  if (range.collapsed || !node.contains(range.commonAncestorContainer)) { hideFmtBar(); return; }
  fmtNode = node; fmtRange = range.cloneRange();
  const bar = getFmtBar();
  renderFmtSwatches();                                 // 최근 색으로 갱신
  const r = range.getBoundingClientRect();
  bar.hidden = false;
  bar.style.left = (r.left + r.width / 2) + "px";
  bar.style.top = (r.top - 8) + "px";
});

// 캔버스에서 텍스트 요소를 바로 인라인 편집(더블클릭·텍스트 추가 시). 렌더된 노드를
// contentEditable로 만들어 그 자리에서 입력 → blur/Esc에 저장. 편집 중엔 edit-layer를
// 통과시켜(pointer-events:none) 커서·선택이 노드에 닿게 한다.
const INLINE_TYPES = new Set(["text", "bible", "hymn", "reading"]);
function startInlineEdit(i, opts = {}) {
  const el = els()[i];
  if (!el || !INLINE_TYPES.has(el.type)) { focusElementContent(i); return; }
  selectEl(i);                                       // 선택 + 디자인 탭 + 패널
  state.inlineEdit = i;
  const pv = $("preview");
  const layer = pv.querySelector(":scope > .edit-layer");
  if (layer) layer.style.pointerEvents = "none";     // 렌더 노드가 클릭/커서를 받도록
  const box = pv.querySelectorAll(":scope > .layer-elements > .el")[i];
  const node = box ? (box.querySelector(".el-text-inner") || box) : null;
  if (!node) { state.inlineEdit = null; if (layer) layer.style.pointerEvents = ""; return; }
  box.classList.add("inline-editing");
  node.contentEditable = "true";
  node.spellcheck = false;
  // 텍스트: el.html/el.text로 편집 원본을 채운다. 콘텐츠(성경/찬송/교독): 이미 렌더된
  // 본문(구조 또는 el.html)을 그대로 편집 대상으로 삼는다(내용을 지우지 않음).
  if (el.type === "text") { if (el.html) node.innerHTML = el.html; else node.textContent = el.text ?? ""; }
  node.focus();
  const sel = window.getSelection(), range = document.createRange();
  range.selectNodeContents(node);
  if (!opts.selectAll) range.collapse(false);        // 기본: 커서 끝 / 새 요소: 전체 선택
  sel.removeAllRanges(); sel.addRange(range);
  let dirty = false;
  const onInput = () => { dirty = true; el.html = node.innerHTML; el.text = node.innerText; }; // 라이브(리페인트 X: 포커스 유지)
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); node.blur(); return; }
    e.stopPropagation();                             // 전역 단축키로 새지 않게(Del 등)
  };
  const finish = (ev) => {
    // 서식 바(커스텀 색 피커 등)로 포커스가 옮겨간 blur면 편집을 끝내지 않는다.
    if (ev && fmtBar && (fmtBar.contains(ev.relatedTarget) || fmtBarHasFocus())) return;
    node.removeEventListener("input", onInput);
    node.removeEventListener("keydown", onKey);
    node.removeEventListener("blur", finish);
    node.contentEditable = "false";
    box.classList.remove("inline-editing");
    state.inlineEdit = null;
    hideFmtBar(); fmtNode = null;                     // 플로팅 서식 바 닫기
    if (layer) layer.style.pointerEvents = "";       // edit-layer는 refresh에도 재사용되므로 꼭 복구
    // 콘텐츠 요소는 실제로 편집했을 때만 el.html 저장(무편집 시 구조 렌더 유지).
    if (el.type === "text" || dirty) { el.html = node.innerHTML; el.text = node.innerText; }
    commitEls();                                     // 저장 + refresh(정식 렌더로 복귀)
  };
  node.addEventListener("input", onInput);
  node.addEventListener("keydown", onKey);
  node.addEventListener("blur", finish);
}

function startMove(e, i) {
  if (e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  // 선택 밖의 요소를 누르면 단일 선택으로, 이미 선택된 그룹이면 그룹을 함께 이동.
  if (!state.editElSet.has(i)) selectEl(i);
  const rect = $("preview").getBoundingClientRect();
  const group = [...state.editElSet];
  const single = group.length <= 1;
  const orig = group.map((gi) => ({ i: gi, x: els()[gi].x ?? 0.4, y: els()[gi].y ?? 0.4 }));
  const sx = e.clientX, sy = e.clientY;
  let moved = false;
  const mv = (ev) => {
    moved = true;
    const dx = (ev.clientX - sx) / rect.width, dy = (ev.clientY - sy) / rect.height;
    if (single) {
      const el = els()[i];
      let x = clamp01((orig[0]?.x ?? 0.4) + dx), y = clamp01((orig[0]?.y ?? 0.4) + dy);
      ({ x, y } = snapMove(x, y, el.w ?? 0.2, el.h ?? 0.12)); // snap only single
      el.x = x; el.y = y;
    } else {
      for (const o of orig) { const el = els()[o.i]; el.x = clamp01(o.x + dx); el.y = clamp01(o.y + dy); }
    }
    repaintEls(); renderGuides();
  };
  // 움직였을 때만 저장. 단순 클릭/더블클릭에서 commit→비동기 refresh가
  // 디자인 패널을 다시 그려 '내용' 입력 포커스를 뺏는 것을 막는다.
  const up = () => { document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); clearGuides(); if (moved) commitEls(); };
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
    activeGuides = { v: null, h: null };
    if (pos.includes("e")) { const r = snapEdge(o.x + o.w + dx); el.w = Math.max(0.03, r - o.x); if (r !== o.x + o.w + dx) activeGuides.v = r; }
    if (pos.includes("s")) { const b = snapEdge(o.y + o.h + dy); el.h = Math.max(0.03, b - o.y); if (b !== o.y + o.h + dy) activeGuides.h = b; }
    if (pos.includes("w")) { const l = snapEdge(o.x + dx); el.x = l; el.w = Math.max(0.03, o.x + o.w - l); if (l !== o.x + dx) activeGuides.v = l; }
    if (pos.includes("n")) { const t = snapEdge(o.y + dy); el.y = t; el.h = Math.max(0.03, o.y + o.h - t); if (t !== o.y + dy) activeGuides.h = t; }
    repaintEls(); renderGuides();
  };
  const up = () => { document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); clearGuides(); commitEls(); };
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
  image: () => ({ type: "image", x: 0.35, y: 0.32, w: 0.3, h: 0.3, fit: "contain" }),
  // 영상 요소: 로컬 업로드/URL. muted:false = 발표에서 소리 재생.
  video: () => ({ type: "video", x: 0.25, y: 0.2, w: 0.5, h: 0.5, url: "", fit: "contain", loop: true, muted: false }),
};

async function addElement(kind, extra) {
  const slide = selectedSlide();
  if (!slide) { msg("add-msg", "슬라이드를 먼저 선택하세요.", true); return; }
  const el = { ...ADD_DEFAULTS[kind](), ...extra };
  slide.elements = [...(slide.elements || []), el];
  state.editEl = slide.elements.length - 1;
  await commitEls();
  selectEl(state.editEl);
  if (kind === "text") startInlineEdit(state.editEl, { selectAll: true }); // 추가하자마자 캔버스에서 입력
}

function deleteEl(i) {
  const slide = selectedSlide();
  if (!slide || i == null) return;
  slide.elements = (slide.elements || []).filter((_, j) => j !== i);
  state.editEl = null;
  state.editElSet = new Set();
  commitEls();
}

// 선택된 요소들(단일·다중)을 한 번에 삭제.
function deleteSelectedEls() {
  const slide = selectedSlide();
  if (!slide || !state.editElSet.size) return;
  const rm = state.editElSet;
  slide.elements = (slide.elements || []).filter((_, j) => !rm.has(j));
  state.editEl = null;
  state.editElSet = new Set();
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
  reading: [["all", "전체(인도자+회중)"], ["title", "제목"], ["body", "본문(인도자+회중)"], ["leader", "인도자만"], ["congregation", "회중만"], ["unison", "다같이만"]],
};
// 형식(format): 단일 줄 필드의 표시 문자열 (기본값 + 사용 가능 토큰)
const FMT_DEFAULT = {
  hymn: { title: "{number}장 {title}", label: "{label}" },
  bible: { ref: "{ref}" },
  reading: { title: "{number}번 {title}" },
};
const FMT_TOKENS = {
  hymn: { title: "{number}, {title}", label: "{label}" },
  bible: { ref: "{ref}" },
  reading: { title: "{number}, {title}" },
};

// ---- 색 팔레트: 이 예배에 쓰인 색 + 최근 쓴 색(localStorage) ----
const isHex = (c) => typeof c === "string" && /^#[0-9a-fA-F]{3,8}$/.test(c);
function serviceColors() {
  const set = new Set();
  const add = (c) => { if (isHex(c)) set.add(c.toLowerCase()); };
  for (const s of slides()) {
    if (s.background?.type === "color") add(s.background.value);
    if (s.background?.type === "gradient") { add(s.background.from); add(s.background.to); }
    for (const e of s.elements || []) { add(e.color); add(e.fill); add(e.stroke); }
  }
  return [...set];
}
function recentColors() { try { return JSON.parse(localStorage.getItem("lyra.recentColors") || "[]"); } catch { return []; } }
function pushRecentColor(hex) {
  if (!isHex(hex)) return;
  hex = hex.toLowerCase();
  const list = [hex, ...recentColors().filter((c) => c !== hex)].slice(0, 12);
  localStorage.setItem("lyra.recentColors", JSON.stringify(list));
}
// 스와치 묶음(최근 → 이 예배). onPick(hex) 호출. 없으면 null.
function colorSwatches(current, onPick) {
  const wrap = elx("div", "swatches");
  const seen = new Set();
  const addSw = (hex, group) => {
    if (!isHex(hex) || seen.has(hex.toLowerCase())) return;
    seen.add(hex.toLowerCase());
    const b = document.createElement("button");
    b.type = "button"; b.className = "swatch" + (hex.toLowerCase() === (current || "").toLowerCase() ? " cur" : "");
    b.style.background = hex; b.title = `${group}: ${hex}`;
    b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); onPick(hex); };
    wrap.appendChild(b);
  };
  recentColors().forEach((c) => addSw(c, "최근"));
  serviceColors().forEach((c) => addSw(c, "이 예배"));
  return wrap.children.length ? wrap : null;
}

// 찬송가 제목·가사로 검색 → 결과 클릭 시 onPick(number, title). 번호를 몰라도 찾도록.
function hymnSearchField(placeholder, onPick) {
  const wrap = elx("div", "hymn-search");
  const input = document.createElement("input");
  input.type = "search"; input.placeholder = placeholder || "찬송가 제목·가사로 검색 (예: 만복, 주 예수)";
  const results = elx("div", "hymn-search-results"); results.hidden = true;
  let timer = null;
  const doSearch = async () => {
    const q = input.value.trim();
    if (!q) { results.hidden = true; results.replaceChildren(); return; }
    try {
      const { results: hits } = await callTool("search_hymn", { query: q, limit: 12 });
      results.replaceChildren();
      if (!hits.length) { results.append(elx("div", "hymn-hit-empty", "결과 없음")); results.hidden = false; return; }
      for (const h of hits) {
        const row = elx("button", "hymn-hit"); row.type = "button";
        row.append(elx("span", "hh-no", `${h.number}장`), elx("span", "hh-title", h.title));
        row.onmousedown = (e) => e.preventDefault();   // 클릭해도 입력 포커스 유지
        row.onclick = () => { results.hidden = true; onPick(h.number, h.title); };
        results.appendChild(row);
      }
      results.hidden = false;
    } catch (e) { results.replaceChildren(elx("div", "hymn-hit-empty", e.message)); results.hidden = false; }
  };
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(doSearch, 200); });
  input.addEventListener("focus", () => { if (results.children.length) results.hidden = false; });
  input.addEventListener("blur", () => setTimeout(() => { results.hidden = true; }, 150));
  wrap.append(input, results);
  return wrap;
}

function renderDesignPanel() {
  const empty = $("el-empty"), body = $("el-props");
  // 편집할 때마다 commitEls→refresh→render로 이 패널을 다시 그리는데, 그때 스크롤이
  // 맨 위로 튀지 않도록 스크롤 컨테이너(.col.panel)의 위치를 보존한다.
  const panel = body.closest(".col");
  const savedScroll = panel ? panel.scrollTop : 0;
  const restoreScroll = () => { if (panel) panel.scrollTop = savedScroll; };
  // 다중 선택: 개별 속성 대신 요약 + 일괄 동작
  if (state.editElSet.size > 1) {
    empty.hidden = true; body.hidden = false;
    body.replaceChildren();
    body.appendChild(elx("div", "section-title", `${state.editElSet.size}개 요소 선택됨`));
    body.appendChild(elx("p", "hint muted", "드래그로 함께 이동 · 방향키 미세이동 · Del 삭제 · ⌘/Ctrl+C·V 복사/붙여넣기"));
    const del = elx("button", "mini danger", "선택 요소 삭제"); del.onclick = () => deleteSelectedEls();
    body.appendChild(del);
    restoreScroll();
    return;
  }
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
      if (commit) { commitEls(); if (type === "color") pushRecentColor(el[fieldName]); }
    };
    input.addEventListener("input", () => apply(false));
    input.addEventListener("change", () => apply(true));
    input.dataset.field = fieldName;   // 더블클릭 → 해당 입력 포커스용
    wrap.appendChild(input);
    // 색 입력엔 팔레트 스와치(이 예배 색 + 최근 색)를 붙여 빠르게 재사용
    if (type === "color") {
      const sw = colorSwatches(el[fieldName], (hex) => { input.value = hex; apply(true); renderDesignPanel(); });
      if (sw) wrap.appendChild(sw);
    }
    body.appendChild(wrap);
  };

  // 글자 크기: 슬라이더 + 숫자(정확값). 여러 슬라이드에 동일 값 적용 가능.
  const sizeRow = (min, max, def = 4) => {
    const wrap = elx("label", null, "글자 크기 (숫자)");
    const row = elx("div", "size-row");
    const range = document.createElement("input"); range.type = "range"; range.min = min; range.max = max; range.step = 0.1;
    const num = document.createElement("input"); num.type = "number"; num.min = min; num.max = max; num.step = 0.1;
    range.value = num.value = el.size ?? def;
    const apply = (v, commit) => { el.size = Number(v); range.value = num.value = el.size; repaintEls(); if (commit) commitEls(); };
    range.addEventListener("input", () => apply(range.value, false));
    range.addEventListener("change", () => apply(range.value, true));
    num.addEventListener("input", () => apply(num.value, false));
    num.addEventListener("change", () => apply(num.value, true));
    row.append(range, num); wrap.appendChild(row); body.appendChild(wrap);
  };

  // 슬라이더 + 숫자 조합으로 임의 숫자 필드 편집(줄 간격 등).
  const numRow = (label, fieldName, { min, max, step, def }) => {
    const wrap = elx("label", null, label);
    const row = elx("div", "size-row");
    const range = document.createElement("input"); range.type = "range"; range.min = min; range.max = max; range.step = step;
    const num = document.createElement("input"); num.type = "number"; num.min = min; num.max = max; num.step = step;
    range.value = num.value = el[fieldName] ?? def;
    const apply = (v, commit) => { el[fieldName] = Number(v); range.value = num.value = el[fieldName]; repaintEls(); if (commit) commitEls(); };
    range.addEventListener("input", () => apply(range.value, false));
    range.addEventListener("change", () => apply(range.value, true));
    num.addEventListener("input", () => apply(num.value, false));
    num.addEventListener("change", () => apply(num.value, true));
    row.append(range, num); wrap.appendChild(row); body.appendChild(wrap);
  };

  // 글꼴: 용도 그룹(optgroup) select. 값=family("" → 테마 기본 상속).
  const fontField = () => {
    const wrap = elx("label", null, "글꼴");
    const sel = document.createElement("select");
    fillFontSelect(sel, el.font || "");
    sel.addEventListener("change", () => { el.font = sel.value; repaintEls(); commitEls(); });
    wrap.appendChild(sel); body.appendChild(wrap);
  };

  // 리치 텍스트 '내용' 편집기: 일부만 선택해 색/굵기 적용(부분 색상). el.html에 저장, el.text=평문.
  const richTextField = () => {
    const wrap = elx("label", null, "내용 (일부 선택 후 색/굵기 적용 가능)");
    const ed = document.createElement("div");
    ed.className = "rt-editor"; ed.contentEditable = "true"; ed.dataset.field = "text";
    if (el.html) ed.innerHTML = el.html; else ed.textContent = el.text ?? "";
    const save = (commit) => { el.html = ed.innerHTML; el.text = ed.innerText; repaintEls(); if (commit) commitEls(); };
    // 선택영역 추적: 색 입력(네이티브 피커) 상호작용으로 선택이 풀려도 복원해 적용.
    let range = null;
    const track = () => { const s = window.getSelection(); if (s.rangeCount && ed.contains(s.anchorNode)) range = s.getRangeAt(0).cloneRange(); };
    ed.addEventListener("keyup", track);
    ed.addEventListener("mouseup", track);
    ed.addEventListener("input", () => { track(); save(false); });  // 타이핑: 라이브(커밋은 blur)
    ed.addEventListener("blur", () => save(true));
    const apply = (fn) => {
      ed.focus();
      if (range) { const s = window.getSelection(); s.removeAllRanges(); s.addRange(range); }
      fn(); track(); save(false);
    };
    // 서식 툴바
    const bar = elx("div", "rt-bar");
    const color = document.createElement("input"); color.type = "color"; color.value = "#ffcc00"; color.title = "선택한 글자 색";
    color.addEventListener("input", () => apply(() => document.execCommand("foreColor", false, color.value)));
    const btn = (label, fn) => { const b = elx("button", "mini", label); b.onmousedown = (e) => e.preventDefault(); b.onclick = () => apply(fn); return b; };
    bar.append(color,
      btn("선택 색", () => document.execCommand("foreColor", false, color.value)),
      btn("굵게", () => document.execCommand("bold")),
      btn("서식 지움", () => document.execCommand("removeFormat")));
    wrap.append(ed, bar); body.appendChild(wrap);
  };

  // 텍스트 효과(그림자·외곽선) — 텍스트·성경/가사 공통. 영상 위 가독성용.
  const effectFields = () => {
    body.appendChild(elx("div", "section-title", "효과"));
    { const wrap = elx("label", null, "그림자");
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !!el.shadow;
      cb.onchange = () => { el.shadow = cb.checked; repaintEls(); commitEls(); renderDesignPanel(); };
      wrap.appendChild(cb); body.appendChild(wrap); }
    if (el.shadow) {
      field("그림자 색", "color", "shadow_color", { def: "#000000" });
      numRow("그림자 번짐", "shadow_blur", { min: 0, max: 0.4, step: 0.02, def: 0.12 });
    }
    numRow("외곽선 두께(px)", "outline_width", { min: 0, max: 8, step: 0.5, def: 0 });
    field("외곽선 색", "color", "outline_color", { def: "#000000" });
  };

  if (el.type === "text") {
    richTextField();
    sizeRow(1.5, 12);
    fontField();
    field("색(전체 기본)", "color", "color", { def: "#ffffff" });
    field("굵기", "select", "weight", { options: [["400", "보통"], ["600", "중간"], ["700", "굵게"], ["800", "더 굵게"]] });
    field("정렬(가로)", "select", "align", { options: [["center", "가운데"], ["left", "왼쪽"], ["right", "오른쪽"]] });
    field("정렬(세로)", "select", "valign", { options: [["middle", "가운데"], ["top", "위"], ["bottom", "아래"]] });
    numRow("줄 간격 (숫자)", "line_height", { min: 1, max: 2.6, step: 0.05, def: 1.3 });
    effectFields();
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
  } else if (el.type === "video") {
    // URL 직접 입력
    { const wrap = elx("label", null, "영상 URL");
      const input = document.createElement("input"); input.type = "text"; input.value = el.url || "";
      input.placeholder = "https://…  또는 아래에서 파일 선택";
      input.oninput = () => { el.url = input.value; };
      input.onchange = () => { el.url = input.value; repaintEls(); commitEls(); };
      wrap.appendChild(input); body.appendChild(wrap);
      // 로컬 파일 업로드
      const file = document.createElement("input"); file.type = "file"; file.accept = "video/*";
      file.onchange = async () => {
        if (!file.files[0]) return;
        msg("add-msg", "영상 업로드 중…");
        try { const { url } = await uploadFile(file.files[0]); el.url = url; input.value = url; repaintEls(); commitEls(); msg("add-msg", "업로드 완료"); }
        catch (e) { msg("add-msg", e.message, true); }
      };
      body.appendChild(file);
    }
    field("반복 재생", "check", "loop");
    // 소리: 체크 = 소리 켜짐(= muted:false). 소리는 발표 화면에서만 재생됨.
    { const wrap = elx("label", null, "소리 (발표 화면에서)");
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !el.muted;
      cb.onchange = () => { el.muted = !cb.checked; repaintEls(); commitEls(); };
      wrap.appendChild(cb); body.appendChild(wrap);
    }
    field("채움", "select", "fit", { options: [["contain", "전체 보이기"], ["cover", "꽉 채우기"]] });
    body.appendChild(elx("p", "hint muted", "편집 미리보기는 음소거이고, 소리는 발표 화면에서 재생됩니다."));
  } else if (["bible", "hymn", "reading"].includes(el.type)) {
    { // 표시 항목(field): 바꾸면 즉시 반영 + 패널 갱신(절 번호 표시 노출 여부)
      const wrap = elx("label", null, "표시 항목");
      const sel = document.createElement("select");
      for (const [v, t] of FIELD_OPTIONS[el.type]) { const o = document.createElement("option"); o.value = v; o.textContent = t; sel.appendChild(o); }
      sel.value = el.field ?? "all";
      sel.onchange = () => { el.field = sel.value; repaintEls(); commitEls(); renderDesignPanel(); };
      wrap.appendChild(sel); body.appendChild(wrap);
    }
    const fkey = el.field ?? "all";
    { // 형식(format): 단일 줄 필드(제목/구절)의 표시 문자열
      const fmtDef = FMT_DEFAULT[el.type]?.[fkey];
      if (fmtDef != null) {
        const wrap = elx("label", null, "형식");
        const input = document.createElement("input");
        input.type = "text"; input.value = el.format ?? fmtDef; input.placeholder = fmtDef;
        input.oninput = () => { el.format = input.value; repaintEls(); };
        input.onchange = () => { el.format = input.value; commitEls(); };
        wrap.appendChild(input); body.appendChild(wrap);
        body.appendChild(elx("p", "hint muted", `토큰: ${FMT_TOKENS[el.type][fkey]}`));
      }
    }
    body.appendChild(elx("p", "hint muted", "본문을 더블클릭하면 전체·일부 글자의 글꼴·색을 바꿀 수 있어요(선택 후 떠오르는 서식 바)."));
    sizeRow(1.5, 10, 3.2);
    fontField();
    field("색(전체)", "color", "color", { def: "#ffffff" });
    field("정렬(가로)", "select", "align", { options: [["center", "가운데"], ["left", "왼쪽"], ["right", "오른쪽"]] });
    field("정렬(세로)", "select", "valign", { options: [["middle", "가운데"], ["top", "위"], ["bottom", "아래"]] });
    numRow("줄 간격 (숫자)", "line_height", { min: 1, max: 2.6, step: 0.05, def: 1.5 });
    field("굵기", "select", "weight", { options: [["400", "보통"], ["600", "중간"], ["700", "굵게"], ["800", "더 굵게"]] });
    if (el.type === "bible" && fkey !== "ref") field("절 번호 표시", "check", "show_numbers");
    // 교독문 인도자/회중 스타일 (전체·본문 = 인도자·회중이 함께 있을 때)
    if (el.type === "reading" && (fkey === "all" || fkey === "body")) {
      body.appendChild(elx("div", "section-title", "역할 스타일"));
      field("역할 표시(인도자/회중)", "check", "show_tags");
      field("인도자 색", "color", "leader_color", { def: "#7aa2f7" });
      field("회중 색", "color", "congregation_color", { def: "#e0af68" });
    }
    body.appendChild(elx("div", "section-title", "내용 (params)"));
    // 찬송가: 번호를 몰라도 제목·가사로 검색해 선택(→ 번호 채우고 본문 가져오기)
    if (el.type === "hymn") {
      const search = hymnSearchField("찬송가 제목·가사로 검색", (num) => {
        el.params = { ...(el.params || {}), number: num };
        fetchContentElement(state.editEl);   // 본문 가져오기 + 재렌더(번호 입력 갱신)
      });
      body.appendChild(search);
    }
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
    effectFields();   // 성경/찬송/교독문도 그림자·외곽선(영상 위 가독성)
  }

  // 투명도 — 모든 요소 공통(0=완전 투명, 1=불투명). 영상·이미지·도형·텍스트 모두 적용.
  numRow("투명도 (0~1)", "opacity", { min: 0, max: 1, step: 0.05, def: 1 });

  const actions = elx("div", "el-actions");
  const front = elx("button", "mini", "맨 앞으로"); front.onclick = () => moveElZ(state.editEl, true);
  const back = elx("button", "mini", "맨 뒤로"); back.onclick = () => moveElZ(state.editEl, false);
  const del = elx("button", "mini danger", "삭제"); del.onclick = () => deleteSelectedEls();
  actions.append(front, back, del);
  body.appendChild(actions);
  restoreScroll();   // 편집 후 재렌더에도 스크롤 위치 유지
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
    delete el.html; delete el.text;   // 다시 가져오면 인라인 편집 오버라이드를 버리고 구조 렌더로 복귀
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
  // 자가복구: 템플릿이 0개면 아무것도 추가할 수 없으므로 기본 종류를 다시 시드한다.
  if (!state.templates?.length) {
    await callTool("reset_templates").catch(() => {});
    state.templates = await callTool("list_templates").catch(() => []);
  }
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
  state.editElSet = new Set();
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
    const tile = elx("div", "tile" + (sel ? " sel" : "") + (s.id === state.selected ? " primary" : "") + (s.hidden ? " hidden" : ""));
    tile.draggable = true;
    tile.dataset.id = s.id;
    const cap = elx("div", "cap");
    cap.innerHTML = `<span class="num">${i + 1}</span><span class="badge">${slideKind(s)}</span><span class="label">${slideLabel(s)}</span><button class="hide${s.hidden ? " on" : ""}" title="${s.hidden ? "발표에 다시 보이기" : "발표에서 숨기기"}">${s.hidden ? "⊘" : "◉"}</button><button class="del danger">✕</button>`;
    cap.querySelector(".hide").onclick = (e) => { e.stopPropagation(); toggleHidden(s.id); };
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
  number: "번호", verse_nos: "절 (예: 1,3)", lines_per_slide: "슬라이드당 줄 수",
  segments_per_slide: "슬라이드당 문장 수", sections: "가사 (한 줄씩)", items: "광고 항목 (한 줄씩)",
};
// 필드 아래 안내 문구 (페이지당 개수 조절이 무엇인지 명확히)
const PARAM_HINTS = {
  segments_per_slide: "한 슬라이드에 담을 인도자/회중 문장 수. 숫자를 키우면 슬라이드가 줄고, 줄이면 많아져요.",
  lines_per_slide: "한 슬라이드에 담을 가사 줄 수. 숫자를 키우면 슬라이드가 줄어요.",
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
  // 찬송가 템플릿: 번호를 몰라도 제목·가사로 검색해 번호 자동 입력
  const isHymn = tpl?.id === "builtin-hymn";
  for (const [key, def] of Object.entries(props)) {
    if (isHymn && key === "number") {
      const search = hymnSearchField("찬송가 제목·가사로 검색 (번호 몰라도 OK)", (num) => {
        const numInput = wrap.querySelector('[data-key="number"]');
        if (numInput) numInput.value = num;
      });
      wrap.appendChild(search);
    }
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
    if (PARAM_HINTS[key]) wrap.appendChild(elx("p", "hint muted", PARAM_HINTS[key]));
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

// where: "end"(순서 끝) | "after"(선택 슬라이드 바로 다음)
async function addSlide(where = "end") {
  const templateId = $("add-type").value;
  if (!state.serviceId) return msg("add-msg", "예배 순서가 없습니다.", true);
  const tpl = state.templates.find((t) => t.id === templateId);
  if (!tpl) return msg("add-msg", "추가할 종류/템플릿을 선택하세요.", true);
  let position; // undefined → 끝에 추가
  if (where === "after") {
    const idx = slides().findIndex((s) => s.id === state.selected);
    if (idx >= 0) position = idx + 1;
  }
  try {
    const res = await callTool("apply_template", { template_id: templateId, service_id: state.serviceId, params: collectParams(tpl), position });
    msg("add-msg", `“${tpl.name}” 추가됨`);
    await refresh();
    if (res?.slide_ids?.[0]) { setSingleSelection(res.slide_ids[0]); render(); }
  } catch (e) { msg("add-msg", e.message, true); }
}

// ----- 슬라이드 복사 / 붙여넣기 (리스트·타일 멀티셀렉) -----
// 마지막 복사 종류("slide" | "element") — 붙여넣기가 이걸로 라우팅(슬라이드 이동 후에도 유지)
let lastCopyKind = null;
let slideClipboard = [];
function copySelectedSlides() {
  const sel = slides().filter((s) => state.selectedSet.has(s.id));
  if (!sel.length) return;
  slideClipboard = sel.map((s) => ({
    elements: structuredClone(s.elements || []),
    background: s.background ? structuredClone(s.background) : null,
    transition: s.transition || "fade",
  }));
  lastCopyKind = "slide";
  toast(`${sel.length}개 슬라이드 복사됨 · ⌘/Ctrl+V로 붙여넣기`);
}
async function pasteSlides() {
  if (!slideClipboard.length || !state.serviceId) return;
  // 붙여넣기 위치: 선택한 슬라이드 중 마지막 다음(없으면 순서 끝).
  const idxs = slides().map((s, i) => (state.selectedSet.has(s.id) ? i : -1)).filter((i) => i >= 0);
  let pos = idxs.length ? Math.max(...idxs) + 1 : undefined;
  const newIds = [];
  for (const c of slideClipboard) {
    const res = await callTool("add_slide", { service_id: state.serviceId, elements: c.elements, background: c.background, transition: c.transition, position: pos });
    newIds.push(res.slide_id);
    if (pos != null) pos += 1;
  }
  await refresh();
  state.selectedSet = new Set(newIds);
  state.selected = newIds[newIds.length - 1];
  state.anchor = state.selected;
  render();
  toast(`${newIds.length}개 붙여넣음`);
}

// ----- 요소 복사 / 붙여넣기 (디자인 탭에서 요소 선택 후) -----
let elementClipboard = [];
function copyElement() {
  const sel = [...state.editElSet].map((i) => els()[i]).filter(Boolean);
  if (!sel.length) return;
  elementClipboard = sel.map((el) => structuredClone(el));
  lastCopyKind = "element";
  toast(`요소 ${sel.length}개 복사됨 · ⌘/Ctrl+V로 붙여넣기`);
}
async function pasteElement() {
  if (!elementClipboard.length) return;
  const slide = selectedSlide();
  if (!slide) return;
  const base = (slide.elements || []).length;
  const copies = elementClipboard.map((el) => {
    const c = structuredClone(el);
    c.x = clamp01((c.x ?? 0.4) + 0.03);   // 살짝 옮겨 겹치지 않게
    c.y = clamp01((c.y ?? 0.4) + 0.03);
    return c;
  });
  slide.elements = [...(slide.elements || []), ...copies];
  await commitEls();
  selectEls(copies.map((_, k) => base + k));
  toast(`요소 ${copies.length}개 붙여넣음`);
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
  // 라이브 미리보기(저장 X) — 드래그 중 즉시 반영
  const preview = () => { const s = selectedSlide(); if (s) { s.background = buildBackground(); renderPreview(); } };
  for (const [key, label, kind] of BG_FIELDS[type] || []) {
    const l = document.createElement("label"); l.textContent = label; wrap.appendChild(l);
    let input;
    if (kind.startsWith("check")) { input = document.createElement("input"); input.type = "checkbox"; input.checked = bg ? bg[key] !== false : kind.endsWith("1"); }
    else if (kind.startsWith("color")) { input = document.createElement("input"); input.type = "color"; input.value = bg?.[key] || kind.split(":")[1]; }
    else { input = document.createElement("input"); input.type = kind.startsWith("number") ? "number" : "text"; input.value = bg?.[key] ?? (kind.includes(":") ? kind.split(":")[1] : ""); }
    input.id = "bg-" + key;
    if (input.type !== "text") input.addEventListener("input", preview);   // 색/숫자/체크: 라이브 미리보기
    input.addEventListener("change", () => saveInspector());               // 확정 시 즉시 저장·적용
    wrap.appendChild(input);
    // 색 입력엔 팔레트 스와치(이 예배 색 + 최근 색)
    if (kind.startsWith("color")) {
      const sw = colorSwatches(bg?.[key], (hex) => { input.value = hex; preview(); saveInspector(); });
      if (sw) wrap.appendChild(sw);
    }
  }
  if (type === "image" || type === "video") {
    const file = document.createElement("input");
    file.type = "file"; file.accept = type === "video" ? "video/*" : "image/*";
    file.onchange = async () => {
      if (!file.files[0]) return;
      msg("insp-msg", "업로드 중…");
      try { const { url } = await uploadFile(file.files[0]); $("bg-url").value = url; msg("insp-msg", "업로드 완료"); await saveInspector(); }
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
    if (bg?.type === "color") pushRecentColor(bg.value);
    else if (bg?.type === "gradient") { pushRecentColor(bg.from); pushRecentColor(bg.to); }
    if (state.editingTemplate) {
      slide.background = bg;
      renderPreview();
    } else {
      await callTool("set_slide_background", { slide_id: slide.id, background: bg });
      await refresh();
    }
    msg("insp-msg", "배경 적용됨");
  } catch (e) { msg("insp-msg", e.message, true); }
}

// ---------- mutations ----------
async function removeSlide(id) {
  await callTool("remove_slide", { slide_id: id });
  state.selectedSet.delete(id);
  if (state.selected === id) state.selected = null;
  await refresh();
}
// 발표에서 숨김/보임 토글(편집기엔 남음). 멀티셀렉이면 선택 전체에 적용.
async function toggleHidden(id) {
  const targetIds = state.selectedSet.has(id) && state.selectedSet.size > 1 ? [...state.selectedSet] : [id];
  const cur = slides().find((s) => s.id === id);
  const next = !cur?.hidden;
  for (const sid of targetIds) await callTool("set_slide_hidden", { slide_id: sid, hidden: next });
  await refresh();
  toast(next ? `${targetIds.length}개 숨김(발표에서 건너뜀)` : `${targetIds.length}개 다시 보임`);
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

// 현재 예배 정보(이름·날짜·부) 수정 — 새로 만들지 않고 기존 것을 고친다.
async function editService() {
  const s = state.service;
  if (!s) return;
  const title = prompt("예배 제목", s.title); if (title == null) return;
  const date = prompt("날짜 (YYYY-MM-DD)", s.date); if (date == null) return;
  const worship_part = prompt("예배부 (1부/2부/연합 등)", s.worship_part); if (worship_part == null) return;
  await callTool("update_service", { service_id: state.serviceId, fields: { title, date, worship_part } });
  await loadServices(state.serviceId);
  toast("예배 정보 수정됨");
}

// 현재 예배 순서 삭제(슬라이드 전부 함께). 되돌릴 수 없어 확인 후 진행.
async function deleteService() {
  const s = state.service;
  if (!s) return;
  if (!confirm(`예배 순서 "${s.title}" 을(를) 삭제할까요?\n안의 슬라이드가 모두 함께 삭제되며 되돌릴 수 없습니다.`)) return;
  await callTool("delete_service", { service_id: state.serviceId });
  state.serviceId = null;
  state.service = null;
  await loadServices();   // 남은 예배 선택(없으면 빈 화면)
  toast("예배 순서 삭제됨");
}

// 다른 이름으로 저장 — 현재 예배 전체(슬라이드·테마 포함)를 복제해 새 예배로.
async function duplicateService() {
  const s = state.service;
  if (!s) return;
  const title = prompt("다른 이름으로 저장 — 새 제목", `${s.title} (사본)`);
  if (title == null) return;
  const { service_id } = await callTool("duplicate_service", { service_id: state.serviceId, title: title || undefined });
  await loadServices(service_id);
  toast("다른 이름으로 저장됨");
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
  // 파일을 멀티파트로 그대로 전송(큰 파일도 클라이언트에서 파싱/재직렬화하지 않음).
  const mb = (file.size / 1048576).toFixed(0);
  showBusy("예배 순서 가져오는 중…", `${file.name} · ${mb}MB`);
  try {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/import-service", { method: "POST", body: fd });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "가져오기 실패");
    await loadServices(body.service_id);
    hideBusy();
    msg("add-msg", "가져오기 완료");
  } catch (e) { hideBusy(); alert("가져오기 실패: " + e.message); }
}

// ---- busy overlay: spinner + message + live elapsed time ----
let busyTimer = null;
function showBusy(message, sub = "") {
  $("busy-msg").textContent = message;
  const base = sub;
  const t0 = performance.now();
  const tick = () => { $("busy-sub").textContent = `${base}${base ? " · " : ""}${((performance.now() - t0) / 1000).toFixed(1)}초 경과`; };
  tick();
  clearInterval(busyTimer); busyTimer = setInterval(tick, 200);
  $("busy").hidden = false;
}
function hideBusy() { clearInterval(busyTimer); busyTimer = null; $("busy").hidden = true; }

// PPT/PDF/이미지 → 이미지 슬라이드로 현재 예배에 추가
async function importSlidesFile(file) {
  if (!state.serviceId) return;
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const isOffice = ["pptx", "ppt", "odp", "key"].includes(ext);
  const label = isOffice ? "PowerPoint 변환 중…" : ext === "pdf" ? "PDF 변환 중…" : "이미지 가져오는 중…";
  const sub = isOffice ? `${file.name} · LibreOffice로 변환(첫 실행은 몇 초 걸려요)` : file.name;
  showBusy(label, sub);
  try {
    const fd = new FormData();
    fd.append("file", file);
    // 현재 선택한 슬라이드 바로 아래로 가져오기(선택 없으면 맨 끝).
    const idx = slides().findIndex((s) => s.id === state.selected);
    const posQ = idx >= 0 ? `&position=${idx + 1}` : "";
    const res = await fetch(`/api/import?service_id=${state.serviceId}${posQ}`, { method: "POST", body: fd });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "가져오기 실패");
    await refresh();
    // 여러 파일을 이어서 가져올 때 순서가 유지되도록 마지막 가져온 슬라이드를 선택
    if (body.slide_ids?.length) { setSingleSelection(body.slide_ids[body.slide_ids.length - 1]); render(); }
    clearInterval(busyTimer); busyTimer = null;
    $("busy-msg").textContent = `${body.slide_ids.length}장 가져왔어요 ✓`;
    $("busy-sub").textContent = "";
    $("busy").querySelector(".spinner").style.display = "none";
    setTimeout(() => { $("busy").querySelector(".spinner").style.display = ""; hideBusy(); }, 900);
  } catch (e) {
    hideBusy();
    alert("슬라이드 가져오기 실패: " + e.message);
  }
}

// ---- 성구(성경 참조 → 본문 슬라이드) 모달 ----
let bibleRefTimer = null;
let bibleRefParsed = [];   // 마지막 미리보기에서 파싱된 참조

function openBibleRef() {
  if (!state.serviceId) { toast("예배 순서를 먼저 선택하세요"); return; }
  $("bibleref-modal").hidden = false;
  $("bibleref-msg").textContent = "";
  $("bibleref-status").textContent = "";
  previewBibleRefs();
  $("bibleref-input").focus();
}
function closeBibleRef() { $("bibleref-modal").hidden = true; }

// 입력 텍스트를 파싱해 참조 칩으로 미리보기(파싱만 — 빠름, DB 조회 없음).
async function previewBibleRefs() {
  const text = $("bibleref-input").value.trim();
  const box = $("bibleref-preview");
  if (!text) { bibleRefParsed = []; box.className = "bibleref-preview muted"; box.textContent = "해석된 참조가 여기에 표시됩니다."; return; }
  try {
    const { refs } = await callTool("parse_bible_refs", { text });
    bibleRefParsed = refs || [];
    box.className = "bibleref-preview";
    box.replaceChildren();
    if (!bibleRefParsed.length) { box.className = "bibleref-preview muted"; box.textContent = "해석된 참조가 없습니다. 예: 요 3:16-18, 롬 8:1"; return; }
    for (const r of bibleRefParsed) {
      const chip = elx("span", "bibleref-chip", r.ref);
      box.appendChild(chip);
    }
  } catch (e) { box.className = "bibleref-preview muted"; box.textContent = e.message; }
}

// 주보 PDF 업로드 → 빨강 성구 추출 → 입력창 채우고 미리보기.
async function extractBibleRefsFromPdf(file) {
  $("bibleref-status").textContent = "PDF에서 성구 추출 중…";
  try {
    const fd = new FormData(); fd.append("file", file);
    const res = await fetch("/api/bible-refs/extract", { method: "POST", body: fd });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "추출 실패");
    $("bibleref-input").value = (body.refs || []).map((r) => r.ref).join(", ");
    await previewBibleRefs();
    const n = (body.refs || []).length;
    $("bibleref-status").textContent = n ? `${file.name} · 성구 ${n}개 추출됨 (검토 후 추가)` : `${file.name} · 빨강 성구를 찾지 못했어요`;
  } catch (e) { $("bibleref-status").textContent = "추출 실패: " + e.message; }
}

// 파싱된 참조 → 성경 본문 슬라이드 추가(선택한 순서 아래에).
async function addBibleRefSlides() {
  const text = $("bibleref-input").value.trim();
  if (!text) { $("bibleref-msg").textContent = "성경 참조를 입력하세요."; return; }
  const layout = $("bibleref-layout").value;
  const idx = slides().findIndex((s) => s.id === state.selected);
  const position = idx >= 0 ? idx + 1 : undefined;
  $("bibleref-add").disabled = true;
  $("bibleref-msg").className = "msg";
  $("bibleref-msg").textContent = "본문 조회·추가 중…";
  try {
    const res = await callTool("add_bible_ref_slides", { service_id: state.serviceId, text, layout, position });
    await refresh();
    if (res.slide_ids?.length) { setSingleSelection(res.slide_ids[res.slide_ids.length - 1]); render(); }
    const bad = res.unresolved || [];
    if (bad.length) {
      $("bibleref-msg").className = "msg err";
      $("bibleref-msg").textContent = `${res.slide_ids.length}장 추가 · 실패: ${bad.map((b) => b.ref).join(", ")}`;
    } else {
      toast(`성경 본문 ${res.slide_ids.length}장 추가됨`);
      closeBibleRef();
    }
  } catch (e) {
    $("bibleref-msg").className = "msg err";
    $("bibleref-msg").textContent = e.message;
  } finally {
    $("bibleref-add").disabled = false;
  }
}

// ---- PPT 라이브러리 검색 모달 ----
let libSearchTimer = null;
async function openLibrary() {
  $("library-modal").hidden = false;
  try {
    const { library_dir, indexed } = await callTool("get_library_dir");
    $("lib-dir").value = library_dir || "";
    $("lib-status").textContent = library_dir ? `색인 ${indexed}개` : "폴더를 지정하세요";
    if (library_dir && indexed === 0) await reindexLibrary();
    resetPrerenderUi(library_dir || "");
    renderLibResults([]);
    $("lib-query").focus();
  } catch (e) { $("lib-status").textContent = e.message; }
}
function closeLibrary() { prerenderCancel = true; $("library-modal").hidden = true; }

// ---- 폴더 미리 변환 (특정 폴더의 PPT를 미리 이미지로 변환해두기) ----
let prerenderUncached = [];   // 확인(scan)으로 찾은 미변환 파일 경로
let prerenderCancel = false;  // 진행 중 중지 플래그

function resetPrerenderUi(dir) {
  $("lib-pre-dir").value = dir || "";
  prerenderUncached = [];
  $("lib-pre-run").disabled = true;
  $("lib-pre-run").textContent = "⚡ 이 폴더 미리 변환";
  $("lib-pre-status").textContent = "";
  $("lib-pre-bar").hidden = true;
  $("lib-pre-cancel").hidden = true;
}

// 폴더 안의 변환 대상·미변환 수를 확인.
async function scanPrerenderDir() {
  const dir = $("lib-pre-dir").value.trim() || undefined;
  $("lib-pre-status").textContent = "확인 중…";
  try {
    const { files, total, cached } = await callTool("list_library_files", { dir });
    prerenderUncached = files.filter((f) => !f.cached).map((f) => f.path);
    const un = prerenderUncached.length;
    $("lib-pre-status").textContent = `PPT/PDF ${total}개 · 변환됨 ${cached} · 미변환 ${un}`;
    $("lib-pre-run").disabled = un === 0;
    $("lib-pre-run").textContent = un ? `⚡ 미변환 ${un}개 변환` : "⚡ 모두 변환됨";
  } catch (e) { $("lib-pre-status").textContent = e.message; }
}

// 미변환 파일들을 배치로 미리 변환하며 진행률 표시(중지 가능).
async function runPrerenderDir() {
  if (!prerenderUncached.length) return;
  const total = prerenderUncached.length;
  prerenderCancel = false;
  $("lib-pre-run").hidden = true;
  $("lib-pre-cancel").hidden = false;
  $("lib-pre-cancel").textContent = "중지";
  $("lib-pre-bar").hidden = false;
  const BATCH = 4;
  let done = 0, failed = 0;
  for (let i = 0; i < total && !prerenderCancel; i += BATCH) {
    const batch = prerenderUncached.slice(i, i + BATCH);
    try {
      const r = await callTool("prerender_library", { paths: batch });
      failed += (r.failed || []).length;
    } catch { failed += batch.length; }
    done = Math.min(i + BATCH, total);
    $("lib-pre-fill").style.width = Math.round((done / total) * 100) + "%";
    $("lib-pre-status").textContent = `변환 중… ${done}/${total}${failed ? ` (실패 ${failed})` : ""}`;
  }
  $("lib-pre-run").hidden = false;
  $("lib-pre-cancel").hidden = true;
  const stopped = prerenderCancel;
  $("lib-pre-status").textContent = stopped ? `중지됨 · ${done}/${total} 변환` : `완료 · ${done - failed}/${total} 변환${failed ? ` (실패 ${failed})` : ""}`;
  await scanPrerenderDir();       // 남은 미변환 수 갱신
  if ($("lib-query").value.trim()) await searchLibrary();  // 검색 결과 ⚡ 배지 갱신
}
function cancelPrerenderDir() { prerenderCancel = true; $("lib-pre-cancel").textContent = "중지 중…"; }

async function saveLibraryDir() {
  const path = $("lib-dir").value.trim();
  if (!path) return;
  try {
    await callTool("set_library_dir", { path });
    $("lib-status").textContent = "폴더 저장됨 · 색인 중…";
    await reindexLibrary();
  } catch (e) { $("lib-status").textContent = e.message; }
}

// 증분 색인(변경분만). 새 폴더면 전부 신규로 추출됨.
async function reindexLibrary() {
  showBusy("라이브러리 색인 중…", "새/변경된 PPT의 내용을 읽는 중이에요 (처음은 오래 걸릴 수 있어요)");
  try {
    const r = await callTool("index_library", {});
    $("lib-status").textContent = `색인 ${r.files}개 (신규 ${r.added}, 갱신 ${r.updated})`;
  } catch (e) { $("lib-status").textContent = e.message; }
  finally { hideBusy(); }
}

let libResults = [];   // 마지막 검색 결과(미리 변환 대상)

async function searchLibrary() {
  const q = $("lib-query").value.trim();
  if (!q) { libResults = []; renderLibResults([]); return; }
  try {
    const { results } = await callTool("search_library", { query: q });
    libResults = results;
    renderLibResults(results);
  } catch (e) { $("lib-results").innerHTML = `<div class="lib-empty">${e.message}</div>`; }
}

const RENDERABLE_EXT = new Set([".pptx", ".ppt", ".odp", ".pdf"]);

function renderLibResults(results) {
  const root = $("lib-results");
  root.replaceChildren();
  // 미리 변환 버튼: 렌더 대상 중 아직 캐시 안 된 게 있으면 활성화
  const prBtn = $("lib-prerender");
  const pending = results.filter((r) => RENDERABLE_EXT.has(r.ext) && !r.cached).length;
  if (prBtn) { prBtn.disabled = pending === 0; prBtn.textContent = pending ? `⚡ 미리 변환 (${pending})` : "⚡ 모두 변환됨"; }
  if (!results.length) { root.innerHTML = '<div class="lib-empty">검색어를 입력하세요. 제목과 슬라이드 내용에서 찾습니다.</div>'; return; }
  for (const r of results) {
    const row = elx("div", "lib-row");
    const info = elx("div", "info");
    const fname = elx("div", "fname", r.name);
    // 미리 변환돼 있으면 ⚡ 배지(가져오기 즉시)
    if (RENDERABLE_EXT.has(r.ext) && r.cached) fname.append(elx("span", "cached-badge", "⚡ 빠름"));
    info.append(fname);
    info.append(elx("div", "fmeta", `${r.relpath}${r.pages ? " · " + r.pages + "장" : ""}`));
    if (r.snippet) info.append(elx("div", "snip", r.snippet));
    const tag = elx("span", "mtag" + (r.matched_in === "content" ? " content" : ""), r.matched_in === "content" ? "내용" : "제목");
    const imp = elx("button", "mini accent", "가져오기");
    imp.onclick = () => importFromLibrary(r);
    row.append(info, tag, imp);
    root.appendChild(row);
  }
}

// 현재 검색 결과의 PPT/PDF를 미리 이미지로 변환(캐시) → 이후 가져오기가 즉시.
async function prerenderLibResults() {
  const paths = libResults.filter((r) => RENDERABLE_EXT.has(r.ext) && !r.cached).map((r) => r.path);
  if (!paths.length) return;
  const btn = $("lib-prerender");
  btn.disabled = true; btn.textContent = `⚡ 변환 중… (0/${paths.length})`;
  try {
    const res = await callTool("prerender_library", { paths });
    toast(`${res.rendered}개 미리 변환 완료 (${res.pages}장) — 이제 즉시 가져옵니다`);
    await searchLibrary();   // cached 플래그 갱신
  } catch (e) { toast("미리 변환 실패: " + e.message); btn.disabled = false; }
}

async function importFromLibrary(r) {
  if (!state.serviceId) return;
  const isOffice = [".pptx", ".ppt", ".odp"].includes(r.ext);
  showBusy(isOffice ? "PowerPoint 변환 중…" : "가져오는 중…", `${r.name}${isOffice ? " · LibreOffice로 변환" : ""}`);
  try {
    // 현재 선택한 슬라이드 바로 아래로 가져오기(선택 없으면 맨 끝) — 메뉴 임포트와 동일.
    const idx = slides().findIndex((s) => s.id === state.selected);
    const position = idx >= 0 ? idx + 1 : undefined;
    const { slide_ids } = await callTool("import_pdf", { service_id: state.serviceId, path: r.path, position });
    await refresh();
    // 이어서 가져올 때 순서가 유지되도록 마지막 가져온 슬라이드를 선택
    if (slide_ids?.length) { setSingleSelection(slide_ids[slide_ids.length - 1]); render(); }
    clearInterval(busyTimer); busyTimer = null;
    $("busy-msg").textContent = `${slide_ids.length}장 가져왔어요 ✓`;
    $("busy-sub").textContent = "";
    $("busy").querySelector(".spinner").style.display = "none";
    setTimeout(() => { $("busy").querySelector(".spinner").style.display = ""; hideBusy(); }, 900);
  } catch (e) { hideBusy(); alert("가져오기 실패: " + e.message); }
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

// ---- topbar dropdown menus / popovers ----
let openMenu = null;
function closeMenus() { if (openMenu) { openMenu.hidden = true; openMenu = null; } }
function wireMenu(btnId, panelId, { closeOnItem = false } = {}) {
  const btn = $(btnId), panel = $(panelId);
  btn.onclick = (e) => {
    e.stopPropagation();
    const willOpen = panel.hidden;
    closeMenus();
    if (willOpen) { panel.hidden = false; openMenu = panel; }
  };
  if (closeOnItem) panel.querySelectorAll(".menu-item").forEach((it) => it.addEventListener("click", closeMenus));
}
document.addEventListener("click", (e) => { if (openMenu && !openMenu.parentElement.contains(e.target)) closeMenus(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenus(); });

// self-host 웹폰트 목록을 불러와 설정의 기본 글꼴 select를 채운다.
async function loadFonts() {
  try { state.fonts = (await callTool("list_fonts")).fonts || []; } catch { state.fonts = []; }
  fillFontSelect($("font-select"), state.service?.theme_overrides?.font || "");
  if (state.service) syncThemeControls();
}

// 설정 팝오버: 같은 네트워크 다른 기기에서 접속할 주소 목록.
async function loadNetwork() {
  const box = $("net-addrs");
  if (!box) return;
  try {
    const { addresses } = await callTool("list_network_addresses");
    if (!addresses?.length) { box.textContent = "네트워크 주소를 찾지 못했습니다."; return; }
    const port = location.port || "4321";
    box.replaceChildren();
    for (const ip of addresses) {
      const url = `http://${ip}:${port}`;
      const a = document.createElement("a");
      a.href = url; a.target = "_blank"; a.rel = "noopener"; a.textContent = url;
      box.appendChild(a);
    }
  } catch { box.textContent = "주소 확인 실패"; }
}

function init() {
  initThemeSelect();
  initTabs();
  wireMenu("menu-import-btn", "menu-import", { closeOnItem: true });
  wireMenu("menu-settings-btn", "menu-settings");
  renderAddFields();
  $("service-select").onchange = (e) => selectService(e.target.value);
  $("new-service").onclick = newService;
  $("edit-service").onclick = editService;
  $("dup-service").onclick = duplicateService;
  $("del-service").onclick = deleteService;
  $("view-list").onclick = () => { state.mode = "list"; render(); };
  $("view-tiles").onclick = () => { state.mode = "tiles"; render(); };
  $("add-type").onchange = renderAddFields;
  $("add-slide-btn").onclick = () => addSlide("end");
  $("add-after-btn").onclick = () => addSlide("after");

  // 드래그드롭: 이미지/PDF/PPT 파일을 현재 예배에 슬라이드로 가져오기
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  window.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $("drop-overlay").hidden = false; });
  window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("drop-overlay").hidden = true; });
  window.addEventListener("drop", async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; $("drop-overlay").hidden = true;
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    if (!state.serviceId) { toast("먼저 예배를 선택하거나 만들어 주세요"); return; }
    const IMG_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);
    const VIDEO_EXT = new Set(["mp4", "webm", "mov", "m4v", "ogv", "ogg"]);
    for (const f of files) {
      const ext = (f.name.split(".").pop() || "").toLowerCase();
      if (IMG_EXT.has(ext)) {
        // 이미지: 새 슬라이드가 아니라 현재 슬라이드에 이미지 요소로 첨부
        if (!selectedSlide()) { toast("이미지를 붙일 슬라이드를 먼저 선택하세요"); continue; }
        try { const { url } = await uploadFile(f); await addElement("image", { url }); toast("이미지 첨부됨"); }
        catch (err) { toast("이미지 첨부 실패: " + err.message); }
      } else if (VIDEO_EXT.has(ext)) {
        // 영상: 현재 슬라이드에 영상 요소로 첨부(소리는 발표 화면에서 재생)
        if (!selectedSlide()) { toast("영상을 붙일 슬라이드를 먼저 선택하세요"); continue; }
        try { const { url } = await uploadFile(f); await addElement("video", { url }); toast("영상 첨부됨(발표 화면에서 소리 재생)"); }
        catch (err) { toast("영상 첨부 실패: " + err.message); }
      } else {
        await importSlidesFile(f);   // PDF/PPT → 슬라이드로 가져오기(선택 아래)
      }
    }
  });

  // 복사/붙여넣기 (⌘/Ctrl+C·V):
  //  - 요소가 선택돼 있으면 요소를, 아니면 슬라이드(리스트·타일 멀티셀렉)를 대상으로.
  document.addEventListener("keydown", (e) => {
    if (isTypingTarget()) return;   // 입력·인라인 편집 중엔 전역 단축키 무시
    // 요소 선택이 없을 때 Del/Backspace → 선택한 순서 삭제(멀티셀렉 한 번에).
    // (요소가 선택된 경우는 요소 삭제 핸들러가 처리)
    if (state.editEl == null && (e.key === "Delete" || e.key === "Backspace")) {
      if (state.selectedSet.size) { e.preventDefault(); deleteSelected(); }
      return;
    }
    if (!(e.metaKey || e.ctrlKey)) return;
    const k = e.key.toLowerCase();
    // 실행취소/다시실행
    if (k === "z") { e.preventDefault(); (e.shiftKey ? redo() : undo()); return; }
    if (k === "y") { e.preventDefault(); redo(); return; }   // Windows 다시실행
    if (k !== "c" && k !== "v") return;
    e.preventDefault();
    if (k === "c") {
      // 복사: 요소가 선택돼 있으면 요소, 아니면 슬라이드
      if (state.editEl != null) copyElement(); else copySelectedSlides();
    } else {
      // 붙여넣기: 마지막에 복사한 종류로(다른 슬라이드로 이동해도 요소 붙여넣기 가능)
      if (lastCopyKind === "element") pasteElement(); else pasteSlides();
    }
  });
  $("undo-btn").onclick = undo;
  $("redo-btn").onclick = redo;
  $("prev-slide").onclick = () => navSlide(-1);
  $("next-slide").onclick = () => navSlide(1);
  $("del-slide").onclick = deleteSelected;
  $("present-here").onclick = presentHere;
  $("insp-bg-type").onchange = () => {
    renderBgFields(selectedSlide()?.background);
    const t = $("insp-bg-type").value;
    if (t === "theme" || t === "color" || t === "gradient") saveInspector();  // 즉시 적용(이미지/영상은 URL 지정 후)
  };
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
    if (isTypingTarget()) return;   // 입력·인라인 편집 중엔 Del/방향키가 요소를 지우거나 옮기지 않게
    const group = [...state.editElSet].map((gi) => els()[gi]).filter(Boolean);
    if (!group.length) return;
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelectedEls(); }
    else if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      const d = 0.005;
      for (const el of group) {   // 선택된 요소들을 함께 nudge
        if (e.key === "ArrowLeft") el.x = clamp01((el.x ?? 0.4) - d);
        if (e.key === "ArrowRight") el.x = clamp01((el.x ?? 0.4) + d);
        if (e.key === "ArrowUp") el.y = clamp01((el.y ?? 0.4) - d);
        if (e.key === "ArrowDown") el.y = clamp01((el.y ?? 0.4) + d);
      }
      repaintEls();
      clearTimeout(window.__nudgeT);
      window.__nudgeT = setTimeout(commitEls, 300);
    }
  });

  $("export-btn").onclick = exportService;
  $("import-btn").onclick = () => $("import-file").click();
  $("import-file").onchange = (e) => e.target.files[0] && importService(e.target.files[0]);
  $("import-ppt").onclick = () => $("import-ppt-file").click();
  $("import-ppt-file").onchange = (e) => { const f = e.target.files[0]; if (f) importSlidesFile(f); e.target.value = ""; };
  // 라이브러리 모달
  $("library-btn").onclick = openLibrary;
  $("library-close").onclick = closeLibrary;
  $("lib-save").onclick = saveLibraryDir;
  $("lib-reindex").onclick = () => reindexLibrary();
  $("lib-query").addEventListener("input", () => { clearTimeout(libSearchTimer); libSearchTimer = setTimeout(searchLibrary, 250); });
  $("lib-prerender").onclick = prerenderLibResults;
  $("lib-pre-scan").onclick = scanPrerenderDir;
  $("lib-pre-run").onclick = runPrerenderDir;
  $("lib-pre-cancel").onclick = cancelPrerenderDir;
  $("lib-pre-dir").addEventListener("keydown", (e) => { if (e.key === "Enter") scanPrerenderDir(); });
  $("library-modal").addEventListener("mousedown", (e) => { if (e.target === $("library-modal")) closeLibrary(); });
  // 성구 모달
  $("bibleref-btn").onclick = openBibleRef;
  $("bibleref-close").onclick = closeBibleRef;
  $("bibleref-input").addEventListener("input", () => { clearTimeout(bibleRefTimer); bibleRefTimer = setTimeout(previewBibleRefs, 200); });
  $("bibleref-pdf-btn").onclick = () => $("bibleref-pdf-file").click();
  $("bibleref-pdf-file").onchange = (e) => { const f = e.target.files[0]; if (f) extractBibleRefsFromPdf(f); e.target.value = ""; };
  $("bibleref-add").onclick = addBibleRefSlides;
  $("bibleref-modal").addEventListener("mousedown", (e) => { if (e.target === $("bibleref-modal")) closeBibleRef(); });
  $("tpl-save").onclick = saveCurrentAsTemplate;
  $("tpl-edit-save").onclick = saveTemplateEdit;
  $("tpl-edit-cancel").onclick = cancelTemplateEdit;
  loadServices();
  loadTemplates();
  loadFonts();
  loadNetwork();
}

init();
