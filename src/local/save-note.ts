// `jot` against the local library: the vendored planner, applied.
//
// The planning half is not written here on purpose — `planSaveNote`
// (`../core/save-note.ts`) is the single port of `mcp_save_note`, pinned to the
// RPC row-for-row by `supabase/tests/save-note-conformance.test.ts` (§6, §9).
// This module is the *applier* the plan needs, and it owes the plan exactly two
// properties the conformance suite depends on: the ops run in order, and they
// run all-or-nothing.

import { randomUUID } from 'node:crypto';
import {
  ADDED_COLUMNS,
  LOCAL_STORE_SQLITE_SCHEMA,
  planSaveNote,
  selectTagVocabulary,
  type ExistingFolder,
  type ExistingTag,
  type SaveNoteOp,
  type SaveNoteSource,
  type TagVocabularyLink,
} from '../core/index.js';
import type { SavedNote } from '../api.js';
import { normalizeTags } from '../tagging.js';
import { isUuidShapeAnyCase } from '../uuid.js';
import {
  busyRefusal,
  isSqliteBusy,
  MAX_SUPPORTED_SCHEMA_VERSION,
  type LocalLibrary,
} from './library.js';
import type { SqliteDatabase } from './runtime.js';

export interface LocalSaveNoteInput {
  readonly id?: string;
  readonly title: string;
  readonly body: string;
  readonly tags?: string[];
  readonly folder?: string;
  readonly source?: SaveNoteSource;
  /** Prior tag spellings, same hint the API path passes to `normalizeTags`. */
  readonly vocabulary?: string[];
}

/**
 * Applies one planned op.
 *
 * Every column of the table is named and bound, because the planner emits
 * complete rows and "absent is not a state" in the batch contract. `ifExists:
 * 'ignore'` — which only the `note_tags` insert carries — becomes
 * `INSERT OR IGNORE`, the SQL's `on conflict do nothing`. Every other op must
 * fail on conflict: that is how the planner's no-update-path quirk is enforced.
 */
function applyOp(db: SqliteDatabase, op: SaveNoteOp, schemaVersion: number): void {
  const row = op.row as unknown as Record<string, unknown>;
  const columns = Object.keys(LOCAL_STORE_SQLITE_SCHEMA[op.table].columns).filter((column) => {
    const added = ADDED_COLUMNS.find(
      (entry) => entry.table === op.table && entry.column === column,
    );
    if (!added || added.version <= schemaVersion) return true;
    if (row[column] != null) {
      throw new Error(
        `Cannot write ${op.table}.${column}: local library schema ${schemaVersion} lacks this column`,
      );
    }
    return false;
  });
  const ignore = 'ifExists' in op;
  const sql =
    `INSERT ${ignore ? 'OR IGNORE ' : ''}INTO "${op.table}" ` +
    `(${columns.map((column) => `"${column}"`).join(', ')}) ` +
    `VALUES (${columns.map(() => '?').join(', ')})`;
  db.prepare(sql).run(...columns.map((column) => row[column] ?? null));
}

/**
 * One write transaction, **`BEGIN IMMEDIATE`** — the same choice the desktop
 * applier makes and for the same reason
 * (`apps/desktop/src-tauri/src/store/apply.rs`, §4.3): `saveNoteLocally` reads before it writes (the folder and tag lookups
 * run inside this transaction), and in WAL a deferred read-then-write
 * transaction that loses a cross-process race gets `SQLITE_BUSY_SNAPSHOT`
 * **immediately**, which `busy_timeout` does not cover. Taking the write lock
 * up front turns the app-writing-at-the-same-moment case into a wait instead
 * of a failure. The CLI is the second process in every one of those races.
 *
 * The `ROLLBACK` is guarded: `SQLITE_FULL`/`SQLITE_IOERR`/`SQLITE_NOMEM` roll
 * the transaction back on their own, and a bare `ROLLBACK` then throws
 * "no transaction is active" — masking the error the user needed to read, on
 * the one path whose messages are contracted to be the whole explanation.
 */
function inWriteTransaction<T>(db: SqliteDatabase, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // already rolled back by SQLite itself
    }
    throw error;
  }
}

/**
 * Runs the ops as one transaction.
 *
 * All-or-nothing is not a nicety: `mcp_save_note` rolls back the folder and
 * tags it had already created when the note insert conflicts, and the
 * conformance suite — which runs *this* function — asserts the local side
 * leaves the library exactly as it found it.
 */
export function applySaveNotePlan(
  db: SqliteDatabase,
  ops: readonly SaveNoteOp[],
  schemaVersion = MAX_SUPPORTED_SCHEMA_VERSION,
): void {
  inWriteTransaction(db, () => {
    for (const op of ops) applyOp(db, op, schemaVersion);
  });
}

/**
 * Reads what the RPC's two lookups read, plans, applies, and returns the same
 * shape the API path returns — so the CLI and the MCP tool print one thing.
 *
 * The reads are scoped to the library's own workspace id, which is what local
 * mode writes into `user_id` (§5.1). A local library holds exactly one
 * workspace, so the predicate is belt-and-braces rather than a tenancy
 * boundary — but `selectTagVocabulary` counts whatever it is handed, and
 * scoping at the query is the habit that keeps that true.
 */
