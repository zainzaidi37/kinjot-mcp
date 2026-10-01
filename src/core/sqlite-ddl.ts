// @generated — DO NOT EDIT.
//
// Vendored copy of packages/core/src/sqlite-ddl.ts, emitted by
// `pnpm --filter @kinjot/core emit:mcp-core` (plans/desktop-app.md §4.5).
// Edit the source module and re-run; CI fails on any difference.

/**
 * Canonical SQLite schema for the local store (`plans/desktop-app.md` §4.4).
 *
 * The Dexie schema in `apps/web/src/data/db.ts` and this file describe **one**
 * store: the frozen `LocalStore` contract (`apps/web/src/data/local-store.ts`)
 * is implemented over Dexie in the browser and over SQLite on the desktop, and
 * a column that exists in one engine and not the other is a divergence the
 * contract tests cannot see. So the schema is authored **once, here**, in
 * TypeScript, and the `.sql` migration files Rust runs are *emitted* from it
 * (`packages/core/scripts/emit-sqlite-ddl.mjs`); Rust never hand-writes schema
 * and CI fails on any drift between this file and the emitted output.
 *
 * Three rules govern the column types, all inherited from the contract:
 *
 * 1. **Every column is declared, and nullable exactly where the row type
 *    allows null.** "Absent is not a state" — JSON drops `undefined` keys and
 *    SQLite has no per-row notion of absence, so a missing value is `null` and
 *    a `NOT NULL` column with no default makes an incomplete row fail loudly
 *    at the boundary instead of half-landing.
 * 2. **TEXT for strings, ids and opaque JSON; INTEGER for every integer** (and
 *    for any boolean, should one ever exist — see {@link SqliteColumn.boolean}).
 *    JS numbers are `f64` at the source, so INTEGER affinity is what converts
 *    them back; nothing may rely on precision above 2^53
 *    (`plans/desktop-app.md` §4.3/§4.8).
 * 3. **`outbox.seq` is `INTEGER PRIMARY KEY AUTOINCREMENT`.** The contract
 *    says keys are never reused and the acknowledgement routinely deletes the
 *    highest one; a plain rowid hands that number straight back to the next
 *    insert, and both the lease identity and `noOutboxRowsBeyond` assume it
 *    cannot.
 *
 * ## No foreign keys, deliberately
 *
 * See {@link DDL_HEADER} — the rationale ships inside the emitted `.sql` so it
 * is present wherever the schema is read.
 *
 * ## Floor
 *
 * SQLite 3.46.0 (`plans/desktop-app.md` §4.8, asserted in CI). Nothing here
 * needs a feature above it: no `STRICT` tables (see the note on
 * {@link LOCAL_STORE_SQLITE_SCHEMA}), no generated columns, no `RETURNING`.
 *
 * This module imports nothing on purpose: the emit script runs it under bare
 * Node type-stripping, so it must not need module resolution.
 */

/**
 * The eight tables migration 1 shipped — **frozen**, because its bytes are in a
 * `_sqlx_migrations` checksum on disk. A table added to the local library
 * arrives as a new migration below, never by widening this list.
 */
export const V1_TABLE_NAMES = [
  'notes',
  'folders',
  'tags',
  'note_tags',
  'sync_cursors',
  'outbox',
  'idMap',
  'meta',
] as const;

/**
 * Migration 2 (Phase 8 WP6, signed off 2026-08-05): the two tables a **local**
 * library holds and a signed-in cache does not.
 *
 * Version history and saved Recall answers are local mode's own content — they
 * have no server row behind them and never sync — and until now they existed
 * only as Dexie tables on `DemoDatabase`. Moving desktop local mode onto the
 * SQLite library (`plans/desktop-app.md` §7 item 6) needs them here, or the
 * port silently drops two shipped features. Widening the table set was the
 * explicit alternative to inventing a second store, and it is additive: nothing
 * about the op or precondition vocabulary changes.
 */
export const V2_TABLE_NAMES = ['note_versions', 'recalls'] as const;

/**
 * Every table a batch may touch, mirroring `TableName` in
 * `apps/web/src/data/local-store.ts`. Declared here rather than imported
 * because `packages/core` never imports app code; a test in `apps/web` pins
 * the two lists together.
 */
