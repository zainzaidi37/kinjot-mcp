import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pointerPath, readPointer, POINTER_VERSION } from './pointer.js';

/**
 * The CLI's half of `~/.kinjot/local-library.json`, against the **app's** bytes.
 *
 * Until this file existed, every test of this reader read a pointer the CLI's
 * own fixture had written (`library-fixture.ts`), so the Rust writer and the TS
 * reader had never met: the shape lived in three independent declarations
 * (`apps/desktop/src-tauri/src/pointer.rs`, this module, and the webview's Zod
 * schema) with nothing comparing them. `packages/core/fixtures/local-pointer/v1.json`
 * is the one literal all three now read — written in the exact form
 * `serde_json::to_string_pretty` produces, field order included, so "the CLI
 * parses the fixture" is a statement about what the app actually writes.
 *
 * The public mirror runs these tests too. `emit:mcp-core` copies the shared
 * bytes into src/core/fixtures; the monorepo's generator drift test and CI
 * keep that copy equal to the original. Reading relative to this file works
 * in either checkout. Neither build emits this unimported JSON into dist.
 */
const GOLDEN = readFileSync(
  new URL('../core/fixtures/local-pointer/v1.json', import.meta.url),
  'utf8',
);

/** A config root holding `contents` as its pointer file. */
function rootWith(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'kinjot-pointer-'));
  writeFileSync(pointerPath(dir), contents);
  return dir;
}

/** The golden pointer as data, for the cases that vary one field. */
const golden = JSON.parse(GOLDEN) as Record<string, unknown>;

function withGolden(overrides: Record<string, unknown>): string {
  return JSON.stringify({ ...golden, ...overrides });
}

function without(key: string): string {
  const copy = { ...golden };
  delete copy[key];
  return JSON.stringify(copy);
}

describe('the shared pointer fixture', () => {
  it("is the app writer's bytes, field order included", () => {
    // serde emits the struct's declaration order (`pointer.rs`), two-space
    // pretty, newline-terminated. Pinned because the fixture's whole claim is
    // "this is what the app wrote" — a hand-tidied copy would be a fifth
    // independent declaration wearing a fixture's clothes.
    expect(Object.keys(golden)).toEqual(['version', 'db_path', 'workspace_uuid', 'schema_version']);
    expect(GOLDEN).toBe(`${JSON.stringify(golden, null, 2)}\n`);
  });

  it('parses through the reader the CLI actually uses', () => {
    // The assertion the two sides never made before: the app's bytes, the CLI's
    // parser, no fixture of the CLI's own in between.
    expect(readPointer(rootWith(GOLDEN))).toEqual({
      version: POINTER_VERSION,
      db_path: '/home/example/.kinjot/local/library.db',
      workspace_uuid: '6f8a1c3e-1d2b-4a5c-9e7f-0b1c2d3e4f50',
      schema_version: 2,
    });
  });
});

describe('readPointer refuses a pointer it cannot trust', () => {
  // Every case here is a **refusal**, never a fall-through to the account path:
  // that fall-through is the §5.4 privacy violation the pointer exists to
  // prevent. The prose is contract — `library.test.ts` asserts three of these
  // four messages through `openLocalLibrary` — so the cases below pin the
  // message, not just the throw.

  it('says to run the desktop app when there is no pointer at all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kinjot-pointer-'));
    expect(() => readPointer(dir)).toThrow(/local capture requires the desktop app/);
  });

  it('refuses unparseable bytes rather than treating them as "no local library"', () => {
    expect(() => readPointer(rootWith('{ not json'))).toThrow(/is not valid JSON/);
  });

  it('refuses a missing key', () => {
    for (const key of ['version', 'db_path', 'workspace_uuid', 'schema_version']) {
      expect(() => readPointer(rootWith(without(key))), key).toThrow(/has an unexpected shape/);
    }
  });

  it('refuses a key of the wrong type', () => {
    expect(() => readPointer(rootWith(withGolden({ version: '1' })))).toThrow(
      /has an unexpected shape/,
    );
    expect(() => readPointer(rootWith(withGolden({ db_path: 42 })))).toThrow(
      /has an unexpected shape/,
    );
    expect(() => readPointer(rootWith(withGolden({ workspace_uuid: null })))).toThrow(
      /has an unexpected shape/,
    );
    expect(() => readPointer(rootWith(withGolden({ schema_version: [] })))).toThrow(
      /has an unexpected shape/,
    );
  });

  it('refuses an empty db_path or workspace_uuid', () => {
    // Present-but-empty is its own case and not a pedantic one: an empty
    // `db_path` would otherwise be carried to a path join, and an empty
    // `workspace_uuid` would be compared against `meta` and mismatch with a
    // message naming nothing. Both are a rewrite by the app, not a diagnosis.
    expect(() => readPointer(rootWith(withGolden({ db_path: '' })))).toThrow(
      /has an unexpected shape/,
    );
    expect(() => readPointer(rootWith(withGolden({ workspace_uuid: '' })))).toThrow(
      /has an unexpected shape/,
    );
  });

  it('refuses a JSON value that is not an object', () => {
    expect(() => readPointer(rootWith('null'))).toThrow(/has an unexpected shape/);
    expect(() => readPointer(rootWith('[]'))).toThrow(/has an unexpected shape/);
  });

  it('tolerates a key it does not know', () => {
    // The one drift direction that is not a refusal, stated on purpose: a
    // future app adding a fifth key must not break every CLI already installed.
    // That is what `version` is for, and it is the next case.
    expect(readPointer(rootWith(withGolden({ channel: 'msix' }))).db_path).toBe(golden.db_path);
  });

  it('says to update the CLI when the pointer format is newer', () => {
    expect(() => readPointer(rootWith(withGolden({ version: POINTER_VERSION + 1 })))).toThrow(
      /Update the CLI/,
    );
  });
});
