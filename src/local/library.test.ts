import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openLocalLibrary, BUSY_TIMEOUT_MS, MAX_SUPPORTED_SCHEMA_VERSION } from './library.js';
import {
  DatabaseSync,
  FIXTURE_WORKSPACE,
  holdLocked,
  makeLibraryFixture,
} from './library-fixture.js';
import { pointerPath } from './pointer.js';
import {
  assertSqliteFloor,
  compareVersions,
  loadSqlite,
  nodeSupportsSqlite,
  LocalModeError,
  NODE_ENGINE_RANGE,
  type SqliteDatabase,
} from './runtime.js';

/**
 * The plans/desktop-app.md §5.3 handshake, from the CLI's side.
 *
 * Fixture libraries are built **by the test**, never by product code: §5.3
 * forbids the CLI from creating a database, so the only way to exercise the
 * handshake is for the harness to play the desktop app — the canonical DDL
 * from the vendored core, WAL, a `_sqlx_migrations` history and a `meta`
 * identity, which is exactly what `apps/desktop/src-tauri/src/library.rs`
 * leaves on disk.
 */

const WORKSPACE = FIXTURE_WORKSPACE;
const makeLibrary = makeLibraryFixture;
// The lock-contention tests below fork a holder and can wait out the 5 s busy
// bound, so each keeps its own 30 s limit: the public kinjot-mcp mirror runs
// src/ without this package's vitest.config.ts (#1121).

function pragma(db: SqliteDatabase, name: string): unknown {
  return Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0];
}

/**
 * A fingerprint of everything a write to a WAL library could touch: the main
 * file plus its `-wal` when one exists (a write lands there first).
 */
function fingerprint(dbPath: string): string {
  const hash = createHash('sha256').update(readFileSync(dbPath));
  const wal = `${dbPath}-wal`;
  hash.update(existsSync(wal) ? readFileSync(wal) : 'no-wal');
  return hash.digest('hex');
}

describe('runtime floors', () => {
  it('encodes the 23.0–23.3 gap, not a single floor (§4.6)', () => {
    for (const bad of ['18.20.4', '20.19.0', '22.12.0', '23.0.0', '23.3.9']) {
      expect(nodeSupportsSqlite(bad), bad).toBe(false);
    }
    for (const good of ['22.13.0', '22.20.1', '24.18.0', '26.0.0']) {
      expect(nodeSupportsSqlite(good), good).toBe(true);
    }
  });

  it('fails with the range in the message, not ERR_UNKNOWN_BUILTIN_MODULE', () => {
    expect(() => loadSqlite('20.19.0')).toThrow(LocalModeError);
    expect(() => loadSqlite('20.19.0')).toThrow(NODE_ENGINE_RANGE);
  });

  it('asserts the 3.46.0 SQLite floor (§4.8)', () => {
    expect(() => assertSqliteFloor('3.45.3')).toThrow(/3\.46\.0/);
    expect(() => assertSqliteFloor('3.46.0')).not.toThrow();
    expect(() => assertSqliteFloor('3.53.1')).not.toThrow();
    expect(compareVersions('3.9.0', '3.46.0')).toBe(-1);
  });

  it('the Node this suite runs on clears both floors', () => {
    expect(nodeSupportsSqlite(process.versions.node)).toBe(true);
  });
});