export const LOCAL_TABLE_NAMES = [...V1_TABLE_NAMES, ...V2_TABLE_NAMES] as const;

export type LocalTableName = (typeof LOCAL_TABLE_NAMES)[number];

/**
 * Columns present in the current record but introduced after a shipped schema.
 *
 * An entry newer than the last of `SQLITE_MIGRATIONS` is the shared half of a
 * schema still to ship: the record carries it, so the browser cache's column
 * check admits it, while every shipped migration renders without it. Version 4
 * (`folders.pinned_at`, synced folder pins) is that today; its migration, the
 * Rust column map and the fixture follow in the desktop half while desktop
 * builds are paused, as version 3's did.
 */
export const ADDED_COLUMNS = [
  { version: 3, table: 'notes', column: 'short_id' },
  { version: 4, table: 'folders', column: 'pinned_at' },
] as const;

/** How one column is stored, and what a (de)hydrating implementation owes it. */
export interface SqliteColumn {
  /** Declared type. Also the affinity, which is the point (rule 2 above). */
  readonly type: 'TEXT' | 'INTEGER';
  /** True when the row type allows `null`. */
  readonly nullable: boolean;
  /**
   * An **opaque nested document**, stored as serialized TEXT.
   *
   * The contract bans opaque values from precondition and patch columns, so
   * these are write-whole/read-whole: an implementation serializes on the way
   * in and **parses on the way out**, because callers spread the value
   * (`outbox.ts` treats `payload` as an object). Never compared.
   */
  readonly json?: true;
  /**
   * An INTEGER-backed boolean. **Empty today, and that is load-bearing**: the
   * contract excludes booleans from `Scalar` precisely so `1 === true` cannot
   * silently diverge between the two engines. The flag exists so that if a
   * boolean column is ever added, the one place that must know how to
   * re-materialize it is this map rather than each implementation.
   */
  readonly boolean?: true;
}

/** One index, mirroring a Dexie index of the same shape. */
export interface SqliteIndex {
  readonly name: string;
  readonly columns: readonly string[];
  /**
   * True when Dexie serves this index **only as a compound**, with no
   * standalone index on its leftmost column.
   *
   * The asymmetry this records is real and it is the reason the flag exists:
   * SQLite answers a leftmost-prefix lookup from a compound index, and
   * **IndexedDB does not** — a `where('table')` against a Dexie schema that
   * only declares `[table+key]` throws `SchemaError`. So a column that looks
   * indexed here can be unqueryable there, which is precisely the engine
   * divergence {@link LOCAL_STORE_INDEXED_COLUMNS} exists to prevent.
   *
   * Set from the Dexie declarations in `apps/web/src/data/db.ts`, which this
   * package cannot import; a test in `apps/web` runs a real `listBy` for every
   * column the list admits, so a wrong flag fails there rather than on a user's
   * desktop.
   */
  readonly dexieCompoundOnly?: true;
}

export interface SqliteTableSchema {
  readonly columns: Readonly<Record<string, SqliteColumn>>;
  /**
   * The primary key columns, in order — the same key the contract's `RowKey`
   * describes for this table.
   */
  readonly primaryKey: readonly string[];
  /**
   * The column the store assigns rather than the plan (`outbox.seq`), or null.
   * Declared `INTEGER PRIMARY KEY AUTOINCREMENT`.
   */
  readonly autoKey: string | null;
  readonly indexes: readonly SqliteIndex[];
}

const TEXT: SqliteColumn = { type: 'TEXT', nullable: false };
const TEXT_NULL: SqliteColumn = { type: 'TEXT', nullable: true };
const INT: SqliteColumn = { type: 'INTEGER', nullable: false };
const INT_NULL: SqliteColumn = { type: 'INTEGER', nullable: true };

