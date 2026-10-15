// The two-process get-or-create race (plans/desktop-app.md WP6, §4.9, §6, §9).
// Separate OS processes exercise contention an in-process test cannot reach.
//
// What it proves: several **genuinely separate OS processes** writing
// `kinjot add`-shaped notes into one local library, all claiming the same
// folder names and the same tag names at the same moment, end with exactly one
// folder per name, exactly one tag per name, every note present and correctly
// linked, and no `SQLITE_BUSY` surfaced to any of them.
//
// What makes that true is three things, and this test fails if any of them is
// removed: WAL (set by the desktop app at creation), the explicit
// `busy_timeout` on the CLI's own connection (§4.3 — sqlx's defaults cover the
// app's connections only), and the get-or-create *reads* running inside
// `BEGIN IMMEDIATE`. With the folder/tag lookups outside the transaction, every
// process reads "no folder named Race 0", every process plans one, and every
// process inserts one — N folders with the same name, **no error anywhere**,
// and no unique index in the SQLite schema to object. Verified by moving those
// reads back out in a working tree: this test then reports duplicate folders
// and duplicate tags, while `save-note.test.ts` and the conformance suite stay
// green, because both are single-process.
//
// The children run a real build of this package rather than its sources — see
// `race-child.mjs` for why, and `buildPackage` below for how.
//
// §4.9's Windows/MSIX race, with the desktop app holding the file open through
// its sqlx pool, is a manual runbook (`apps/desktop/README.md`, "Two-process
// race runbook"), not this file: a Linux child-process race exercises SQLite's
// locking, not WebView2, AV scanners or MSIX redirection.

import { execFileSync } from 'node:child_process';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openLocalLibrary, type LocalLibrary } from './library.js';
import { makeLibraryFixture } from './library-fixture.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '..', '..');
const CHILD = join(HERE, 'race-child.mjs');

/** Enough processes to make losing the write lock the common case, not the rare one. */
const CHILDREN = 4;
/** Each child writes this many notes, contending on every folder and tag name. */
const NOTES_PER_CHILD = 6;
/** Carried by every note of every child — the single hottest get-or-create in the run. */
const SHARED_TAG = 'race';

interface RaceNote {
  readonly title: string;
  readonly folder: string;
  readonly tags: string[];
}

/**
 * The work list every child runs, in the same order.
 *
 * Identical across children on purpose: child 0's note 3 and child 3's note 3
 * ask for the same brand-new folder and the same brand-new tag, so the window
 * between "does Race 3 exist?" and "insert Race 3" is contended by four
 * processes rather than by chance.
 */
const NOTES: RaceNote[] = Array.from({ length: NOTES_PER_CHILD }, (_, index) => ({
  title: `note ${index}`,
  folder: `Race ${index}`,
  tags: [`race-${index}`, SHARED_TAG],
}));

/**
 * Compiles this package with its own `tsconfig.build.json` into
 * `node_modules/.cache/`, and hands the children that.
 *
 * Inside the package tree because the build imports `zod` and relies on
 * `"type": "module"`; under `node_modules/` because that is already ignored by
 * git and by eslint. `pnpm --filter kinjot build` is deliberately not reused —
 * the test must not depend on a `dist/` someone built three commits ago, and
 * must not clobber it either.
 */
function buildPackage(): string {
  const out = join(PACKAGE_ROOT, 'node_modules', '.cache', 'kinjot-race-build');
  rmSync(out, { recursive: true, force: true });
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  try {
    execFileSync(
      process.execPath,
      [tsc, '-p', join(PACKAGE_ROOT, 'tsconfig.build.json'), '--outDir', out],
      { stdio: 'pipe' },
    );
  } catch (error) {
    // tsc writes its diagnostics to stdout, which execFileSync's error omits.
    const stdout = (error as { stdout?: Buffer }).stdout?.toString() ?? '';
    throw new Error(`race-test build failed:\n${stdout}`, { cause: error });
  }
  return out;
}

interface ChildOutcome {
  readonly label: string;
  readonly ids: string[];
  readonly code: number | null;
  readonly stderr: string;
}

/**
 * Runs one race and returns what every child reported.
 *
 * The barrier is what makes it a race: each child opens the library (the §5.3
 * handshake, which reads the pointer and several pragmas — far slower than the
 * writes) and then *waits*, and only when all of them are ready does the parent
 * release them together. Without it the first child would routinely be finished
 * before the last one had loaded `node:sqlite`.
 */
