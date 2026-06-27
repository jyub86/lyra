// 편집 UI 컨트롤러. 예배(순서) > 슬라이드 평면 구조. 모든 동작은 Tool 호출.
import { callTool, loadTheme, uploadFile, BUILTIN_THEMES } from "/shared/api.js";
import { renderSlideWithLayers } from "/shared/layer-renderer.js";

const $ = (id) => document.getElementById(id);

const state = {
  services: [],
  serviceId: null,
  service: null,   // get_service (flat slides[])
  theme: null,
  selected: null,  // slide id
  mode: "list",    // "list" | "tiles"
};

const slides = () => state.service?.slides || [];
function slideLabel(s) {
  const d = s.data || {};
  return d.title || d.ref || d.label || (d.segments && d.segments[0]?.text) ||
    (d.lines && d.lines[0]) || (d.items && d.items[0]) || s.template_type;
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

// Shared HTML5 drag-to-reorder for any element carrying dataset.id (rows & tiles).
let dragId = null;
function wireDrag(el) {
  el.addEventListener("dragstart", (e) => { dragId = el.dataset.id; e.dataTransfer.effectAllowed = "move"; });
  el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("drag-over"); });
  el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
  el.addEventListener("drop", async (e) => {
    e.preventDefault();
    el.classList.remove("drag-over");
    const targetId = el.dataset.id;
    if (!dragId || dragId === targetId) return;
    const ids = slides().map((x) => x.id);
    ids.splice(ids.indexOf(dragId), 1);
    ids.splice(ids.indexOf(targetId), 0, dragId); // drop before target
    await callTool("reorder_slides", { service_id: state.serviceId, ordered_slide_ids: ids });
    dragId = null;
    await refresh();
  });
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
  state.selected = slides()[0]?.id || null;
  render();
}

async function refresh() {
  const keep = state.selected;
  state.service = await callTool("get_service", { service_id: state.serviceId });
  if (!slides().some((s) => s.id === keep)) state.selected = slides()[0]?.id || null;
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
  if (state.mode === "tiles") renderTiles();
  else { renderList(); renderPreview(); renderInspector(); }
}

function selectedSlide() {
  return slides().find((s) => s.id === state.selected) || null;
}

function renderList() {
  const root = $("slide-list");
  root.innerHTML = "";
  if (!state.service) { root.innerHTML = '<p class="muted" style="padding:12px">예배 순서가 없습니다. “+ 새 예배”로 시작하세요.</p>'; return; }
  slides().forEach((s, i) => {
    const row = elx("div", "slide-row" + (s.id === state.selected ? " sel" : ""));
    row.draggable = true;
    row.dataset.id = s.id;
    const meta = elx("div", "row-meta");
    meta.append(elx("span", "badge", s.template_type), elx("span", "label", slideLabel(s)));
    const del = elx("button", "del danger", "✕");
    del.onclick = (e) => { e.stopPropagation(); removeSlide(s.id); };
    row.append(elx("span", "num", String(i + 1)), buildThumb(s), meta, del);
    row.onclick = () => { state.selected = s.id; render(); };
    wireDrag(row);
    root.appendChild(row);
  });
}

function renderPreview() {
  const slide = selectedSlide();
  const prev = $("preview");
  if (!slide) { prev.replaceChildren(); $("slide-pos").textContent = "—"; return; }
  renderSlideWithLayers(prev, slide, state.theme);
  const idx = slides().findIndex((s) => s.id === slide.id);
  $("slide-pos").textContent = `${idx + 1} / ${slides().length}`;
}

function navSlide(delta) {
  const idx = slides().findIndex((s) => s.id === state.selected);
  const next = slides()[idx + delta];
  if (next) { state.selected = next.id; render(); }
}

// ---------- tiles ----------
function renderTiles() {
  const grid = $("tile-grid");
  grid.innerHTML = "";
  slides().forEach((s, i) => {
    const tile = elx("div", "tile" + (s.id === state.selected ? " sel" : ""));
    tile.draggable = true;
    tile.dataset.id = s.id;
    const cap = elx("div", "cap");
    cap.innerHTML = `<span class="num">${i + 1}</span><span class="badge">${s.template_type}</span><span class="label">${slideLabel(s)}</span><button class="del danger">✕</button>`;
    cap.querySelector(".del").onclick = (e) => { e.stopPropagation(); removeSlide(s.id); };
    tile.append(buildThumb(s), cap);
    tile.onclick = () => { state.selected = s.id; state.mode = "list"; render(); };
    tile.ondblclick = () => presentIndex(i);
    wireDrag(tile);
    grid.appendChild(tile);
  });
}