/**
 * The schema, table by table.
 *
 * **Not `STRICT`**, although the 3.46 floor permits it (§4.8 recommends it on
 * hygiene grounds and explicitly denies it fixes the `f64` hazard). A `STRICT`
 * table turns a value Dexie stores without complaint — a float assigned to an
 * integer column, say — into a constraint violation, and `constraint` is the
 * result code that makes the flusher back off or park an entry. Engine-specific
 * *rejection* is the divergence class this whole file exists to prevent, so
 * affinity-with-conversion is the deliberate choice.
 *
 * **Redundant index prefixes are omitted.** Dexie declares `outbox.intentId`,
 * `outbox.state`, and `note_tags.note_id` as standalone indexes alongside
 * `[intentId+revision]`, `[state+leaseUntil]` and the `[note_id+tag_id]`
 * primary key. In SQLite a compound index serves any leftmost-prefix lookup,
 * so every lookup path the contract needs (`listOutbox` by `intentId`, the
 * sibling-intent scan by `[table+key]`, the state scan, reclamation by
 * `[state+leaseUntil]`, links by `note_id`) is served by a declared index
 * below. The standalone copies would only add write amplification to the
 * hottest table in the app — the outbox takes a row per keystroke batch.
 */
export const LOCAL_STORE_SQLITE_SCHEMA: Readonly<Record<LocalTableName, SqliteTableSchema>> = {
  // CachedNote (db.ts) = Note with title/body nullable: a skinny cached
  // tombstone carries the row without its content.
  notes: {
    columns: {
      id: TEXT,
      user_id: TEXT,
      title: TEXT_NULL,
      body: TEXT_NULL,
      folder_id: TEXT_NULL,
      source: TEXT,
      pinned_at: TEXT_NULL,
      pinned_in: TEXT_NULL,
      sync_seq: INT_NULL,
      created_at: TEXT,
      updated_at: TEXT,
      deleted_at: TEXT_NULL,
      short_id: INT_NULL,
    },
    primaryKey: ['id'],
    autoKey: null,
    indexes: [
      { name: 'idx_notes_user_id', columns: ['user_id'] },
      { name: 'idx_notes_folder_id', columns: ['folder_id'] },
      { name: 'idx_notes_updated_at', columns: ['updated_at'] },
    ],
  },
  folders: {
    columns: {
      id: TEXT,
      user_id: TEXT,
      name: TEXT,
      parent_id: TEXT_NULL,
      sync_seq: INT_NULL,
      created_at: TEXT,
      updated_at: TEXT,
      deleted_at: TEXT_NULL,
      pinned_at: TEXT_NULL,
    },
    primaryKey: ['id'],
    autoKey: null,
    indexes: [
      { name: 'idx_folders_user_id', columns: ['user_id'] },
      { name: 'idx_folders_parent_id', columns: ['parent_id'] },
    ],
  },
  tags: {
    columns: {
      id: TEXT,
      user_id: TEXT,
      name: TEXT,
      sync_seq: INT_NULL,
      created_at: TEXT,
      updated_at: TEXT,
      deleted_at: TEXT_NULL,
    },
    primaryKey: ['id'],
    autoKey: null,
    indexes: [
      { name: 'idx_tags_user_id', columns: ['user_id'] },
      { name: 'idx_tags_name', columns: ['name'] },
    ],
  },
  note_tags: {
    columns: {
      note_id: TEXT,
      tag_id: TEXT,
      user_id: TEXT,
      sync_seq: INT_NULL,
      created_at: TEXT,
      updated_at: TEXT,
      deleted_at: TEXT_NULL,
    },
    primaryKey: ['note_id', 'tag_id'],
    autoKey: null,
    // note_id needs no index of its own: it is the primary key's leftmost
    // column. tag_id does.
    indexes: [{ name: 'idx_note_tags_tag_id', columns: ['tag_id'] }],
  },
  // Written only by advanceCursor (`max(cursor, to)`); the contract rejects a
  // put, patch or delete against it.
  sync_cursors: {
    columns: { table: TEXT, cursor: INT },
    primaryKey: ['table'],
    autoKey: null,
    indexes: [],
  },
  // OutboxEntry (db.ts). camelCase column names, matching the Dexie row keys
  // verbatim — the row crosses IPC as-is, so renaming here would be a rename
  // of the wire format.
  outbox: {
    columns: {
      seq: INT,
      intentId: TEXT,
      revision: INT,
      table: TEXT,
      // The row key flattened to a string — `${note_id}:${tag_id}` for a pair.
      key: TEXT,
      op: TEXT,
      payload: { type: 'TEXT', nullable: false, json: true },
      baseSyncSeq: INT_NULL,
      state: TEXT,
      leaseId: TEXT_NULL,
      // Epoch ms.
      leaseUntil: INT_NULL,
      attempts: INT,
      lastError: TEXT_NULL,
      createdAt: INT,
    },
    primaryKey: ['seq'],
    autoKey: 'seq',
    indexes: [
      // The sibling-intent guard and the pull-vs-pending-intent lock. Dexie
      // declares this one as `[table+key]` and nothing standalone on `table`,
      // so an indexed read may not filter on it — see `dexieCompoundOnly`.
      { name: 'idx_outbox_table_key', columns: ['table', 'key'], dexieCompoundOnly: true },
      // Descendant rebasing, and listOutbox by intentId (leftmost prefix).
      { name: 'idx_outbox_intentId_revision', columns: ['intentId', 'revision'] },
      // Crash reclamation, and any scan by state alone (leftmost prefix).
      { name: 'idx_outbox_state_leaseUntil', columns: ['state', 'leaseUntil'] },
    ],
  },
  // IdMapping (db.ts). `owned` and `disposition` are optional on the type:
  // Phase 4 identity rows predate them, Phase 6b adoption rows carry them.
  idMap: {
    columns: {
      table: TEXT,
      localId: TEXT,
      serverId: TEXT,
      owned: TEXT_NULL,
      disposition: TEXT_NULL,
    },
    primaryKey: ['table', 'localId'],
    autoKey: null,
    indexes: [{ name: 'idx_idMap_serverId', columns: ['serverId'] }],
  },
  meta: {
    columns: { key: TEXT, value: TEXT },
    primaryKey: ['key'],
    autoKey: null,
    indexes: [],
  },
  // NoteVersion (packages/core index.ts), as local mode captures it: the note's
  // *previous* title/body, snapshotted before an edit. No `sync_seq` column, and
  // that is the shape rather than an omission — a local version has no server
  // row it could be a revision of, and the conditional ops are confined to the
  // four synced tables anyway.
  note_versions: {
    columns: {
      id: TEXT,
      note_id: TEXT,
      user_id: TEXT,
      title: TEXT,
      body: TEXT,
      created_at: TEXT,
      updated_at: TEXT,
      deleted_at: TEXT_NULL,
    },
    primaryKey: ['id'],
    autoKey: null,
    // The one Dexie declares, and for the same reason: history is listed per
    // note, and the coalescing lookup reads that same note's rows. Ordering by
    // created_at happens in memory — a note has a handful of versions.
    indexes: [{ name: 'idx_note_versions_note_id', columns: ['note_id'] }],
  },
  // Recall (packages/core index.ts) as local mode stores it: a retrieval run
  // with an empty `answer`, or a BYO run carrying one the user's own provider
  // generated. `search_embedding` is server-only and absent here, exactly as it
  // is absent from the Dexie table.
  recalls: {
    columns: {
      id: TEXT,
      user_id: TEXT,
      query: TEXT,
      answer: TEXT,
      // The matched notes, `[{id, title}]` — read whole, mapped over, never
      // compared. Same treatment as the outbox payload.
      sources: { type: 'TEXT', nullable: false, json: true },
      pinned_at: TEXT_NULL,
      created_at: TEXT,
      updated_at: TEXT,
      deleted_at: TEXT_NULL,
    },
    primaryKey: ['id'],
    autoKey: null,
    // None, matching Dexie's `'id'`-only declaration: the list filters, sorts
    // and searches a handful of rows in memory, so an index would cost more
    // than the scan.
    indexes: [],
  },
};

