// Shared helpers for tool handlers: timestamps, position management,
// slide row (de)serialization. Position strategy is a simple dense integer
// sequence (0,1,2,...) rewritten on reorder — fine for local single-writer use.

export function nowIso() {
  return new Date().toISOString();
}

// Next append position within a parent scope.
export function nextPosition(db, table, fkCol, fkVal) {
  const row = db.query(`SELECT COALESCE(MAX(position), -1) AS m FROM ${table} WHERE ${fkCol} = ?`).get(fkVal);
  return row.m + 1;
}

// Insert at an explicit position by shifting later rows down by one.
export function makeRoom(db, table, fkCol, fkVal, position) {
  db.query(`UPDATE ${table} SET position = position + 1 WHERE ${fkCol} = ? AND position >= ?`).run(fkVal, position);
}

// Close the gap left by a removed row so positions stay dense.
export function closeGap(db, table, fkCol, fkVal, position) {
  db.query(`UPDATE ${table} SET position = position - 1 WHERE ${fkCol} = ? AND position > ?`).run(fkVal, position);
}

// Rewrite positions to match an explicit ordered id list (reorder_*).
export function applyOrder(db, table, ids) {
  const stmt = db.query(`UPDATE ${table} SET position = ? WHERE id = ?`);
  const tx = db.transaction((list) => {
    list.forEach((id, i) => stmt.run(i, id));
  });
  tx(ids);
}

// JSON columns on slides: data / background / overlays.
export function parseSlide(row) {
  if (!row) return null;
  return {
    ...row,
    data: row.data ? JSON.parse(row.data) : {},
    background: row.background ? JSON.parse(row.background) : null,
    overlays: row.overlays ? JSON.parse(row.overlays) : [],
  };
}

export function touchService(db, serviceId) {
  db.query("UPDATE services SET updated_at = ? WHERE id = ?").run(nowIso(), serviceId);
}

// Find the owning service for a scene/slide — used to bump updated_at.
export function serviceIdForScene(db, sceneId) {
  return db.query("SELECT service_id FROM scenes WHERE id = ?").get(sceneId)?.service_id;
}
export function serviceIdForSlide(db, slideId) {
  return db.query(
    "SELECT s.service_id AS sid FROM slides sl JOIN scenes s ON sl.scene_id = s.id WHERE sl.id = ?"
  ).get(slideId)?.sid;
}