// ---------- add slide ----------
const ADD_FIELDS = {
  title: [["title", "제목", "text"], ["subtitle", "부제", "text"]],
  section: [["label", "구분 제목", "text"]],
  bible: [["book", "책(이름/약칭)", "text"], ["chapter", "장", "number"], ["verse_start", "시작 절", "number"], ["verse_end", "끝 절", "number"], ["layout", "분할", "select:auto,one-per-verse,all-in-one"]],
  hymn: [["number", "찬송가 번호", "number"], ["verse_nos", "절(예: 1,3)", "text"], ["lines_per_slide", "줄/슬라이드", "number:4"]],
  responsive_reading: [["number", "교독문 번호", "number"]],
  praise: [["title", "곡 제목", "text"], ["lyrics", "가사(줄바꿈으로 구분)", "textarea"], ["lines_per_slide", "줄/슬라이드", "number:2"]],
  announcement: [["items", "광고 항목(줄바꿈)", "textarea"]],
  blank: [],
};

function renderAddFields() {
  const wrap = $("add-fields");
  wrap.innerHTML = "";
  for (const [key, label, kind] of ADD_FIELDS[$("add-type").value] || []) {
    const l = document.createElement("label"); l.textContent = label; wrap.appendChild(l);
    let input;
    if (kind === "textarea") { input = document.createElement("textarea"); input.rows = 5; }
    else if (kind.startsWith("select:")) {
      input = document.createElement("select");
      for (const opt of kind.slice(7).split(",")) { const o = document.createElement("option"); o.value = o.textContent = opt; input.appendChild(o); }
    } else {
      input = document.createElement("input");
      input.type = kind.startsWith("number") ? "number" : "text";
      if (kind.includes(":")) input.value = kind.split(":")[1];
    }
    input.id = "af-" + key;
    wrap.appendChild(input);
  }
}
const afVal = (k) => $("af-" + k)?.value?.trim() ?? "";

async function addSlide() {
  const type = $("add-type").value;
  const service_id = state.serviceId;
  if (!service_id) return msg("add-msg", "예배 순서가 없습니다.", true);
  try {
    if (type === "bible") {
      await callTool("add_bible_slides", { service_id, book: afVal("book"), chapter: +afVal("chapter"), verse_start: +afVal("verse_start"), verse_end: +afVal("verse_end"), layout: afVal("layout") });
    } else if (type === "hymn") {
      const vn = afVal("verse_nos");
      await callTool("add_hymn_slides", { service_id, number: +afVal("number"), verse_nos: vn ? vn.split(",").map((x) => +x.trim()).filter(Boolean) : undefined, lines_per_slide: +afVal("lines_per_slide") || 4 });
    } else if (type === "responsive_reading") {
      await callTool("add_reading_slides", { service_id, number: +afVal("number") });
    } else if (type === "praise") {
      const lines = afVal("lyrics").split("\n").map((s) => s.trim()).filter(Boolean);
      await callTool("add_praise_slides", { service_id, title: afVal("title"), sections: [{ label: "", lines }], lines_per_slide: +afVal("lines_per_slide") || 2 });
    } else if (type === "announcement") {
      const items = afVal("items").split("\n").map((s) => s.trim()).filter(Boolean);
      await callTool("add_announcement_slide", { service_id, items });
    } else {
      const data = type === "title" ? { title: afVal("title"), subtitle: afVal("subtitle") } : type === "section" ? { label: afVal("label") } : {};
      await callTool("add_slide", { service_id, template_type: type, data });
    }
    msg("add-msg", "추가됨");
    await refresh();
  } catch (e) { msg("add-msg", e.message, true); }
}

// ---------- inspector ----------
function renderInspector() {
  const slide = selectedSlide();
  const empty = $("inspect-empty"), body = $("inspect-body");
  if (!slide) { empty.hidden = false; body.hidden = true; return; }
  empty.hidden = true; body.hidden = false;
  $("insp-type").value = slide.template_type;
  $("insp-data").value = JSON.stringify(slide.data, null, 2);
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
    const data = JSON.parse($("insp-data").value);
    await callTool("update_slide", { slide_id: slide.id, fields: { data } });
    await callTool("set_slide_background", { slide_id: slide.id, background: buildBackground() });
    msg("insp-msg", "저장됨");
    await refresh();
  } catch (e) { msg("insp-msg", e.message, true); }
}

// ---------- mutations ----------
async function removeSlide(id) {
  await callTool("remove_slide", { slide_id: id });
  if (state.selected === id) state.selected = null;
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
function initTabs() {
  document.querySelectorAll(".tab").forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      $("tab-add").hidden = t.dataset.tab !== "add";
      $("tab-inspect").hidden = t.dataset.tab !== "inspect";
    };
  });
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
  $("del-slide").onclick = () => state.selected && removeSlide(state.selected);
  $("present-here").onclick = presentHere;
  $("insp-bg-type").onchange = () => renderBgFields(selectedSlide()?.background);
  $("insp-save").onclick = saveInspector;
  $("export-btn").onclick = exportService;
  $("import-btn").onclick = () => $("import-file").click();
  $("import-file").onchange = (e) => e.target.files[0] && importService(e.target.files[0]);
  loadServices();
}

init();