/**
 * The column-type map, as the (de)hydration layer consumes it: for each table,
 * which columns exist, which are opaque JSON, which are INTEGER-backed
 * booleans, and which form the key.
 *
 * This is the **single source** for the read-side materialization contract
 * (`plans/desktop-app.md` §4.4; WP3 brief A4): rows read back must be
 * JS-identical to Dexie's — JSON columns parsed, NULL as `null` and never
 * absent, integers exact. Deriving it from {@link LOCAL_STORE_SQLITE_SCHEMA}
 * rather than restating it is what keeps it from drifting from the DDL.
 */
export interface LocalTableColumnMap {
  readonly columns: readonly string[];
  readonly keyColumns: readonly string[];
  /** Assigned by the store, never by a plan. */
  readonly autoKeyColumn: string | null;
  readonly nullableColumns: readonly string[];
  /** Opaque documents: serialized on write, parsed on read, never compared. */
  readonly jsonColumns: readonly string[];
  /** INTEGER-backed booleans. Empty today — see {@link SqliteColumn.boolean}. */
  readonly booleanColumns: readonly string[];
  readonly integerColumns: readonly string[];
}

function columnMapFor(schema: SqliteTableSchema): LocalTableColumnMap {
  const entries = Object.entries(schema.columns);
  const pick = (test: (column: SqliteColumn) => boolean): readonly string[] =>
    entries.filter(([, column]) => test(column)).map(([name]) => name);
  return {
    columns: entries.map(([name]) => name),
    keyColumns: schema.primaryKey,
    autoKeyColumn: schema.autoKey,
    nullableColumns: pick((c) => c.nullable),
    jsonColumns: pick((c) => c.json === true),
    booleanColumns: pick((c) => c.boolean === true),
    integerColumns: pick((c) => c.type === 'INTEGER'),
  };
}