describe('the pointer handshake', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kinjot-lib-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens the library the pointer names and reports its identity and schema version', () => {
    const fixture = makeLibrary(dir);
    const library = openLocalLibrary(dir);
    try {
      expect(library.path).toBe(fixture.dbPath);
      expect(library.workspaceId).toBe(WORKSPACE);
      expect(library.schemaVersion).toBe(MAX_SUPPORTED_SCHEMA_VERSION);
    } finally {
      library.close();
    }
  });

  it('sets foreign_keys and busy_timeout explicitly — sqlx covers the app only (§4.3)', () => {
    makeLibrary(dir);
    const library = openLocalLibrary(dir);
    try {
      expect(pragma(library.db, 'foreign_keys')).toBe(1);
      expect(pragma(library.db, 'busy_timeout')).toBe(5000);
    } finally {
      library.close();
    }
  });

  it('an absent pointer says to run the desktop app once', () => {
    expect(() => openLocalLibrary(dir)).toThrow(/local capture requires the desktop app/);
  });

  it('a dangling db_path is a hard error that never falls through to the server', () => {
    makeLibrary(dir);
    rmSync(join(dir, 'local'), { recursive: true, force: true });
    let message = '';
    try {
      openLocalLibrary(dir);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(join(dir, 'local', 'library.db'));
    expect(message).toContain('nothing was sent to the server');
    // And the refusal did not mint the library it was pointed at.
    expect(existsSync(join(dir, 'local', 'library.db'))).toBe(false);
  });

  it('an unparseable pointer is a hard error, not "no local library"', () => {
    writeFileSync(pointerPath(dir), '{ not json');
    expect(() => openLocalLibrary(dir)).toThrow(/not valid JSON/);
  });

  it('a pointer written by a newer app says to update the CLI', () => {
    makeLibrary(dir, { pointer: { version: 2 } });
    expect(() => openLocalLibrary(dir)).toThrow(/Update the CLI/);
  });

  it('refuses a library that is not in WAL — a corrupt installation, never "fixed"', () => {
    makeLibrary(dir, { wal: false });
    expect(() => openLocalLibrary(dir)).toThrow(/not in WAL mode/);
  });

  it('refuses when the pointer and meta disagree about the workspace', () => {
    makeLibrary(dir, { pointer: { workspace_uuid: '22222222-2222-4222-8222-222222222222' } });
    expect(() => openLocalLibrary(dir)).toThrow(/disagree about which workspace/);
  });

  it('refuses when the pointer and _sqlx_migrations disagree about the schema version', () => {
    makeLibrary(dir, { pointer: { schema_version: MAX_SUPPORTED_SCHEMA_VERSION - 1 } });
    expect(() => openLocalLibrary(dir)).toThrow(/disagree about its schema version/);
  });

  it('refuses a library newer than this CLI understands', () => {
    makeLibrary(dir, { schemaVersion: MAX_SUPPORTED_SCHEMA_VERSION + 1 });
    expect(() => openLocalLibrary(dir)).toThrow(/newer than this CLI understands/);
  });

  it('accepts a library one migration behind — the four tables it writes are v1', () => {
    makeLibrary(dir, { schemaVersion: 1 });
    const library = openLocalLibrary(dir);
    try {
      expect(library.schemaVersion).toBe(1);
    } finally {
      library.close();
    }
  });

  // Both contention tests hold the file from a forked process, because the
  // opener sleeps inside SQLite's busy handler and nothing in this event loop
  // could release the lock while it waits (plans/local-library-open-busy-timeout.md §3).
  it('waits out contention shorter than its bound instead of refusing (#400)', async () => {
    const fixture = makeLibrary(dir);
    const releaseAfterMs = 300;
    const holder = await holdLocked(fixture.dbPath, { releaseAfterMs });
    try {
      const started = Date.now();
      // Before the reorder this threw at once with "could not be read
      // (database is locked)": the version query loaded the schema, and so
      // read the file, before `busy_timeout` was set.
      const library = openLocalLibrary(dir);
      try {
        // Only "waited" versus "never blocked" matters here; before the
        // reorder the open failed at 0 ms, so half the hold is a wide margin.
        expect(Date.now() - started).toBeGreaterThanOrEqual(releaseAfterMs / 2);
        expect(library.workspaceId).toBe(WORKSPACE);
        expect(pragma(library.db, 'busy_timeout')).toBe(BUSY_TIMEOUT_MS);
      } finally {
        library.close();
      }
    } finally {
      holder.kill();
    }
  }, 30_000);

  it('refuses contention longer than its bound, names the lock, and writes nothing', async () => {
    const fixture = makeLibrary(dir);
    const holder = await holdLocked(fixture.dbPath);
    try {
      const before = fingerprint(fixture.dbPath);
      const started = Date.now();
      let error: unknown;
      try {
        openLocalLibrary(dir);
      } catch (caught) {
        error = caught;
      }
      const elapsed = Date.now() - started;
      expect(error).toBeInstanceOf(LocalModeError);
      const message = (error as Error).message;
      expect(message).toMatch(/locked/);
      expect(message).toContain('nothing was written');
      expect(message).not.toContain('recreate');
      // The bound is the constant's real value; no private override exists to
      // shorten it for a test, which is why this one costs five seconds.
      expect(elapsed).toBeGreaterThanOrEqual(BUSY_TIMEOUT_MS - 100);
      expect(fingerprint(fixture.dbPath)).toBe(before);
    } finally {
      holder.kill();
    }
  }, 30_000);

  it('refuses a database that is not a Kinjot library at all', () => {
    mkdirSync(join(dir, 'local'), { recursive: true });
    const dbPath = join(dir, 'local', 'library.db');
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('CREATE TABLE something (id TEXT)');
    db.close();
    writeFileSync(
      pointerPath(dir),
      JSON.stringify({ version: 1, db_path: dbPath, workspace_uuid: WORKSPACE, schema_version: 2 }),
    );
    expect(() => openLocalLibrary(dir)).toThrow(/does not look like a Kinjot library/);
  });
});
