import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planSaveNote } from '../core/index.js';
import { openLocalLibrary, BUSY_TIMEOUT_MS, type LocalLibrary } from './library.js';
import { FIXTURE_WORKSPACE, holdLocked, makeLibraryFixture } from './library-fixture.js';
import { LocalModeError } from './runtime.js';
import { applySaveNotePlan, saveNoteLocally } from './save-note.js';

/**
 * The local applier. The *planning* is `planSaveNote`'s, pinned to
 * `mcp_save_note` row-for-row by `supabase/tests/save-note-conformance.test.ts`
 * — what these cases pin is what this package adds: that the plan is applied in
 * order, all-or-nothing, into the library the handshake opened.
 */

const WORKSPACE = FIXTURE_WORKSPACE;

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

  // Both contention tests hold the write lock from a forked process, because
  // `BEGIN IMMEDIATE` sleeps inside SQLite's busy handler and nothing in this
  // event loop could release the lock while it waits. The holder's `write`
  // mode leaves readers free, which is what lets the assertions read the
  // library while the lock is still held.
  it('waits out a writer that releases within the bound', async () => {
    const releaseAfterMs = 300;
    const holder = await holdLocked(library.path, { releaseAfterMs, mode: 'write' });
    try {
      const started = Date.now();
      const saved = saveNoteLocally(library, { title: 'waited', body: '', tags: ['t'] });
      expect(Date.now() - started).toBeGreaterThanOrEqual(releaseAfterMs / 2);
      expect(rows(library, 'notes').map((note) => note.id)).toEqual([saved.id]);
    } finally {
      holder.kill();
    }
  }, 15_000);

  it('refuses a writer that outlives the bound as contention, with nothing written', async () => {
    const holder = await holdLocked(library.path, { mode: 'write' });
    try {
      const started = Date.now();
      let error: unknown;
      try {
        saveNoteLocally(library, { title: 'blocked', body: '', folder: 'Work', tags: ['t'] });
      } catch (caught) {
        error = caught;
      }
      expect(Date.now() - started).toBeGreaterThanOrEqual(BUSY_TIMEOUT_MS - 100);
      expect(error).toBeInstanceOf(LocalModeError);
      const message = (error as Error).message;
      expect(message).toMatch(/locked/);
      expect(message).toContain('nothing was written');
      expect(message).not.toContain('recreate');
      // The refusal is the whole story: no note, no folder, no tag landed.
      expect(rows(library, 'notes')).toEqual([]);
      expect(rows(library, 'folders')).toEqual([]);
      expect(rows(library, 'tags')).toEqual([]);
    } finally {
      holder.kill();
    }
  }, 20_000);

  it('writes the note, its folder and its tags, all owned by the library workspace', () => {
    const saved = saveNoteLocally(library, {
      title: 'Kong routing',
      body: 'db reset breaks kong',
      tags: ['Infra', 'infra', 'Connection Pool'],
      folder: 'Notes',
      source: 'cli',
    });

    const notes = rows(library, 'notes');
    expect(notes).toHaveLength(1);
    expect(library.schemaVersion).toBe(3);
    expect(notes[0]).toMatchObject({
      id: saved.id,
      user_id: WORKSPACE,
      title: 'Kong routing',
      body: 'db reset breaks kong',
      source: 'cli',
      sync_seq: null,
      short_id: null,
      deleted_at: null,
    });
    expect(rows(library, 'folders')[0]).toMatchObject({ name: 'Notes', user_id: WORKSPACE });
    expect(notes[0]!.folder_id).toBe(rows(library, 'folders')[0]!.id);

    // Tag hygiene comes from the same choke point the API path uses.
    expect(saved.tags).toEqual(['infra', 'connection-pool']);
    expect(rows(library, 'tags').map((tag) => tag.name)).toEqual(['infra', 'connection-pool']);
    expect(rows(library, 'note_tags')).toHaveLength(2);
    // The vocabulary is read after the apply, so this call's own tags are in it.
    expect(saved.existingTags).toEqual(expect.arrayContaining(['infra', 'connection-pool']));
  });

  it('uses a supplied note id while minting distinct folder and tag ids', () => {
    const id = '12345678-1234-1234-8234-123456789abc';
    const saved = saveNoteLocally(library, {
      id,
      title: 'supplied id',
      body: 'body',
      folder: 'Work',
      tags: ['one'],
    });
    expect(saved.id).toBe(id);
    expect(rows(library, 'notes')[0]?.id).toBe(id);
    expect(rows(library, 'folders')[0]?.id).not.toBe(id);
    expect(rows(library, 'tags')[0]?.id).not.toBe(id);
  });

  it('normalizes a directly supplied uppercase UUID before local storage', () => {
    const id = 'ABCDEF12-1234-4234-8234-123456789ABC';
    const saved = saveNoteLocally(library, { id, title: 'case', body: '' });
    expect(saved.id).toBe(id.toLowerCase());
    expect(rows(library, 'notes')[0]?.id).toBe(id.toLowerCase());
  });

  it('reuses an existing folder case-insensitively and an existing tag exactly', () => {
    const first = saveNoteLocally(library, {
      title: 'one',
      body: '',
      folder: 'Work',
      tags: ['auth'],
    });
    const second = saveNoteLocally(library, {
      title: 'two',
      body: '',
      folder: 'work',
      tags: ['auth'],
    });

    expect(rows(library, 'folders')).toHaveLength(1);
    expect(rows(library, 'tags')).toHaveLength(1);
    expect(rows(library, 'notes')).toHaveLength(2);
    expect(first.id).not.toBe(second.id);
    const folderId = rows(library, 'folders')[0]!.id;
    for (const note of rows(library, 'notes')) expect(note.folder_id).toBe(folderId);
  });

  it('rejects the reserved folder name without writing anything', () => {
    expect(() => saveNoteLocally(library, { title: 'x', body: '', folder: ' Trash ' })).toThrow(
      /invalid_folder/,
    );
    expect(rows(library, 'notes')).toHaveLength(0);
    expect(rows(library, 'folders')).toHaveLength(0);
  });

  it('rejects a Trash spelling the web reads as Trash, without writing anything', () => {
    // The web's rule is JavaScript's trim(), which strips more than spaces.
    // This runs the vendored planner, the copy local mode actually loads.
    for (const folder of ['Trash\t', '\u00a0trash', 'trash\u3000']) {
      expect(
        () => saveNoteLocally(library, { title: 'x', body: '', folder }),
        JSON.stringify(folder),
      ).toThrow(/invalid_folder/);
    }
    expect(rows(library, 'notes')).toHaveLength(0);
    expect(rows(library, 'folders')).toHaveLength(0);
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

  it('a duplicate tag in one call links once and does not fail (INSERT OR IGNORE)', () => {
    const saved = saveNoteLocally(library, { title: 'x', body: '', tags: ['auth', ' auth '] });
    expect(saved.tags).toEqual(['auth']);
    expect(rows(library, 'note_tags')).toHaveLength(1);
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

  it('refuses a non-null planned value for a column the v2 library lacks', () => {
    library.close();
    rmSync(join(dir, 'local'), { recursive: true, force: true });
    makeLibraryFixture(dir, { schemaVersion: 2 });
    library = openLocalLibrary(dir);
    const plan = planSaveNote(
      {
        userId: WORKSPACE,
        folders: [],
        tags: [],
        now: '2026-08-05T10:00:00.000Z',
        newId: randomUUID,
      },
      { id: randomUUID(), title: 'new', body: '' },
    );
    const note = plan.ops.find((op) => op.table === 'notes');
    expect(note).toBeDefined();
    (note!.row as unknown as { short_id: number }).short_id = 1;
    expect(() => applySaveNotePlan(library.db, plan.ops, library.schemaVersion)).toThrow(
      'local library schema 2 lacks this column',
    );
    expect(rows(library, 'notes')).toEqual([]);
  });

  it('omits null short_id when applying a jot to a v2 library', () => {
    library.close();
    rmSync(join(dir, 'local'), { recursive: true, force: true });
    makeLibraryFixture(dir, { schemaVersion: 2 });
    library = openLocalLibrary(dir);
    const saved = saveNoteLocally(library, { title: 'older library', body: '' });
    expect(library.schemaVersion).toBe(2);
    expect(rows(library, 'notes')).toHaveLength(1);
    expect(rows(library, 'notes')[0]!.id).toBe(saved.id);
    expect(Object.keys(rows(library, 'notes')[0]!)).not.toContain('short_id');
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

  it('leaves no transaction open after a rollback, so the next call still writes', () => {
    const context = {
      userId: WORKSPACE,
      folders: [],
      tags: [],
      now: '2026-08-05T10:00:00.000Z',
      newId: () => 'planned-1',
    };
    const noteId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    applySaveNotePlan(
      library.db,
      planSaveNote(context, { id: noteId, title: 'first', body: '' }).ops,
    );
    expect(() =>
      applySaveNotePlan(
        library.db,
        planSaveNote(context, { id: noteId, title: 'again', body: '' }).ops,
      ),
    ).toThrow();

    const saved = saveNoteLocally(library, { title: 'after', body: '' });
    expect(rows(library, 'notes').map((note) => note.id)).toEqual([noteId, saved.id]);
  });
});
