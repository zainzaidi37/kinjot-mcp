// Opening the local library the pointer names — the §5.3 handshake.
//
// The pointer is a hint, not an authority: this module opens the file it names
// and then *checks* it, and every failure is a refusal to write rather than a
// fall-through to the account path.
//
// Creation, WAL and migration belong to the desktop app alone (§5.3, §4.3), so
// a missing file is a hard error and a file that is not in WAL is a corrupt
// installation the CLI reports rather than "fixes". The CLI's own obligations
// on its connection are the two pragmas, `busy_timeout` and `foreign_keys`,
// both before any other statement — see the note on ordering in
// `openLocalLibrary`.

import { existsSync } from 'node:fs';
import { SQLITE_MIGRATIONS } from '../core/index.js';
import { readPointer, type LocalLibraryPointer } from './pointer.js';
import {
  assertSqliteFloor,
  loadSqlite,
  sqliteVersionOf,
  LocalModeError,
  type SqliteDatabase,
} from './runtime.js';

/**
 * The busy timeout, in ms, matching the sqlx default the app runs with (§4.3,
 * measured). sqlx sets `foreign_keys=ON` and `busy_timeout=5s` for the app's
 * connections; a separate driver gets neither for free, so both are set
 * explicitly here — the CLI is the *other* process in every cross-process race
 * WAL has to absorb.
 */
export const BUSY_TIMEOUT_MS = 5000;

/**
 * The migration that first creates the four tables `planSaveNote` writes
 * (`notes`, `folders`, `tags`, `note_tags`). A library below it cannot hold a
 * jot at all.
 *
 * Accepting `MIN..MAX` relies on the applier's version-aware omission rule:
 * it omits a column added after the library's schema version only when the
 * planned value is null. A non-null value refuses before an INSERT, so an old
 * library can still capture jots without silently losing a new value.
 */
export const MIN_SUPPORTED_SCHEMA_VERSION = 1;

/** The newest migration this CLI's vendored DDL knows about. */
export const MAX_SUPPORTED_SCHEMA_VERSION = SQLITE_MIGRATIONS.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
);

export interface LocalLibrary {
  readonly db: SqliteDatabase;
  /** The pointer that named this file, as read from disk. */
  readonly pointer: LocalLibraryPointer;
  readonly path: string;
  /**
   * `meta.workspace_uuid` — the identity every row local mode writes carries as
   * its `user_id` (§5.1; the desktop's local mode does the same).
   */
  readonly workspaceId: string;
  /** `MAX(version)` of `_sqlx_migrations`, the library's own schema version. */
  readonly schemaVersion: number;
  close(): void;
}

function scalar(db: SqliteDatabase, sql: string): unknown {
  const row = db.prepare(sql).get();
  if (row === undefined) return undefined;
  return Object.values(row)[0];
}

/**
 * Runs the §5.3 handshake and hands back an open, write-ready library.
 *
 * @param dir the config root (`configDir()`), honoring `KINJOT_CONFIG_DIR`
 *   exactly as the key file does — which is what makes the two-process test
 *   harness possible without touching a developer's real library (§5.1: the
 *   override moves the root for *both* processes, `library.rs`'s
 *   `config_root`). The catch worth knowing, and the reason the README warns
 *   against setting it by hand: the app reads the variable from **its own**
 *   environment, and an app launched from the Start menu inherits nothing a
 *   shell exported — so a hand-set override usually moves the CLI alone, and
 *   local mode then reads as "not set up".
 */
