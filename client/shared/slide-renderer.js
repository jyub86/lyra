// Content-layer renderer (design §6, §12). Browser ES module shared by editor
// preview and presenter. Renders slide.data by template_type into `container`.
// Sizing uses container-query units (cqw) so output is resolution-independent.

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function renderLines(parent, lines, cls = "line") {
  for (const line of lines || []) parent.appendChild(el("div", cls, line));
}

const renderers = {
  title(root, d) {
    root.appendChild(el("div", "title", d.title || ""));
    if (d.subtitle) root.appendChild(el("div", "subtitle", d.subtitle));
  },

  section(root, d) {
    root.appendChild(el("div", "section-label", d.label || d.title || ""));
  },

  bible(root, d) {
    if (d.ref) root.appendChild(el("div", "ref-label", d.ref));
    const body = el("div", "bible-body");
    for (const v of d.verses || []) {
      const row = el("div", "verse");
      row.appendChild(el("sup", "verse-no", String(v.verse)));
      row.appendChild(el("span", "verse-text", " " + v.text));
      body.appendChild(row);
    }
    root.appendChild(body);
  },

  hymn(root, d) {
    const head = el("div", "hymn-head");
    if (d.number) head.appendChild(el("span", "hymn-no", `${d.number}장`));
    if (d.title) head.appendChild(el("span", "hymn-title", d.title));
    root.appendChild(head);
    if (d.label) root.appendChild(el("div", "verse-label", d.label));
    renderLines(el2(root, "lyric-body"), d.lines);
  },

  praise(root, d) {
    if (d.title) root.appendChild(el("div", "praise-title", d.title));
    if (d.label) root.appendChild(el("div", "verse-label", d.label));
    renderLines(el2(root, "lyric-body"), d.lines);
  },

  responsive_reading(root, d) {
    if (d.title) root.appendChild(el("div", "ref-label", `${d.number ? d.number + "번 " : ""}${d.title}`));
    const body = el("div", "reading-body");
    for (const seg of d.segments || []) {
      const row = el("div", `reading-seg role-${seg.role}`);
      const tag = { leader: "인도자", congregation: "회중", unison: "다같이" }[seg.role] || "";
      if (tag) row.appendChild(el("span", "role-tag", tag));
      row.appendChild(el("span", "reading-text", seg.text));
      body.appendChild(row);
    }
    root.appendChild(body);
  },

  announcement(root, d) {
    root.appendChild(el("div", "section-label", d.title || "광고"));
    const ul = el("ul", "announce-list");
    for (const item of d.items || []) ul.appendChild(el("li", null, item));
    root.appendChild(ul);
  },

  offering(root, d) {
    root.appendChild(el("div", "title", d.title || "헌금"));
    if (d.caption) root.appendChild(el("div", "subtitle", d.caption));
  },

  prayer(root, d) {
    root.appendChild(el("div", "section-label", d.title || "기도제목"));
    const ul = el("ul", "announce-list");
    for (const item of d.items || []) ul.appendChild(el("li", null, item));
    root.appendChild(ul);
  },

  media(root, d) {
    if (d.caption) root.appendChild(el("div", "subtitle", d.caption));
  },

  blank() {},
};

// helper: create a child div with class and append, returning it.
function el2(parent, cls) {
  const n = el("div", cls);
  parent.appendChild(n);
  return n;
}

export function renderSlide(container, slide, _theme) {
  container.innerHTML = "";
  const type = slide.template_type;
  const root = el("div", "content content-" + type);
  (renderers[type] || renderers.blank)(root, slide.data || {});
  container.appendChild(root);
}
