// The CLI's half of the pointer file (plans/desktop-app.md §5.3; the app's half
// is `apps/desktop/src-tauri/src/pointer.rs`).
//
// The app writes `~/.kinjot/local-library.json` on every launch, naming the
// database it actually opened plus that library's identity and schema version.
// This module only *reads and parses* it — the handshake that decides whether
// the named file may be written to lives in `library.ts`, because the pointer
// is a hint and never an authority.
//
// Two rules from §5.3 that are easy to lose and are enforced here:
//
//   * a **missing** pointer means "run the desktop app once", not "there is no
//     local library, use the server";
//   * a pointer that is present but unreadable is a hard error. Neither case
//     ever falls through to the account path — that fall-through is the §5.4
//     privacy violation the whole arrangement exists to prevent.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { LocalModeError } from './runtime.js';

/** Sits beside `config.json` under the root `configDir()` resolves (§5.1). */
export const POINTER_FILE = 'local-library.json';

/**
 * The pointer *format's* version — not the library's schema version, which
 * moves independently and is the handshake's business. Bumped only for a
 * change a reader that predates it cannot survive, exactly the rule §5.4
 * states for `config.json`.
 */
export const POINTER_VERSION = 1;

/**
 * The four keys, `snake_case` — deliberately, since they are the handshake's
 * comparison keys spelled the way the database spells them (pointer.rs).
 *
 * The app's own bytes are committed at
 * `packages/core/fixtures/local-pointer/v1.json`. No test reads them through
 * this module since the 2026-10-16 test cut, so nothing ties this declaration
 * to the Rust writer it mirrors; change both together. The webview states the
 * same shape a third time (`apps/web/src/desktop/local-pointer.ts`).
 *
 * Zod rather than a hand-rolled chain of `typeof` clauses: this package already
 * depends on it, and the two `.min(1)` bounds below are the part a reader has to
 * *notice*. It is deliberately **not** identical to the webview's schema, which
 * uses `.int()` and no minimum — that side is parsing a value it just received
 * from the process that wrote it, while this side is parsing a file of unknown
 * age, and the refusal messages here are contract (`library.test.ts`).
 *
 * Non-strict on purpose: a fifth key added by a future app must not break every
 * CLI already installed. `version` is what covers a change a reader cannot
 * survive, and it is checked separately below so its message stays its own.
 */
const pointerSchema = z.object({
  version: z.number(),
  db_path: z.string().min(1),
  workspace_uuid: z.string().min(1),
  schema_version: z.number(),
});

export type LocalLibraryPointer = Readonly<z.infer<typeof pointerSchema>>;

export function pointerPath(dir: string): string {
  return join(dir, POINTER_FILE);
}

/**
 * Whether a local library is *on offer* on this machine — the §5.4 precedence
 * question, and nothing more.
 *
 * Deliberately the file's presence rather than its validity: a pointer whose
 * `db_path` dangles still means "this user chose local mode", so it must make
 * the machine ambiguous (row 4) rather than resolve silently to the account.
 */
export function pointerExists(dir: string): boolean {
  return existsSync(pointerPath(dir));
}

export function readPointer(dir: string): LocalLibraryPointer {
  const file = pointerPath(dir);
  if (!existsSync(file)) {
    throw new LocalModeError(
      `local capture requires the desktop app — run it once to create your local library ` +
        `(no pointer file at ${file}).`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new LocalModeError(
      `${file} is not valid JSON. Launch the Kinjot desktop app to rewrite it; ` +
        `nothing was written.`,
    );
  }

  const record = pointerSchema.safeParse(parsed);
  if (!record.success) {
    throw new LocalModeError(
      `${file} has an unexpected shape. Launch the Kinjot desktop app to rewrite it; ` +
        `nothing was written.`,
    );
  }

  // Its own check, after the shape and outside the schema: a pointer from a
  // newer app is well-formed, and telling the user to update the CLI is a
  // different instruction from telling them to relaunch the app.
  if (record.data.version > POINTER_VERSION) {
    throw new LocalModeError(
      `${file} was written by a newer Kinjot desktop app (pointer version ` +
        `${record.data.version}; this CLI understands ${POINTER_VERSION}). ` +
        `Update the CLI: npm i -g kinjot.`,
    );
  }

  return record.data;
}
