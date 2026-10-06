import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotesApi, type SaveNoteInput } from './api.js';
import { LocalBackend } from './backend.js';
import { main } from './cli.js';
import { buildServer } from './server.js';
import { openLocalLibrary, type LocalLibrary } from './local/library.js';
import { makeLibraryFixture } from './local/library-fixture.js';
import { saveNoteLocally } from './local/save-note.js';

const config = { apiUrl: 'https://api.example/mcp-api', apiKey: `kj_live_${'a'.repeat(43)}` };
const id = '12345678-1234-4234-8234-123456789abc';
const savedNote = { id, title: 'Title', created_at: 'now' };
const editedNote = { id, short_id: 1, title: 'Title', updated_at: 'now' };
const notice = ' Left out the autosave tag: it is reserved for autosave sessions.';
const hint = "\nThe user's existing tags include: DB — reuse these exact names on future jots.";

function httpBoundary(response: unknown) {
  const requests: Record<string, unknown>[] = [];
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(init!.body as string));
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { response, requests, fetcher, api: new NotesApi(config, fetcher as typeof fetch) };
}

type Tools = Record<
  string,
  {
    handler: (
      args: unknown,
      extra: unknown,
    ) => Promise<{ content: { text: string }[]; isError?: boolean }>;
    inputSchema: { shape: { folder: { description: string } } };
  }
>;

function tools(backend: NotesApi | LocalBackend) {
  const server = buildServer(backend, 'test', { repoTag: null });
  return (server as unknown as { _registeredTools: Tools })._registeredTools;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
});