export const LOCAL_STORE_COLUMN_MAP: Readonly<Record<LocalTableName, LocalTableColumnMap>> =
  Object.fromEntries(
    LOCAL_TABLE_NAMES.map((table) => [table, columnMapFor(LOCAL_STORE_SQLITE_SCHEMA[table])]),
  ) as Record<LocalTableName, LocalTableColumnMap>;

/**
 * Whether `column` exists on `table`.
 *
 * Used by `validateBatchPlan` to reject a column no engine has: on Dexie an
 * unknown key is silently stored (Dexie rows are documents), on SQLite it is
 * an error — divergence again, and this time one that only shows up on the
 * desktop build.
 */
export function isLocalStoreColumn(table: LocalTableName, column: string): boolean {
  // Guarded rather than indexed blindly: `table` reaches this from a plain-JSON
  // plan, and a table name the schema has never heard of must be a `false`, not
  // a TypeError from reading `.columns` of undefined.
  const schema: SqliteTableSchema | undefined = LOCAL_STORE_SQLITE_SCHEMA[table];
  if (!schema) return false;
  return Object.prototype.hasOwnProperty.call(schema.columns, column);
}

/**
 * The columns a row of `table` must carry — every `NOT NULL` column except the
 * one the store assigns (`outbox.seq`).
 *
 * Derived from {@link LOCAL_STORE_SQLITE_SCHEMA}, never restated: this is the
 * same nullability the DDL emits as `NOT NULL`, so the plan boundary refuses
 * exactly what SQLite would have refused, and a column that changes nullability
 * changes both in one edit.
 */
function requiredColumnsFor(map: LocalTableColumnMap): readonly string[] {
  const optional = new Set<string>(map.nullableColumns);
  if (map.autoKeyColumn !== null) optional.add(map.autoKeyColumn);
  return map.columns.filter((column) => !optional.has(column));
}

export const LOCAL_STORE_REQUIRED_COLUMNS: Readonly<Record<LocalTableName, readonly string[]>> =
  Object.fromEntries(
    LOCAL_TABLE_NAMES.map((table) => [table, requiredColumnsFor(LOCAL_STORE_COLUMN_MAP[table])]),
  ) as Record<LocalTableName, readonly string[]>;