async function race(buildDir: string, configDir: string): Promise<ChildOutcome[]> {
  const labels = Array.from({ length: CHILDREN }, (_, index) => `child-${index}`);
  const children = new Map<string, ChildProcess>();
  const stderr = new Map<string, string>();
  const ids = new Map<string, string[]>();

  const ready: Promise<void>[] = [];
  const finished: Promise<ChildOutcome>[] = [];

  for (const label of labels) {
    const child = fork(CHILD, [buildDir, configDir, label], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, KINJOT_CONFIG_DIR: configDir },
    });
    children.set(label, child);
    stderr.set(label, '');
    child.stderr?.on('data', (chunk: Buffer) =>
      stderr.set(label, stderr.get(label)! + chunk.toString()),
    );

    ready.push(
      new Promise<void>((resolve, reject) => {
        child.on('message', (message: { type?: string; ids?: string[] }) => {
          if (message?.type === 'ready') resolve();
          if (message?.type === 'done') ids.set(label, message.ids ?? []);
        });
        // A child that dies during the handshake must not hang the barrier.
        child.on('close', () => reject(new Error(`${label} exited early: ${stderr.get(label)}`)));
        // And a child that cannot be forked or spoken to must fail the test
        // with its name on it, not crash the vitest worker: an unhandled
        // 'error' event on a ChildProcess throws process-wide, and `send()` on
        // a closed IPC channel is exactly such an event.
        child.on('error', (error) => reject(new Error(`${label} failed: ${String(error)}`)));
      }),
    );

    // `close`, never `exit`. `exit` fires when the process ends, which can be
    // *before* the parent has drained the IPC channel and the stderr pipe — so
    // reading either there is a race the test would lose intermittently, and
    // both of them are things this test asserts on. `close` is emitted only
    // once every stdio stream (the IPC channel among them) has reached EOF.
    finished.push(
      new Promise<ChildOutcome>((resolve) => {
        child.on('close', (code) =>
          resolve({ label, ids: ids.get(label) ?? [], code, stderr: stderr.get(label)! }),
        );
      }),
    );
  }

  // A hung child would otherwise park the test on vitest's own timeout and
  // orphan the other three processes past the run's end.
  const watchdog = setTimeout(() => {
    for (const child of children.values()) child.kill();
  }, 60_000);
  try {
    await Promise.all(ready);
    for (const [label, child] of children) {
      child.send({ type: 'go', notes: NOTES }, (error) => {
        // Routed to stderr so the failure carries the child's name; the exit
        // code / missing-ids assertions are what fail the test.
        if (error) stderr.set(label, `${stderr.get(label)!}send(go) failed: ${String(error)}\n`);
      });
    }
    return await Promise.all(finished);
  } catch (error) {
    for (const child of children.values()) child.kill();
    throw error;
  } finally {
    clearTimeout(watchdog);
  }
}

function rows(library: LocalLibrary, sql: string): Record<string, unknown>[] {
  return library.db.prepare(sql).all();
}

describe('two-process get-or-create race', () => {
  let buildDir: string;
  let dir: string;

  beforeAll(() => {
    buildDir = buildPackage();
  }, 180_000);

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('leaves one folder and one tag per name, every note linked, and no SQLITE_BUSY', async () => {
    // Pass a throwaway config root instead of the developer's ~/.kinjot. The
    // children read the directory argument; they also receive KINJOT_CONFIG_DIR.
    dir = mkdtempSync(join(tmpdir(), 'kinjot-race-'));
    makeLibraryFixture(dir);

    const outcomes = await race(buildDir, dir);

    for (const outcome of outcomes) {
      expect(
        { label: outcome.label, code: outcome.code, stderr: outcome.stderr },
        `${outcome.label} must exit cleanly`,
      ).toMatchObject({ code: 0 });
      // The failure plans/desktop-app.md §8 names: two processes racing
      // get-or-create without busy_timeout surface SQLITE_BUSY as a failed jot.
      // Nothing may reach the user, so nothing may reach stderr either.
      expect(outcome.stderr).not.toMatch(/SQLITE_BUSY|database is locked|is busy/i);
      expect(outcome.ids, `${outcome.label} must report every id it wrote`).toHaveLength(
        NOTES_PER_CHILD,
      );
    }

    const library = openLocalLibrary(dir);
    try {
      const folders = rows(library, `SELECT "id", "name" FROM "folders"`);
      const tags = rows(library, `SELECT "id", "name" FROM "tags"`);
      const notes = rows(library, `SELECT "id", "title", "folder_id" FROM "notes"`);
      const noteTags = rows(library, `SELECT "note_id", "tag_id" FROM "note_tags"`);

      // One folder per contended name — the whole point. A duplicate here is
      // the get-or-create read escaping the write transaction.
      expect(folders.map((folder) => folder.name).sort()).toEqual(
        NOTES.map((note) => note.folder).sort(),
      );
      // Same for tags: the per-index ones plus the one every note carries.
      expect(tags.map((tag) => tag.name).sort()).toEqual(
        [...NOTES.map((note) => note.tags[0]!), SHARED_TAG].sort(),
      );

      // Every child's every note survived — a race that lost writes would pass
      // the two assertions above.
      expect(notes).toHaveLength(CHILDREN * NOTES_PER_CHILD);
      const written = new Set(outcomes.flatMap((outcome) => outcome.ids));
      expect(new Set(notes.map((note) => note.id))).toEqual(written);

      // ...and each landed in *the* folder for its name, not in a private copy.
      const folderById = new Map(folders.map((folder) => [folder.id, folder.name]));
      for (const note of notes) {
        const index = String(note.title).match(/note (\d+)$/)?.[1];
        expect(folderById.get(note.folder_id)).toBe(`Race ${index}`);
      }

      // Two links per note, both to the shared tag rows.
      const tagById = new Map(tags.map((tag) => [tag.id, tag.name]));
      expect(noteTags).toHaveLength(CHILDREN * NOTES_PER_CHILD * 2);
      const linksByNote = new Map<unknown, string[]>();
      for (const link of noteTags) {
        linksByNote.set(link.note_id, [
          ...(linksByNote.get(link.note_id) ?? []),
          String(tagById.get(link.tag_id)),
        ]);
      }
      for (const note of notes) {
        const index = String(note.title).match(/note (\d+)$/)?.[1];
        expect(linksByNote.get(note.id)?.sort()).toEqual([`race-${index}`, SHARED_TAG].sort());
      }
    } finally {
      library.close();
    }
  }, 120_000);
});
