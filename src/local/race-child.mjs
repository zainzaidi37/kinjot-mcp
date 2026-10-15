// One OS process of the two-process get-or-create race (plans/desktop-app.md
// §4.9, §6; `race.test.ts` is the parent).
//
// Deliberately **not** a TypeScript file and deliberately **not** imported by
// anything: it is spawned with `child_process.fork`, and it reaches the shipped
// write path by dynamic-importing a build of this package that the parent test
// produced (argv[2]). Two reasons that indirection exists rather than importing
// `./save-note.js` from source:
//
//   * vitest/Vite rewrites the bare `node:sqlite` specifier, which is why
//     `runtime.ts` loads it through `createRequire` — a child that inherited
//     any of vitest's module pipeline would be testing a different loader than
//     the CLI's. A plain `node` child inherits nothing;
//   * Node cannot resolve this package's `./x.js` import specifiers against
//     `.ts` sources, so running the sources directly in a bare child would need
//     a custom resolve hook. Compiling with the package's own
//     `tsconfig.build.json` runs *the artifact users install* instead.
//
// The protocol is three messages: the child reports `ready` once the library is
// open (so the §5.3 handshake is not inside the measured window), the parent
// releases every child at once with `go`, and the child reports the ids it
// wrote. Anything else — a thrown handshake, a `SQLITE_BUSY` — leaves through a
// non-zero exit and stderr, both of which the parent asserts on.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [buildDir, configDir, label] = process.argv.slice(2);

const importBuilt = (relative) => import(pathToFileURL(join(buildDir, relative)).href);

const { openLocalLibrary } = await importBuilt('local/library.js');
const { saveNoteLocally } = await importBuilt('local/save-note.js');

// The same entry point `kinjot add` and the MCP jot tool take in local mode:
// the §5.3 handshake against the pointer under `KINJOT_CONFIG_DIR`.
const library = openLocalLibrary(configDir);

const go = new Promise((resolve) => {
  process.on('message', (message) => {
    if (message && message.type === 'go') resolve(message.notes);
  });
});

process.send({ type: 'ready' });

const notes = await go;
const ids = [];
for (const note of notes) {
  const saved = saveNoteLocally(library, {
    title: `${label} ${note.title}`,
    body: `written by ${label}`,
    tags: note.tags,
    folder: note.folder,
    source: 'cli',
  });
  ids.push(saved.id);
}

library.close();
// Disconnect only once the message is flushed: `send` immediately followed by
// `disconnect` can drop a payload too large to write synchronously.
process.send({ type: 'done', ids }, () => process.disconnect());