/**
 * The columns of `table` an indexed read may filter on — the **intersection of
 * what both engines serve from an index**, never the union.
 *
 * Three rules, and the third is the one that bites:
 *
 * 1. The leftmost column of a declared index. A filter on a *later* column is a
 *    full scan in SQLite and inexpressible in Dexie — divergence arriving as a
 *    performance cliff rather than a wrong answer.
 * 2. A single-column primary key, which is an index in both engines (Dexie's
 *    own primary key, SQLite's PK index) and reads the same way. A compound key
 *    is excluded: pair-key handling is where the two engines differ most, and
 *    nothing needs the lookup.
 * 3. **Not the leftmost column of an index Dexie holds only as a compound**
 *    ({@link SqliteIndex.dexieCompoundOnly}). SQLite serves such a lookup from
 *    the compound index and IndexedDB throws `SchemaError`, so admitting it
 *    would give the desktop a read the browser cannot perform at all. `outbox`
 *    is the live case: Dexie declares `[table+key]` with no standalone `table`,
 *    while `intentId` and `state` *are* declared standalone there and so stay
 *    admissible even though SQLite serves them from compounds.
 *
 * This is what keeps the structural indexed read (`plans/desktop-app.md` §7 item
 * 6, PR B2) from becoming a general query surface — a caller may name a column
 * the schema indexes on both engines, and nothing else — and both sides pin the
 * resulting set literally, so adding an index forces a conscious decision here
 * rather than silently widening a read surface.
 */
export const LOCAL_STORE_INDEXED_COLUMNS: Readonly<Record<LocalTableName, readonly string[]>> =
  Object.fromEntries(
    LOCAL_TABLE_NAMES.map((table) => {
      const schema = LOCAL_STORE_SQLITE_SCHEMA[table];
      const columns = new Set(
        schema.indexes
          .filter((index) => index.dexieCompoundOnly !== true)
          .map((index) => index.columns[0]!),
      );
      if (schema.primaryKey.length === 1 && schema.autoKey === null) {
        columns.add(schema.primaryKey[0]!);
      }
      return [table, [...columns]] as const;
    }),
  ) as unknown as Record<LocalTableName, readonly string[]>;

export function isLocalStoreIndexedColumn(table: LocalTableName, column: string): boolean {
  return (LOCAL_STORE_INDEXED_COLUMNS[table] ?? []).includes(column);
}

/**
 * Whether `column` must hold a value on `table` — the question a `put` asks of
 * every column and a `patch` asks of the ones it assigns `null`.
 *
 * Unknown tables and columns answer `false`: naming them is a different
 * violation, reported by {@link isLocalStoreColumn} at a different point.
 */
export function isLocalStoreColumnRequired(table: LocalTableName, column: string): boolean {
  return (LOCAL_STORE_REQUIRED_COLUMNS[table] ?? []).includes(column);
}

/**
 * Why a value cannot be stored in a column, or null if it can.
 *
 * **This is the compensating control for not declaring the tables `STRICT`.**
 * The DDL relies on column affinity, which silently *converts* a value of the
 * wrong type (a float into an INTEGER column, a number into a TEXT one) rather
 * than rejecting it — chosen deliberately, because engine-specific rejection is
 * the divergence class the whole schema exists to prevent. But silent
 * conversion has to be traded for something, and this is it: the malformed-plan
 * boundary refuses what a STRICT table would have refused, in *both* engines, at
 * the point where it is a programmer error with a stack trace rather than a
 * mystery value on disk.
 *
 * Deliberately narrow. It answers "could this value change shape on the way into
 * that column", nothing else — not whether a timestamp parses, not whether an
 * enum member is known. Those are Zod's, at the boundary where the row is built.
 */
export function localStoreColumnTypeError(
  table: LocalTableName,
  column: string,
  value: unknown,
): string | null {
  const schema: SqliteTableSchema | undefined = LOCAL_STORE_SQLITE_SCHEMA[table];
  const spec = schema?.columns[column];
  if (!spec) return null; // Not this function's question — see isLocalStoreColumn.
  if (value === null) return null;

  if (spec.json === true) {
    // Opaque documents are serialized whole. A scalar here means a caller
    // assigned a column it thinks is a string; SQLite would store it verbatim
    // and the next read would hand JSON.parse something that is not JSON.
    if (typeof value !== 'object') {
      return `${table}.${column} holds an opaque JSON document, not a ${typeof value}`;
    }
    return null;
  }
  if (typeof value === 'boolean') {
    // Rows may carry booleans as JSON, but no column is declared to hold one:
    // SQLite would store 0/1 and every later comparison would read 1 !== true.
    return `${table}.${column} is declared ${spec.type}; SQLite has no boolean storage class, so a boolean would come back as 0 or 1`;
  }
  if (spec.type === 'INTEGER') {
    if (typeof value !== 'number') {
      return `${table}.${column} is declared INTEGER, got ${typeof value}`;
    }
    // INTEGER affinity converts a float that happens to be integral and drops
    // nothing; a genuinely fractional one is stored as REAL in an INTEGER
    // column, which Dexie would have kept as-is and no comparison would match.
    if (!Number.isInteger(value)) {
      return `${table}.${column} is declared INTEGER, got the fractional number ${value}`;
    }
    return null;
  }
  if (typeof value === 'number') {
    return `${table}.${column} is declared TEXT, got the number ${value}`;
  }
  if (typeof value !== 'string') {
    return `${table}.${column} is declared TEXT, got ${typeof value}`;
  }
  return null;
}

