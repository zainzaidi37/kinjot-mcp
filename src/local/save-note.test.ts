import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planSaveNote } from '../core/index.js';
import { openLocalLibrary, type LocalLibrary } from './library.js';
import { FIXTURE_WORKSPACE, makeLibraryFixture } from './library-fixture.js';
import { applySaveNotePlan, saveNoteLocally } from './save-note.js';

/**
 * The local applier. The *planning* is `planSaveNote`'s, pinned to
 * `mcp_save_note` row-for-row by `supabase/tests/save-note-conformance.test.ts`
 * — what these cases pin is what this package adds: that the plan is applied in
 * order, all-or-nothing, into the library the handshake opened.
 */

const WORKSPACE = FIXTURE_WORKSPACE;
// The lock-contention tests below fork a holder and can wait out the 5 s busy
// bound, so each keeps its own 30 s limit: the public kinjot-mcp mirror runs
// src/ without this package's vitest.config.ts (#1121).

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
});

describe('applySaveNotePlan', () => {
  let dir: string;
  let library: LocalLibrary;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kinjot-apply-'));
    makeLibraryFixture(dir);
    library = openLocalLibrary(dir);
  });

  afterEach(() => {
    library.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('unwinds the whole plan when an op fails mid-way — the file is untouched', () => {
    // The RPC has no update path: a note id that already exists is a unique
    // violation that rolls back the folder and tag the call had already
    // created. The local applier owes the same, and this is what proves it is
    // transactional rather than incidentally ordered.
    let counter = 0;
    const context = {
      userId: WORKSPACE,
      folders: [],
      tags: [],
      now: '2026-08-05T10:00:00.000Z',
      newId: () => `planned-${++counter}`,
    };
    const noteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    applySaveNotePlan(
      library.db,
      planSaveNote(context, { id: noteId, title: 'first', body: '' }).ops,
    );

    const before = {
      notes: rows(library, 'notes'),
      folders: rows(library, 'folders'),
      tags: rows(library, 'tags'),
      note_tags: rows(library, 'note_tags'),
    };

    const retry = planSaveNote(context, {
      id: noteId,
      title: 'second',
      body: '',
      folder: 'Late Folder',
      tags: ['late-tag'],
    });
    // The folder and the tag are planned *before* the note insert that fails.
    expect(retry.ops[0]!.table).toBe('folders');
    expect(() => applySaveNotePlan(library.db, retry.ops)).toThrow();

    expect({
      notes: rows(library, 'notes'),
      folders: rows(library, 'folders'),
      tags: rows(library, 'tags'),
      note_tags: rows(library, 'note_tags'),
    }).toEqual(before);
  });
});
