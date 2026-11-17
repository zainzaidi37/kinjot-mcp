import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openLocalLibrary, type LocalLibrary } from './library.js';
import { makeLibraryFixture } from './library-fixture.js';
import { saveNoteLocally } from './save-note.js';

/**
 * The local applier. The *planning* is `planSaveNote`'s, which matches
 * `mcp_save_note` row-for-row — what these cases pin is what this package adds: that the plan is applied in
 * order, all-or-nothing, into the library the handshake opened.
 */

function rows(library: LocalLibrary, table: string): Record<string, unknown>[] {
  // rowid, so insertion order is what is compared (note_tags has no `id`).
  return library.db.prepare(`SELECT * FROM "${table}" ORDER BY "rowid"`).all();
}

describe('saveNoteLocally', () => {
  let dir: string;
  let library: LocalLibrary;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kinjot-save-'));
    makeLibraryFixture(dir);
    library = openLocalLibrary(dir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    library.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('stores SQL-metacharacter content literally — values are bound, never interpolated', () => {
    // The applier builds its SQL from schema-derived identifiers and binds
    // every value; this pins that property against a future regression that
    // interpolates. The payloads are stored byte-for-byte and the other
    // tables survive.
    const title = `Rob'); DROP TABLE "notes";--`;
    const body = `x" OR "1"="1'; DELETE FROM notes; PRAGMA journal_mode=DELETE;--\n${'"'.repeat(8)}`;
    const folder = `evil'"); DROP TABLE folders;--`;
    // The tag rides the one op with different SQL (note_tags, INSERT OR
    // IGNORE) and the normalizeTags choke point.
    const tag = `inject'); DROP TABLE tags;--`;
    const saved = saveNoteLocally(library, { title, body, folder, tags: [tag], source: 'cli' });

    const notes = rows(library, 'notes');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ id: saved.id, title, body });
    expect(rows(library, 'folders').map((row) => row.name)).toEqual([folder]);
    expect(rows(library, 'tags')).toHaveLength(1);
    expect(rows(library, 'note_tags')).toHaveLength(1);

    // The tables the payloads name still exist and still accept writes.
    const again = saveNoteLocally(library, { title: 'after', body: '', folder, tags: [tag] });
    expect(rows(library, 'notes').map((note) => note.id)).toEqual([saved.id, again.id]);
    expect(rows(library, 'folders')).toHaveLength(1);
    expect(rows(library, 'tags')).toHaveLength(1);
    expect(rows(library, 'note_tags')).toHaveLength(2);
  });

  it('unwinds the whole save when the note insert fails mid-way — the file is untouched', () => {
    // All-or-nothing is not a nicety: `mcp_save_note` has no update path, so a
    // note id that already exists is a unique violation that rolls back the
    // folder the call had already created. The local save must leave the
    // library exactly as it found it. The folder is the one write before the
    // failing note insert (`planSaveNote` plans the tag and its link after the
    // note, as the RPC does), so the order is pinned too: planned after the
    // note, the folder would never be written and the snapshot would match
    // without any rollback.
    const noteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    saveNoteLocally(library, { id: noteId, title: 'first', body: '' });

    const snapshot = () => ({
      notes: rows(library, 'notes'),
      folders: rows(library, 'folders'),
      tags: rows(library, 'tags'),
      note_tags: rows(library, 'note_tags'),
    });
    const before = snapshot();
    expect(before.notes.map((note) => [note.id, note.title])).toEqual([[noteId, 'first']]);
    expect([before.folders, before.tags, before.note_tags]).toEqual([[], [], []]);

    const inserts: string[] = [];
    const prepare = library.db.prepare.bind(library.db);
    vi.spyOn(library.db, 'prepare').mockImplementation((sql: string) => {
      const table = /^INSERT (?:OR IGNORE )?INTO "(\w+)"/.exec(sql)?.[1];
      if (table) inserts.push(table);
      return prepare(sql);
    });
    expect(() =>
      saveNoteLocally(library, {
        id: noteId,
        title: 'second',
        body: '',
        folder: 'Late Folder',
        tags: ['late-tag'],
      }),
    ).toThrow(/UNIQUE constraint failed: notes\.id/);

    expect(inserts).toEqual(['folders', 'notes']);
    expect(snapshot()).toEqual(before);
  });
});