/** One emitted migration, in `sqlx::migrate::Migrator` terms. */
export interface SqliteMigration {
  /** Monotonic; the emitted file name is `NNNN_<description>.sql`. */
  readonly version: number;
  /** Snake_case; becomes part of the file name, so it is part of the API. */
  readonly description: string;
  readonly sql: string;
}

/**
 * The header the emitted `.sql` carries. Two things it must say, both of which
 * a reader of the `.sql` alone would otherwise have to guess:
 *
 * 1. It is generated. Editing it is undone by the next emit, and CI notices.
 * 2. **There are no `FOREIGN KEY` constraints, on purpose.** Dexie enforces
 *    none, so declaring them would make SQLite reject rows the browser accepts
 *    — and the rejection is routine, not exceptional: the pull is keyset-paged
 *    per table, so a `note_tags` row can land before the note it points at,
 *    and ops apply in array order inside one batch. Worse, an FK violation
 *    surfaces as `store-error: constraint`, which the flusher reads as a
 *    genuine store failure and backs off from (or parks the entry over).
 *    Referential integrity is the server's job — Postgres declares these FKs
 *    and RLS guards them — and the cache is a projection of it. sqlx's
 *    connection defaults turn `foreign_keys=ON`, which is harmless precisely
 *    because none are declared, so the pragma needs no override.
 */
export const DDL_HEADER = `-- GENERATED FILE — do not edit.
--
-- Emitted from packages/core/src/sqlite-ddl.ts by
-- \`pnpm --filter @kinjot/core emit:sqlite-ddl\`. The schema is authored once,
-- in TypeScript, next to the Zod row schemas, because Dexie (browser) and
-- SQLite (desktop) implement one frozen LocalStore contract and a column that
-- exists in only one engine is an invisible divergence. CI re-runs the emit and
-- fails on any diff, so editing this file by hand does nothing but redden a PR.
--
-- Targets SQLite 3.46.0, the asserted floor across all three engines that run
-- this DDL (plans/desktop-app.md §4.8).
--
-- NO FOREIGN KEY CONSTRAINTS, deliberately. Dexie enforces none, so declaring
-- them here would make SQLite reject rows the browser accepts — and the
-- rejection would be routine rather than exceptional: the pull is keyset-paged
-- per table, so a note_tags row can arrive before the note it references, and
-- ops inside one batch apply in array order. An FK violation would also surface
-- as \`store-error: constraint\`, which the outbox flusher treats as a real store
-- failure to back off from or park an entry over — turning a routine race into
-- stalled user data. Referential integrity belongs to the server (Postgres
-- declares these relationships); this database is a projection of it. sqlx's
-- default \`foreign_keys=ON\` is therefore harmless: there are none to enforce.`;

/** Migration 2's own preamble: why two tables arrive after the first eight. */
const V2_NOTE = `-- Phase 8 WP6: the two tables a LOCAL library holds and a signed-in cache does
-- not. Local version history and saved Recall answers are local mode's own
-- content — no server row stands behind either, and neither ever syncs — so
-- they carry no sync_seq and the pull's conditional ops cannot target them.
--
-- A separate migration rather than an edit to 0001: that file's checksum is
-- already recorded in _sqlx_migrations on every library on disk, and sqlx
-- refuses to open a database whose applied migration no longer matches. Purely
-- additive, so an existing library migrates forward with every row intact.`;

/**
 * Migration 3 adds the server's per-user alias to desktop libraries. Shipped
 * migrations are never edited (sqlx checksums the whole file, comments
 * included), so this note states only what stays true.
 */
