// Import 새찬송가 from hymns.json into hymns/hymn_verses/hymns_fts.
// Source shape: [ { number, title, verses:[ { no, lines:[...] } ], body, source } ]

export function importHymns(db, data) {
  const insH = db.prepare("INSERT OR REPLACE INTO hymns (number,title,category) VALUES (?,?,?)");
  const insV = db.prepare("INSERT OR IGNORE INTO hymn_verses (hymn_number,verse_no,label,text) VALUES (?,?,?,?)");
  const insF = db.prepare("INSERT INTO hymns_fts (title,text,number) VALUES (?,?,?)");

  let verseCount = 0;
  const tx = db.transaction(() => {
    db.exec("DELETE FROM hymns_fts; DELETE FROM hymn_verses; DELETE FROM hymns;");
    for (const h of data) {
      insH.run(h.number, h.title, null);
      for (const v of h.verses) {
        insV.run(h.number, v.no, `${v.no}절`, v.lines.join("\n"));
        verseCount++;
      }
      const ftsText = h.body || h.verses.map((v) => v.lines.join("\n")).join("\n");
      insF.run(h.title, ftsText, h.number);
    }
  });
  tx();
  return { hymns: data.length, verses: verseCount };
}
