// Layer compositor (design §5, §12). background → content → overlays.
// Shared by editor preview and presenter so they render identically.
import { renderSlide } from "./slide-renderer.js";

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
  set("--title-size", (f.title_size || 5.0) + "cqw");
  set("--body-size", (f.body_size || 3.2) + "cqw");
  set("--label-size", (f.label_size || 1.8) + "cqw");
  set("--line-height", f.line_height || 1.5);
  set("--weight", f.weight || 600);
}

// Renders a background spec into `bgEl`. Video is wired in M8.
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
    v.src = bg.url;
    v.autoplay = true;
    v.muted = bg.muted !== false; // muted by default → autoplay allowed
    v.loop = bg.loop !== false;
    v.playsInline = true;
    v.className = "bg-video";
    if (bg.playback_rate) v.playbackRate = bg.playback_rate;
    bgEl.appendChild(v);
    v.play?.().catch(() => {});
  }
  // Readability dim over image/video.
  const dim = bg && bg.overlay_dim;
  if (dim && dim > 0) {
    const d = document.createElement("div");
    d.className = "bg-dim";
    d.style.background = `rgba(0,0,0,${dim})`;
    bgEl.appendChild(d);
  }
}

// Position a free element by its 0..1 box. Width/height optional (legacy text
// overlays had only x,y) — then the box hugs its content, centered on x,y.
function placeElement(n, el) {
  const hasBox = el.w != null || el.h != null;
  n.style.left = (el.x ?? 0.5) * 100 + "%";
  n.style.top = (el.y ?? 0.5) * 100 + "%";
  if (hasBox) {
    n.style.width = (el.w ?? 0.3) * 100 + "%";
    n.style.height = (el.h ?? 0.15) * 100 + "%";
    n.style.transform = "none";
  } else {
    n.style.transform = "translate(-50%, -50%)"; // legacy center anchor
  }
}

// Render the free-element layer (generalized overlays): text boxes, shapes, images.
export function renderElements(root, elements) {
  root.replaceChildren();
  for (const el of elements || []) {
    let n;
    if (el.type === "image") {
      n = document.createElement("img");
      n.className = "el el-image";
      n.src = el.url;
    } else if (el.type === "shape") {
      n = document.createElement("div");
      n.className = "el el-shape el-" + (el.shape || "rect");
      n.style.background = el.shape === "line" ? "transparent" : (el.fill || "transparent");
      const sw = el.stroke_width ?? (el.shape === "line" ? 2 : 0);
      if (el.shape === "line") {
        n.style.borderTop = `${sw / 10}cqw solid ${el.stroke || "#fff"}`;
      } else if (sw) {
        n.style.border = `${sw / 10}cqw solid ${el.stroke || "#fff"}`;
      }
      if (el.shape === "ellipse") n.style.borderRadius = "50%";
      else if (el.radius) n.style.borderRadius = (el.radius / 10) + "cqw";
    } else {
      n = document.createElement("div");
      n.className = "el el-text";
      n.textContent = el.text ?? "";
      n.style.fontSize = (el.size ?? 4) + "cqw";
      n.style.color = el.color || "var(--text)";
      n.style.textAlign = el.align || "center";
      n.style.fontWeight = el.weight || 600;
    }
    placeElement(n, el);
    root.appendChild(n);
  }
}

// Per-slide content style override (gasa/bible etc.): font scale, color, align.
function applyContentStyle(contentEl, style) {
  contentEl.style.removeProperty("--content-scale");
  contentEl.style.removeProperty("text-align");
  contentEl.style.removeProperty("--text");
  if (!style) return;
  if (style.scale) contentEl.style.setProperty("--content-scale", style.scale);
  if (style.color) contentEl.style.setProperty("--text", style.color);
  if (style.align) contentEl.style.textAlign = style.align;
}

export function renderSlideWithLayers(container, slide, theme) {
  container.classList.add("slide-layers");
  applyTheme(container, theme);

  let bgEl = container.querySelector(":scope > .layer-bg");
  let contentEl = container.querySelector(":scope > .layer-content");
  let overlayEl = container.querySelector(":scope > .layer-overlays");
  if (!bgEl) {
    container.replaceChildren();
    bgEl = mk("layer-bg"); contentEl = mk("layer-content"); overlayEl = mk("layer-overlays");
    container.append(bgEl, contentEl, overlayEl);
  }

  const bg = slide.background ?? (theme && theme.background) ?? { type: "color", value: "#000" };
  renderBackground(bgEl, bg);
  renderSlide(contentEl, slide, theme);
  applyContentStyle(contentEl, slide.data?.style);
  renderElements(overlayEl, slide.overlays || []);
}

function mk(cls) {
  const n = document.createElement("div");
  n.className = cls;
  return n;
}
