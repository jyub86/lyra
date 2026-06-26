// Import 성경 from bible.json into bible_books/aliases/verses/fts.
// Source shape: { version, book_count, books: [
//   { order, name, short, aliases:[...], chapters, verses:[
//       { chapter, verse:"16", v1, v2, text, title? } ] } ] }
// Verse number is stored as the integer v1 (only ~11/31k are merged ranges).

export function importBible(db, data) {
  const insBook = db.prepare("INSERT OR REPLACE INTO bible_books (book_order,name,short_name,testament,chapter_count) VALUES (?,?,?,?,?)");
  const insAlias = db.prepare("INSERT OR REPLACE INTO bible_aliases (alias,book_order) VALUES (?,?)");
  const insVerse = db.prepare("INSERT OR IGNORE INTO bible_verses (book_order,chapter,verse,text) VALUES (?,?,?,?)");
  const insFts = db.prepare("INSERT INTO bible_fts (text,book_order,chapter,verse) VALUES (?,?,?,?)");

  let verseCount = 0;
  const tx = db.transaction(() => {
    db.exec("DELETE FROM bible_fts; DELETE FROM bible_verses; DELETE FROM bible_aliases; DELETE FROM bible_books;");
    for (const b of data.books) {
      const testament = b.order <= 39 ? "old" : "new";
      insBook.run(b.order, b.name, b.short ?? null, testament, b.chapters ?? null);
      const aliases = new Set([b.name, b.short, ...(b.aliases || [])].filter(Boolean));
      for (const a of aliases) insAlias.run(a, b.order);
      for (const v of b.verses) {
        insVerse.run(b.order, v.chapter, v.v1, v.text);
        insFts.run(v.text, b.order, v.chapter, v.v1);
        verseCount++;
      }
    }
  });
  tx();
  return { books: data.books.length, verses: verseCount };
}