export function saveNoteLocally(library: LocalLibrary, input: LocalSaveNoteInput): SavedNote {
  if (input.id !== undefined && !isUuidShapeAnyCase(input.id)) {
    throw new Error('note id must be a UUID in 8-4-4-4-12 hexadecimal form');
  }
  const { db, workspaceId } = library;
  // Normalized through the same choke point the API path uses, so tag hygiene
  // cannot differ by mode.
  const tags = input.tags ? normalizeTags(input.tags, input.vocabulary) : [];

  // Read, plan and apply inside ONE write transaction. The reads are the
  // get-or-create lookups, and outside the transaction they are the §4.9
  // two-process race: this process and the app (or a second CLI) both read
  // "no folder named Work", both plan one, both insert — two folders, no
  // error. `BEGIN IMMEDIATE` serializes the whole read-plan-apply against
  // every other writer, so the second process reads the first one's folder.
  const planAndApply = () =>
    inWriteTransaction(db, () => {
      const folders = db
        .prepare(
          `SELECT "id", "name", "created_at", "deleted_at" FROM "folders" WHERE "user_id" = ?`,
        )
        .all(workspaceId) as unknown as ExistingFolder[];
      const existingTags = db
        .prepare(`SELECT "id", "name", "deleted_at" FROM "tags" WHERE "user_id" = ?`)
        .all(workspaceId) as unknown as ExistingTag[];

      const planned = planSaveNote(
        {
          userId: workspaceId,
          folders,
          tags: existingTags,
          now: new Date().toISOString(),
          newId: () => randomUUID(),
        },
        {
          id: input.id?.toLowerCase() ?? randomUUID(),
          title: input.title,
          body: input.body,
          tags: input.tags ? tags : undefined,
          folder: input.folder ?? null,
          source: input.source ?? 'mcp',
        },
      );
      for (const op of planned.ops) applyOp(db, op, library.schemaVersion);
      return planned;
    });

  // `BEGIN IMMEDIATE` waits out `busy_timeout` for that lock; a writer that
  // holds it longer surfaces as a raw `SQLITE_BUSY`, and `inWriteTransaction`
  // has already rolled back (or never began), so the truthful line is the
  // same contention refusal the open path gives — not a bare "database is
  // locked" that leaves the user unsure whether the jot half-landed.
  let plan: ReturnType<typeof planSaveNote>;
  try {
    plan = planAndApply();
  } catch (error) {
    if (isSqliteBusy(error)) throw busyRefusal(library.path, error);
    throw error;
  }

  return {
    id: plan.note.id,
    title: plan.note.title,
    created_at: plan.note.created_at,
    tags,
    existingTags: readTagVocabulary(db, workspaceId, library.schemaVersion),
  };
}

/**
 * The RPC's `tag_vocab` projection, read **after** the apply — the SQL builds
 * it in its return expression, so a tag this call created is in it, with its
 * new link counted.
 */
function readTagVocabulary(
  db: SqliteDatabase,
  workspaceId: string,
  schemaVersion: number,
): string[] {
  const tags = db
    .prepare(`SELECT "id", "name", "deleted_at" FROM "tags" WHERE "user_id" = ?`)
    .all(workspaceId) as unknown as ExistingTag[];
  const folders = db
    .prepare(
      `SELECT "id", "parent_id", "name", "deleted_at"${schemaVersion >= 4 ? ', "ai_excluded_at"' : ''} FROM "folders" WHERE "user_id" = ?`,
    )
    .all(workspaceId) as unknown as {
    id: string;
    parent_id: string | null;
    name: string;
    deleted_at: string | null;
    ai_excluded_at?: string | null;
  }[];
  const excluded = new Set(
    folders
      .filter(
        (f) =>
          f.ai_excluded_at != null ||
          (f.parent_id === null &&
            f.deleted_at === null &&
            f.name.trim().toLowerCase() === 'trash'),
      )
      .map((f) => f.id),
  );
  // At most one pass per folder: cycles terminate, and dead children still inherit.
  for (let pass = 0; pass < folders.length; pass++) {
    const before = excluded.size;
    for (const f of folders)
      if (f.parent_id !== null && excluded.has(f.parent_id)) excluded.add(f.id);
    if (before === excluded.size) break;
  }
  const links = db
    .prepare(
      `SELECT nt."tag_id", nt."deleted_at", n."deleted_at" AS "note_deleted_at", n."folder_id"${schemaVersion >= 4 ? ', n."trashed_from_folder_id"' : ''} FROM "note_tags" nt JOIN "notes" n ON n."id" = nt."note_id" AND n."user_id" = nt."user_id" WHERE nt."user_id" = ?`,
    )
    .all(workspaceId) as unknown as {
    tag_id: string;
    deleted_at: string | null;
    note_deleted_at: string | null;
    folder_id: string | null;
    trashed_from_folder_id?: string | null;
  }[];
  const noteTags: TagVocabularyLink[] = links.map((link) => ({
    tag_id: link.tag_id,
    deleted_at: link.deleted_at,
    ai_eligible:
      link.note_deleted_at === null &&
      link.trashed_from_folder_id == null &&
      (link.folder_id === null || !excluded.has(link.folder_id)),
  }));
  return selectTagVocabulary({ tags, noteTags });
}