export function openLocalLibrary(dir: string): LocalLibrary {
  const pointer = readPointer(dir);

  // A dangling `db_path` is routine — an uninstalled channel, an MSIX repair,
  // a cleared ~/.kinjot/local/ — and §5.3 makes it a hard error precisely
  // because the alternative (treating it as "no local library") would ship a
  // local-first user's jots to a server they abandoned.
  if (!existsSync(pointer.db_path)) {
    throw new LocalModeError(
      `the Kinjot local library named by the pointer is missing: ${pointer.db_path}. ` +
        `Launch the desktop app to recreate it — nothing was written, and nothing was ` +
        `sent to the server.`,
    );
  }

  const DatabaseSync = loadSqlite();
  let db: SqliteDatabase;
  try {
    // Opened read-write. A missing path is refused above, but DatabaseSync can
    // create a file if the path disappears between that check and open. The
    // handshake below then refuses a file without library metadata
    // (`plans/desktop-app.md` §5.3).
    db = new DatabaseSync(pointer.db_path, { enableForeignKeyConstraints: true });
  } catch (error) {
    throw new LocalModeError(
      `could not open the Kinjot local library at ${pointer.db_path}: ${String(error)}. ` +
        `Nothing was written, and nothing was sent to the server.`,
    );
  }

  try {
    // Explicit, both of them: sqlx's defaults cover the app's connections only
    // (§4.3). `foreign_keys` is passed as an option *and* asserted, because the
    // option's default is a property of node:sqlite rather than of this code.
    //
    // `busy_timeout` goes **first**, before any other statement. Neither pragma
    // touches the file, but preparing any ordinary statement on a fresh
    // connection loads the schema, which opens a read transaction on it — so
    // the version query below is the first statement that reads the file, and
    // it has to run inside the bound. With it ahead of the pragma, a sibling
    // process mid-WAL-recovery (two captures racing while the app is closed)
    // surfaced as an instant "database is locked" and a refusal telling the
    // user to recreate their library (#400, measured in
    // plans/local-library-open-busy-timeout.md §1).
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec('PRAGMA foreign_keys = ON');

    assertSqliteFloor(sqliteVersionOf(db));

    const journalMode = String(scalar(db, 'PRAGMA journal_mode') ?? '').toLowerCase();
    if (journalMode !== 'wal') {
      // Never "fixed": only the app creates this file, and it sets WAL once at
      // creation (§4.3). A non-WAL library is a corrupt installation.
      throw new LocalModeError(
        `the Kinjot local library at ${pointer.db_path} is not in WAL mode ` +
          `(journal_mode=${journalMode || 'unknown'}), which means it was not created by the ` +
          `desktop app. Nothing was written — reinstall the desktop app or remove that file ` +
          `and launch it again.`,
      );
    }

    const workspaceId = readWorkspaceUuid(db, pointer.db_path);
    if (workspaceId !== pointer.workspace_uuid) {
      throw new LocalModeError(
        `the Kinjot pointer file and the library at ${pointer.db_path} disagree about which ` +
          `workspace it is (pointer ${pointer.workspace_uuid}, library ${workspaceId}). ` +
          `Launch the desktop app to republish the pointer; nothing was written.`,
      );
    }

    const schemaVersion = readSchemaVersion(db, pointer.db_path);
    if (schemaVersion !== pointer.schema_version) {
      throw new LocalModeError(
        `the Kinjot pointer file and the library at ${pointer.db_path} disagree about its ` +
          `schema version (pointer ${pointer.schema_version}, library ${schemaVersion}). ` +
          `Launch the desktop app to republish the pointer; nothing was written.`,
      );
    }
    if (schemaVersion > MAX_SUPPORTED_SCHEMA_VERSION) {
      throw new LocalModeError(
        `the Kinjot local library is newer than this CLI understands (library schema ` +
          `${schemaVersion}, this CLI ${MAX_SUPPORTED_SCHEMA_VERSION}). ` +
          `Update the CLI: npm i -g kinjot. Nothing was written.`,
      );
    }
    if (schemaVersion < MIN_SUPPORTED_SCHEMA_VERSION) {
      throw new LocalModeError(
        `the Kinjot local library at ${pointer.db_path} has schema version ${schemaVersion}, ` +
          `below this CLI's minimum ${MIN_SUPPORTED_SCHEMA_VERSION}. Launch the desktop app to migrate it; ` +
          `nothing was written.`,
      );
    }

    return {
      db,
      pointer,
      path: pointer.db_path,
      workspaceId,
      schemaVersion,
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    if (error instanceof LocalModeError) throw error;
    // Contention that outlived the bound is not a broken file: another process
    // held the library for the whole `busy_timeout`, and the truthful advice
    // is to try again, never to recreate anything.
    if (isSqliteBusy(error)) throw busyRefusal(pointer.db_path, error);
    // The first statement that actually reads the file is the version query,
    // inside the bound but outside any per-step handler — so a truncated or
    // non-SQLite `library.db` lands here as a raw SqliteError, and it must
    // leave in the same voice as every other refusal on this path.
    throw new LocalModeError(
      `the Kinjot local library at ${pointer.db_path} could not be read ` +
        `(${String(error)}). Launch the desktop app to recreate it; nothing was written.`,
    );
  }
}

/** SQLite's primary result code for `SQLITE_BUSY`. */
const SQLITE_BUSY = 5;

/**
 * Refuses contention that outlived {@link BUSY_TIMEOUT_MS}, on both the open
 * and write paths. A busy error reports a lock, not library corruption; advise
 * retrying rather than recreating the file. No write was committed.
 */
export function busyRefusal(path: string, error: unknown): LocalModeError {
  return new LocalModeError(
    `another process held the Kinjot local library at ${path} locked for longer than ` +
      `${BUSY_TIMEOUT_MS / 1000} s (${String(error)}); nothing was written, and nothing was ` +
      `sent to the server. Try again.`,
  );
}

/**
 * Whether a raw node:sqlite error is `SQLITE_BUSY` or one of its extended
 * forms (`SQLITE_BUSY_RECOVERY`, `SQLITE_BUSY_SNAPSHOT`, ...). node:sqlite
 * attaches the numeric `errcode`; the low byte is the primary code. Shared
 * with the write path (`save-note.ts`), which meets the same lock at
 * `BEGIN IMMEDIATE`.
 */
export function isSqliteBusy(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const errcode = (error as { errcode?: unknown }).errcode;
  return typeof errcode === 'number' && (errcode & 0xff) === SQLITE_BUSY;
}

/**
 * `meta` is a key/value table. `workspace_uuid`, which the desktop mints once,
 * is the only key the CLI reads from it (§5.1); local mode keeps its own
 * markers there too.
 */
function readWorkspaceUuid(db: SqliteDatabase, path: string): string {
  let value: unknown;
  try {
    value = db.prepare(`SELECT "value" FROM "meta" WHERE "key" = 'workspace_uuid'`).get()?.value;
  } catch (error) {
    // Contention that began after the schema load is still contention, not a
    // foreign file: leave it to the caller's classification.
    if (isSqliteBusy(error)) throw error;
    throw new LocalModeError(
      `${path} does not look like a Kinjot library (${String(error)}). Nothing was written.`,
    );
  }
  if (typeof value !== 'string' || value === '') {
    throw new LocalModeError(
      `${path} carries no workspace identity, so it is not a Kinjot library the CLI may ` +
        `write to. Launch the desktop app; nothing was written.`,
    );
  }
  return value;
}

/**
 * `MAX(version)` of `_sqlx_migrations` is the library's schema version, as
 * `Library::schema_version` and the pointer report it (`plans/desktop-app.md`
 * §7 item 6's schema-version correction). `meta` holds the workspace identity;
 * the schema version comes from migration bookkeeping.
 */
function readSchemaVersion(db: SqliteDatabase, path: string): number {
  let value: unknown;
  try {
    value = scalar(db, 'SELECT MAX(version) FROM "_sqlx_migrations"');
  } catch (error) {
    if (isSqliteBusy(error)) throw error;
    throw new LocalModeError(
      `${path} has no migration history, so it is not a Kinjot library the CLI may write ` +
        `to (${String(error)}). Nothing was written.`,
    );
  }
  if (value === null || value === undefined) return 0;
  const version = Number(value);
  if (!Number.isFinite(version)) {
    throw new LocalModeError(
      `${path} reports an unreadable schema version. Launch the desktop app; nothing was written.`,
    );
  }
  return version;
}
