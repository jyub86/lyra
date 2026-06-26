// Import 교독문 from readings.json into responsive_readings/reading_segments/readings_fts.
// Source shape: [ { number, title, label, source_file,
//   segments:[ { order, role:"leader|congregation|unison", role_ko, text } ], body } ]

export function importReadings(db, data) {
  const insR = db.prepare("INSERT OR REPLACE INTO responsive_readings (number,title) VALUES (?,?)");
  const insS = db.prepare("INSERT OR IGNORE INTO reading_segments (reading_number,position,role,text) VALUES (?,?,?,?)");
  const insF = db.prepare("INSERT INTO readings_fts (text,reading_number) VALUES (?,?)");

  let segCount = 0;
  const tx = db.transaction(() => {
    db.exec("DELETE FROM readings_fts; DELETE FROM reading_segments; DELETE FROM responsive_readings;");
    for (const r of data) {
      insR.run(r.number, r.title || r.label);
      for (const s of r.segments) {
        insS.run(r.number, s.order, s.role, s.text);
        segCount++;
      }
      const ftsText = r.body || r.segments.map((s) => s.text).join("\n");
      insF.run(ftsText, r.number);
    }
  });
  tx();
  return { readings: data.length, segments: segCount };
}
