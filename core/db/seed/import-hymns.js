// Import 새찬송가 from hymns.json into hymns/hymn_verses/hymns_fts.
// Source shape: [ { number, title, verses:[ { no, lines:[...] } ], body, source } ]
// verses 배열엔 후렴이 빠져 있고 후렴은 body의 마지막 "(후렴) …" 줄에만 있다.
// → body에서 후렴을 뽑아 verse_no=0(label "후렴")으로 저장한다.

// body의 마지막 비어있지 않은 줄이 "(후렴)…"이면 후렴 텍스트(마커 제거)를 반환.
export function extractRefrain(body) {
  if (!body) return null;
  const lines = String(body).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t) continue;
    return /^\(후렴\)/.test(t) ? t.replace(/^\(후렴\)\s*/, "").trim() : null;
  }
  return null;
}

export function importHymns(db, data) {
  const insH = db.prepare("INSERT OR REPLACE INTO hymns (number,title,category) VALUES (?,?,?)");
  const insV = db.prepare("INSERT OR IGNORE INTO hymn_verses (hymn_number,verse_no,label,text) VALUES (?,?,?,?)");
  const insF = db.prepare("INSERT INTO hymns_fts (title,text,number) VALUES (?,?,?)");

  let verseCount = 0, refrainCount = 0;
  const tx = db.transaction(() => {
    db.exec("DELETE FROM hymns_fts; DELETE FROM hymn_verses; DELETE FROM hymns;");
    for (const h of data) {
      insH.run(h.number, h.title, null);
      for (const v of h.verses) {
        insV.run(h.number, v.no, `${v.no}절`, v.lines.join("\n"));
        verseCount++;
      }
      const refrain = extractRefrain(h.body);
      if (refrain) { insV.run(h.number, 0, "후렴", refrain); refrainCount++; }
      const ftsText = h.body || h.verses.map((v) => v.lines.join("\n")).join("\n");
      insF.run(h.title, ftsText, h.number);
    }
  });
  tx();
  return { hymns: data.length, verses: verseCount, refrains: refrainCount };
}