const V3_NOTE = `-- notes.short_id holds the per-user alias the server allocates, shown as a
-- label such as A10. A signed-in workspace stores the value it pulls; nothing
-- allocates one locally, so a local-mode note holds NULL. The UUID remains the
-- note's primary key.`;

function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function columnDefinition(name: string, column: SqliteColumn, autoKey: boolean): string {
  if (autoKey) return `${quote(name)} INTEGER PRIMARY KEY AUTOINCREMENT`;
  return `${quote(name)} ${column.type}${column.nullable ? '' : ' NOT NULL'}`;
}

function addedColumnDefinition(version: number, table: LocalTableName, name: string): string {
  const declared = ADDED_COLUMNS.some(
    (added) => added.version === version && added.table === table && added.column === name,
  );
  const column = LOCAL_STORE_SQLITE_SCHEMA[table].columns[name];
  if (!declared || !column || !column.nullable) {
    throw new Error(`migration ${version} must add a declared nullable column: ${table}.${name}`);
  }
  // ADD COLUMN without a default must accept the existing rows in a non-empty library.
  return columnDefinition(name, column, false);
}

/**
 * Renders one table's `CREATE TABLE` plus its indexes.
 *
 * Deterministic by construction — declaration order, one shape of whitespace,
 * every identifier quoted — because the drift gate compares bytes.
 */
export function renderTableSql(table: string, schema: SqliteTableSchema): string {
  const lines = Object.entries(schema.columns).map(
    ([name, column]) => `  ${columnDefinition(name, column, schema.autoKey === name)},`,
  );
  // AUTOINCREMENT already declares the key inline, and SQLite rejects a second
  // PRIMARY KEY clause alongside it.
  if (schema.autoKey === null) {
    lines.push(`  PRIMARY KEY (${schema.primaryKey.map(quote).join(', ')}),`);
  }
  const body = lines.join('\n').replace(/,$/, '');
  const create = `CREATE TABLE ${quote(table)} (\n${body}\n);`;
  const indexes = schema.indexes.map(
    (index) =>
      `CREATE INDEX ${quote(index.name)} ON ${quote(table)} (${index.columns
        .map(quote)
        .join(', ')});`,
  );
  return [create, ...indexes].join('\n');
}

/**
 * The DDL body for `tables`, in the order given — the whole schema by default,
 * and one migration's slice of it when a caller names one.
 */
export function renderSchemaSql(
  tables: readonly LocalTableName[] = LOCAL_TABLE_NAMES,
  asOf = Number.POSITIVE_INFINITY,
): string {
  return tables
    .map((table) => {
      const schema = LOCAL_STORE_SQLITE_SCHEMA[table];
      const columns = Object.fromEntries(
        Object.entries(schema.columns).filter(
          ([column]) =>
            !ADDED_COLUMNS.some(
              (added) => added.table === table && added.column === column && added.version > asOf,
            ),
        ),
      );
      return renderTableSql(table, { ...schema, columns });
    })
    .join('\n\n');
}

/**
 * The migration list Rust runs, newest last.
 *
 * Migrations are **additive and never edited once shipped**, exactly like
 * `supabase/migrations`: a shipped file has already run against a real
 * `_sqlx_migrations` row on a user's disk, and sqlx compares checksums.
 */
export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    description: 'local_store_schema',
    sql: `${DDL_HEADER}\n\n${renderSchemaSql(V1_TABLE_NAMES, 1)}\n`,
  },
  {
    version: 2,
    description: 'local_versions_and_recalls',
    sql: `${DDL_HEADER}\n\n${V2_NOTE}\n\n${renderSchemaSql(V2_TABLE_NAMES, 2)}\n`,
  },
  {
    version: 3,
    description: 'note_short_ids',
    sql: `${DDL_HEADER}\n\n${V3_NOTE}\n\nALTER TABLE "notes" ADD COLUMN ${addedColumnDefinition(3, 'notes', 'short_id')};\n`,
  },
];

/** `0001_local_store_schema.sql` — the name sqlx parses a version out of. */
export function migrationFileName(migration: SqliteMigration): string {
  return `${String(migration.version).padStart(4, '0')}_${migration.description}.sql`;
}