describe('No AI hosted writes', () => {
  it.each([
    ['true', { ai_excluded: true }, true],
    ['absent', {}, false],
    ['false', { ai_excluded: false }, false],
    ['truthy string', { ai_excluded: 'true' }, false],
    ['number', { ai_excluded: 1 }, false],
    ['object', { ai_excluded: {} }, false],
    ['null', { ai_excluded: null }, false],
  ])('parses save and edit exclusion strictly: %s', async (_name, exclusion, expected) => {
    const save = httpBoundary({ note: savedNote, ...exclusion });
    expect(await save.api.saveNote({ id, title: 'Title', body: 'Body', folder: 'Work' })).toEqual({
      ...savedNote,
      tags: [],
      existingTags: undefined,
      aiExcluded: expected,
    });
    expect(save.requests).toEqual([
      { action: 'save_note', id, title: 'Title', body: 'Body', folder: 'Work', source: 'mcp' },
    ]);
    expect(save.response).toEqual({ note: savedNote, ...exclusion });

    const edit = httpBoundary({ note: editedNote, ...exclusion });
    expect(await edit.api.editNote({ id: 'A10', folder: 'Work' })).toEqual({
      ...editedNote,
      aiExcluded: expected,
    });
    expect(edit.requests).toEqual([
      { action: 'edit_note', short_id: 1, folder: 'Work', source: 'mcp' },
    ]);
    expect(edit.response).toEqual({ note: editedNote, ...exclusion });
  });

  it.each([false, true])('pins the whole jot reply with notices, excluded=%s', async (excluded) => {
    const boundary = httpBoundary({
      note: savedNote,
      existing_tags: ['DB'],
      ...(excluded ? { ai_excluded: true } : {}),
    });
    const result = await tools(boundary.api).jot!.handler(
      { title: 'Title', body: 'Body', tags: ['infra', 'autosave'], folder: 'Work' },
      {},
    );
    expect(result.content[0]!.text).toBe(
      excluded
        ? `Jotted "Title" (id ${id}, tags: infra) into a No AI folder: agents can't read it back.${notice}${hint}`
        : `Jotted "Title" (id ${id}, tags: infra).${notice}${hint}`,
    );
    expect(boundary.requests).toEqual([
      {
        action: 'save_note',
        id: expect.any(String),
        title: 'Title',
        body: 'Body',
        tags: ['infra'],
        folder: 'Work',
        source: 'mcp',
      },
    ]);
  });

  it.each([false, true])('pins the whole edit_jot reply, excluded=%s', async (excluded) => {
    const boundary = httpBoundary({ note: editedNote, ...(excluded ? { ai_excluded: true } : {}) });
    const result = await tools(boundary.api).edit_jot!.handler(
      { id: 'A10', folder: 'Work', add_tags: ['autosave'] },
      {},
    );
    expect(result.content[0]!.text).toBe(
      excluded
        ? `Edited A10 "Title" and moved it into a No AI folder: agents can't read it back.${notice}`
        : `Edited A10 "Title".${notice}`,
    );
    expect(boundary.requests).toEqual([
      { action: 'edit_note', short_id: 1, folder: 'Work', source: 'mcp' },
    ]);
  });

  it.each([false, true])(
    'pins CLI add output through terminalSafe, excluded=%s',
    async (excluded) => {
      const dir = mkdtempSync(join(tmpdir(), 'kinjot-no-ai-cli-'));
      try {
        vi.stubEnv('KINJOT_CONFIG_DIR', dir);
        vi.stubEnv('KINJOT_MODE', 'account');
        vi.stubEnv('KINJOT_API_KEY', config.apiKey);
        vi.stubEnv('KINJOT_API_URL', config.apiUrl);
        const boundary = httpBoundary({
          note: { ...savedNote, title: `Ti${String.fromCharCode(7)}tle` },
          ...(excluded ? { ai_excluded: true } : {}),
        });
        vi.stubGlobal('fetch', boundary.fetcher);
        const output = vi.spyOn(console, 'log').mockImplementation(() => {});
        await main(['add', 'Title', '--id', id, '--body', 'Body', '--folder', 'Work']);
        expect(process.exitCode).toBeUndefined();
        expect(output.mock.calls).toEqual([
          [
            excluded
              ? `Jotted "Title" (id ${id}) into a No AI folder: agents can't read it back.`
              : `Jotted "Title" (id ${id}).`,
          ],
        ]);
        expect(boundary.requests).toEqual([
          { action: 'save_note', id, title: 'Title', body: 'Body', folder: 'Work', source: 'cli' },
        ]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

// Exercise the real applier with schema-4 columns. The vendored migration list
// still ends at 3, so the production handshake cannot open version 4 yet.
function version4Library(dir: string): LocalLibrary {
  makeLibraryFixture(dir, { schemaVersion: 3 });
  const library = openLocalLibrary(dir);
  library.db.exec('ALTER TABLE folders ADD COLUMN ai_excluded_at TEXT');
  library.db.exec('ALTER TABLE folders ADD COLUMN pinned_at TEXT');
  library.db.exec('ALTER TABLE notes ADD COLUMN trashed_from_folder_id TEXT');
  library.db.exec(
    "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) VALUES (4, 'no_ai_columns', 1, x'00', 0)",
  );
  return { ...library, schemaVersion: 4 };
}

function folder(
  library: LocalLibrary,
  folderId: string,
  name: string,
  createdAt: string,
  parent: string | null = null,
  excluded: string | null = null,
  deleted: string | null = null,
) {
  library.db
    .prepare(
      `INSERT INTO folders (id, user_id, name, parent_id, created_at, updated_at, deleted_at${library.schemaVersion >= 4 ? ', ai_excluded_at' : ''}) VALUES (?, ?, ?, ?, ?, ?, ?${library.schemaVersion >= 4 ? ', ?' : ''})`,
    )
    .run(
      folderId,
      library.workspaceId,
      name,
      parent,
      createdAt,
      createdAt,
      deleted,
      ...(library.schemaVersion >= 4 ? [excluded] : []),
    );
}

class ApplierBackend extends LocalBackend {
  constructor(private readonly library: LocalLibrary) {
    super('unused: tests invoke the applier with an already-open database');
  }
  override async saveNote(input: SaveNoteInput) {
    return saveNoteLocally(this.library, input);
  }
}

describe('No AI local folder selection', () => {
  it.each(['live', 'dead', 'trash'] as const)(
    'schema 4 prefers ordinary Work over an older excluded descendant of %s root',
    (root) => {
      const dir = mkdtempSync(join(tmpdir(), 'kinjot-no-ai-local-'));
      const library = version4Library(dir);
      try {
        folder(
          library,
          'root',
          root === 'trash' ? ' Trash ' : 'Private',
          '2020-01-01T00:00:00.000Z',
          null,
          root === 'trash' ? null : '2020-01-01T00:00:00.000Z',
          root === 'dead' ? '2021-01-01T00:00:00.000Z' : null,
        );
        folder(
          library,
          'middle',
          'Middle',
          '2020-01-01T00:00:00.000Z',
          'root',
          null,
          '2021-01-01T00:00:00.000Z',
        );
        folder(library, 'excluded-work', 'Work', '2020-01-01T00:00:00.000Z', 'middle');
        folder(library, 'ordinary-work', 'Work', '2022-01-01T00:00:00.000Z');
        folder(library, 'later-work', 'work', '2023-01-01T00:00:00.000Z');
        const result = saveNoteLocally(library, {
          id,
          title: 'Title',
          body: 'Body',
          folder: ' work ',
        });
        expect(result.aiExcluded).toBe(false);
        expect(library.db.prepare('SELECT folder_id FROM notes WHERE id = ?').get(id)).toEqual({
          folder_id: 'ordinary-work',
        });
      } finally {
        library.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('schema 4 with only No AI Work writes there and prints the whole MCP reply', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kinjot-no-ai-local-'));
    const library = version4Library(dir);
    try {
      folder(
        library,
        'excluded-work',
        'Work',
        '2020-01-01T00:00:00.000Z',
        null,
        '2020-01-01T00:00:00.000Z',
      );
      const result = await tools(new ApplierBackend(library)).jot!.handler(
        { title: 'Title', body: 'Body', tags: ['seed'], folder: 'Work' },
        {},
      );
      const note = library.db.prepare('SELECT id, folder_id FROM notes').get()!;
      expect(note.folder_id).toBe('excluded-work');
      expect(result.content[0]!.text).toBe(
        `Jotted "Title" (id ${String(note.id)}, tags: seed) into a No AI folder: agents can't read it back.`,
      );
    } finally {
      library.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('schema 4 ignores deleted ordinary Work and files into live No AI Work, flagged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kinjot-no-ai-local-'));
    const library = version4Library(dir);
    try {
      folder(
        library,
        'deleted-work',
        'Work',
        '2019-01-01T00:00:00.000Z',
        null,
        null,
        '2021-01-01T00:00:00.000Z',
      );
      folder(
        library,
        'excluded-work',
        'Work',
        '2020-01-01T00:00:00.000Z',
        null,
        '2020-01-01T00:00:00.000Z',
      );
      const result = saveNoteLocally(library, { id, title: 'Title', body: 'Body', folder: 'Work' });
      const note = library.db
        .prepare('SELECT folder_id, created_at FROM notes WHERE id = ?')
        .get(id)!;
      expect(note.folder_id).toBe('excluded-work');
      expect(result).toEqual({
        id,
        title: 'Title',
        created_at: note.created_at,
        tags: [],
        existingTags: [],
        aiExcluded: true,
      });
      expect(library.db.prepare('SELECT id FROM folders ORDER BY id').all()).toEqual([
        { id: 'deleted-work' },
        { id: 'excluded-work' },
      ]);
    } finally {
      library.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([undefined, 'Fresh'])(
    'schema 4 returns the whole unexcluded save result for folder=%j',
    (name) => {
      const dir = mkdtempSync(join(tmpdir(), 'kinjot-no-ai-local-'));
      const library = version4Library(dir);
      try {
        folder(
          library,
          'excluded-work',
          'Work',
          '2020-01-01T00:00:00.000Z',
          null,
          '2020-01-01T00:00:00.000Z',
        );
        const result = saveNoteLocally(library, { id, title: 'Title', body: 'Body', folder: name });
        const note = library.db
          .prepare('SELECT folder_id, created_at FROM notes WHERE id = ?')
          .get(id)!;
        expect(result).toEqual({
          id,
          title: 'Title',
          created_at: note.created_at,
          tags: [],
          existingTags: [],
          aiExcluded: false,
        });
        if (name === undefined) {
          expect(note.folder_id).toBeNull();
          expect(library.db.prepare('SELECT id FROM folders').all()).toEqual([
            { id: 'excluded-work' },
          ]);
        } else {
          expect(
            library.db
              .prepare(
                'SELECT name, pinned_at, ai_excluded_at, deleted_at FROM folders WHERE id = ?',
              )
              .get(note.folder_id),
          ).toEqual({ name: 'Fresh', pinned_at: null, ai_excluded_at: null, deleted_at: null });
          expect(library.db.prepare('SELECT id FROM folders').all()).toHaveLength(2);
        }
      } finally {
        library.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('schema 3 retains the oldest folder id and the entire save-result shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kinjot-no-ai-local-'));
    makeLibraryFixture(dir, { schemaVersion: 3 });
    const library = openLocalLibrary(dir);
    try {
      folder(library, 'root', 'Trash', '2019-01-01T00:00:00.000Z');
      folder(library, 'old-work', 'Work', '2020-01-01T00:00:00.000Z', 'root');
      folder(library, 'new-work', 'Work', '2022-01-01T00:00:00.000Z');
      const result = saveNoteLocally(library, { id, title: 'Title', body: 'Body', folder: 'Work' });
      const note = library.db
        .prepare('SELECT folder_id, created_at FROM notes WHERE id = ?')
        .get(id)!;
      expect(note.folder_id).toBe('old-work');
      expect(result).toEqual({
        id,
        title: 'Title',
        created_at: note.created_at,
        tags: [],
        existingTags: [],
      });
    } finally {
      library.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('schema 4 refuses the reserved Trash name without writing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kinjot-no-ai-local-'));
    const library = version4Library(dir);
    try {
      expect(() =>
        saveNoteLocally(library, { id, title: 'Title', body: 'Body', folder: ' TRASH ' }),
      ).toThrow('invalid_folder');
      expect(library.db.prepare('SELECT id FROM notes').all()).toEqual([]);
      expect(library.db.prepare('SELECT id FROM folders').all()).toEqual([]);
    } finally {
      library.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
