// The two runtime floors local mode depends on, asserted before anything
// touches a library (plans/desktop-app.md §4.6, §4.8).
//
// These checks run only in local mode. The account path never loads
// node:sqlite, so it does not need the SQLite runtime checks.

import { createRequire } from 'node:module';

/**
 * The `engines.node` range, duplicated here on purpose: `engines` is advisory
 * in npm by default, so a user can install and run on 20.x with nothing but a
 * warning, and would then meet `ERR_UNKNOWN_BUILTIN_MODULE` instead of a
 * sentence naming the fix (§4.6).
 *
 * It is **not a single floor**. `node:sqlite` was unflagged in 22.13.0 *and*
 * in 23.4.0, so 23.0–23.3 admits the range's lower bound while still requiring
 * `--experimental-sqlite`. The gap is encoded below rather than smoothed over.
 */
export const NODE_ENGINE_RANGE = '>=22.13.0 <23.0.0 || >=23.4.0';

/** The asserted SQLite floor across all three engines that run the DDL (§4.8). */
export const SQLITE_FLOOR = '3.46.0';

/** `-1 | 0 | 1` over dotted numeric versions; trailing labels are ignored. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): number[] =>
    value
      .split('-')[0]!
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

/** Whether `version` satisfies {@link NODE_ENGINE_RANGE}. */
export function nodeSupportsSqlite(version: string): boolean {
  if (compareVersions(version, '22.13.0') < 0) return false;
  if (compareVersions(version, '23.0.0') >= 0 && compareVersions(version, '23.4.0') < 0) {
    return false;
  }
  return true;
}

/**
 * Raised by everything on the local path. Carries no code: every message is
 * written to be the whole explanation, because the CLI prints exactly one line.
 */
export class LocalModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalModeError';
  }
}

export function assertNodeSupportsSqlite(version: string = process.versions.node): void {
  if (nodeSupportsSqlite(version)) return;
  throw new LocalModeError(
    `local mode needs Node ${NODE_ENGINE_RANGE} (node:sqlite is unavailable or still ` +
      `behind --experimental-sqlite on older builds); this is Node ${version}. ` +
      `Upgrade Node, or use kinjot with an API key (\`kinjot use account\`).`,
  );
}

/** The slice of `node:sqlite` this package uses, typed by hand. */
export interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface SqliteDatabaseOptions {
  readonly readOnly?: boolean;
  readonly enableForeignKeyConstraints?: boolean;
}

export type SqliteDatabaseConstructor = new (
  path: string,
  options?: SqliteDatabaseOptions,
) => SqliteDatabase;

/**
 * Loads `node:sqlite`.
 *
 * Through `createRequire` rather than a static import for the reason
 * `packages/core/src/sqlite-ddl.test.ts` documents: Vite rewrites a bare
 * `node:sqlite` specifier to `sqlite` and then fails to resolve it, so a
 * static import would make every vitest run of this package fail on a module
 * the CLI itself loads fine. The require is inside the function so that
 * importing this module costs nothing on the account path.
 */
export function loadSqlite(nodeVersion: string = process.versions.node): SqliteDatabaseConstructor {
  assertNodeSupportsSqlite(nodeVersion);
  try {
    return (
      createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: SqliteDatabaseConstructor }
    ).DatabaseSync;
  } catch (error) {
    throw new LocalModeError(
      `local mode could not load node:sqlite on Node ${nodeVersion} (${String(error)}). ` +
        `It needs Node ${NODE_ENGINE_RANGE}.`,
    );
  }
}

/**
 * Asserts §4.8's floor against the SQLite the running Node bundles.
 *
 * The floor is the invariant, not the number a given Node happens to carry:
 * the DDL this CLI writes rows into was authored against 3.46.0, and the point
 * of asserting is that a future Node dropping below it fails here rather than
 * six months later on someone's machine.
 */
export function assertSqliteFloor(version: string): void {
  if (compareVersions(version, SQLITE_FLOOR) >= 0) return;
  throw new LocalModeError(
    `local mode needs SQLite >= ${SQLITE_FLOOR}; the SQLite bundled with Node ` +
      `${process.versions.node} is ${version}. Upgrade Node.`,
  );
}

/** The `sqlite_version()` of an open connection. */
export function sqliteVersionOf(db: SqliteDatabase): string {
  const row = db.prepare('SELECT sqlite_version() AS version').get();
  const version = row?.version;
  if (typeof version !== 'string') {
    throw new LocalModeError('local mode could not read the SQLite version from node:sqlite.');
  }
  return version;
}
