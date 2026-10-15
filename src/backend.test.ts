import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotesApi } from './api.js';
import { LocalBackend, resolveBackend, serveBackend } from './backend.js';
import { configFilePath, saveStoredKey, saveStoredMode } from './configFile.js';
import { FIXTURE_WORKSPACE, makeLibraryFixture } from './local/library-fixture.js';
import { buildServer } from './server.js';
import type { SqliteDatabaseConstructor } from './local/runtime.js';

/**
 * Mode resolution as the CLI commands and MCP tools meet it, through one
 * resolver (plans/desktop-app.md §5.4).
 */

const DatabaseSync = (
  createRequire(import.meta.url)('node:sqlite') as {
    DatabaseSync: SqliteDatabaseConstructor;
  }
).DatabaseSync;

const GOOD_KEY = `kj_live_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V'.slice(0, 43)}`;

type RegisteredTool = {
  handler: (
    args: unknown,
    extra: unknown,
  ) => Promise<{ isError?: boolean; content: { text: string }[] }>;
};

function registeredTools(server: ReturnType<typeof buildServer>): Record<string, RegisteredTool> {
  return (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
}

function notesIn(dbPath: string): Record<string, unknown>[] {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare('SELECT * FROM "notes"').all();
  } finally {
    db.close();
  }
}

describe('local mode backend', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kinjot-backend-'));
    ({ dbPath } = makeLibraryFixture(dir));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses the four reads by naming the desktop app (deliberately not implemented)', async () => {
    const backend = new LocalBackend(dir);
    for (const call of [
      () => backend.searchNotes(),
      () => backend.recallNotes(),
      () => backend.getNote(),
      () => backend.listRecentNotes(),
    ]) {
      await expect(call()).rejects.toThrow(/desktop app/);
    }
  });

  it('resolveBackend picks the library in local mode and NotesApi in account mode', () => {
    expect(resolveBackend({ KINJOT_CONFIG_DIR: dir, KINJOT_MODE: 'local' }).backend).toBeInstanceOf(
      LocalBackend,
    );
    const account = resolveBackend({
      KINJOT_CONFIG_DIR: dir,
      KINJOT_MODE: 'account',
      KINJOT_API_KEY: GOOD_KEY,
    });
    expect(account.backend).toBeInstanceOf(NotesApi);
  });

  it('writes a jot into the library the pointer names, with no network call', async () => {
    const fetchMock = vi.fn(() => {
      throw new Error('local mode must not touch the network');
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const saved = await new LocalBackend(dir).saveNote({
        title: 'from the CLI',
        body: 'body',
        tags: ['Infra'],
        source: 'cli',
      });
      const notes = notesIn(dbPath);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({
        id: saved.id,
        title: 'from the CLI',
        user_id: FIXTURE_WORKSPACE,
        source: 'cli',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('passes a supplied note id through the local backend', async () => {
    const id = '12345678-1234-8234-8234-123456789abc';
    const saved = await new LocalBackend(dir).saveNote({ id, title: 'fixed id', body: '' });
    expect(saved.id).toBe(id);
    expect(notesIn(dbPath).map((note) => note.id)).toEqual([id]);
  });

  it('the MCP jot tool writes locally, and the read tools return the desktop-app error', async () => {
    const tools = registeredTools(
      buildServer(new LocalBackend(dir), '0.0.0-test', { repoTag: null }),
    );
    const jotted = await tools.jot!.handler({ title: 'agent jot', body: 'b' }, {});
    expect(jotted.isError).toBeUndefined();
    expect(notesIn(dbPath)).toHaveLength(1);

    const found = await tools.find_jots!.handler({ query: 'anything' }, {});
    expect(found.isError).toBe(true);
    expect(found.content[0]!.text).toMatch(/desktop app/);
    // The class name never reaches the agent, only the sentence.
    expect(found.content[0]!.text).not.toContain('LocalModeError');
  });

  it('serve mode resolves per call: row 4 is a tool error, and `kinjot use` needs no restart', async () => {
    saveStoredKey(GOOD_KEY, dir);
    // Built while the machine is ambiguous — the server itself must come up,
    // because a refusal that prevents startup never shows anyone its message.
    const tools = registeredTools(
      buildServer(serveBackend({ KINJOT_CONFIG_DIR: dir }), '0.0.0-test', { repoTag: null }),
    );

    const refused = await tools.jot!.handler({ title: 'ambiguous', body: 'b' }, {});
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain('kinjot use account');
    expect(notesIn(dbPath)).toHaveLength(0);

    saveStoredMode('local', dir);
    const jotted = await tools.jot!.handler({ title: 'after use local', body: 'b' }, {});
    expect(jotted.isError).toBeUndefined();
    expect(notesIn(dbPath)).toHaveLength(1);
  });

  it('a mid-session target switch drops the cached vocabulary hint — account spellings must not steer local tags', async () => {
    const fakeApi = {
      saveNote: async () => ({
        id: 'acct-1',
        title: 'account jot',
        created_at: '2026-08-06T00:00:00.000Z',
        tags: [],
        existingTags: ['Account-Spelling'],
      }),
    } as unknown as NotesApi;
    saveStoredKey(GOOD_KEY, dir);
    saveStoredMode('account', dir);
    const backend = serveBackend({ KINJOT_CONFIG_DIR: dir }, () => fakeApi);
    await backend.saveNote({ title: 'first, to the account', body: '' });

    saveStoredMode('local', dir);
    // The MCP server would pass the account jot's existingTags as vocabulary
    // here; with the hint honored, the local tag row would be the account's
    // spelling "Account-Spelling" instead of the plain normalization.
    await backend.saveNote({
      title: 'then local',
      body: '',
      tags: ['account spelling'],
      vocabulary: ['Account-Spelling'],
    });

    const db = new DatabaseSync(dbPath);
    try {
      expect(db.prepare('SELECT "name" FROM "tags"').all()).toEqual([{ name: 'account-spelling' }]);
    } finally {
      db.close();
    }
  });

  it('drops local tag vocabulary on the first account edit after a mode switch', async () => {
    const editNote = vi.fn().mockResolvedValue({
      id: 'acct-1',
      title: 'account jot',
      updated_at: '2026-08-06T00:00:00.000Z',
    });
    const fakeApi = { editNote } as unknown as NotesApi;
    saveStoredKey(GOOD_KEY, dir);
    saveStoredMode('local', dir);
    const backend = serveBackend({ KINJOT_CONFIG_DIR: dir }, () => fakeApi);
    await backend.saveNote({ title: 'local jot', body: '' });
    saveStoredMode('account', dir);
    const edit = {
      id: 'A10',
      add_tags: ['account spelling'],
      vocabulary: ['Local-Spelling'],
    };
    await backend.editNote(edit);
    await backend.editNote(edit);
    expect(editNote).toHaveBeenCalledTimes(2);
    for (const [input] of editNote.mock.calls) {
      expect(input).toEqual({ ...edit, vocabulary: undefined });
    }
  });
});

describe('the CLI, through main()', () => {
  let dir: string;
  let dbPath: string;
  let logs: string[];
  let errors: string[];
  let restoreEnv: () => void;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kinjot-cli-mode-'));
    ({ dbPath } = makeLibraryFixture(dir));
    logs = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => void logs.push(args.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(args.join(' ')));
    const previous = { ...process.env };
    process.env.KINJOT_CONFIG_DIR = dir;
    delete process.env.KINJOT_API_KEY;
    delete process.env.KINJOT_MODE;
    restoreEnv = () => {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, previous);
    };
  });

  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
    process.exitCode = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('`kinjot add` writes to the local library when it is the only option', async () => {
    const { main } = await import('./cli.js');
    await main(['add', 'a local jot', '--body', 'hello']);
    expect(process.exitCode).toBeUndefined();
    expect(notesIn(dbPath).map((note) => note.title)).toEqual(['a local jot']);
    expect(logs.join('\n')).toContain('Jotted "a local jot"');
  });

  it('`kinjot add` echoes the title through terminalSafe — a jot cannot smuggle ANSI into the terminal', async () => {
    // The title is agent-written in the MCP flow and server-round-tripped in
    // account mode, so the echo is untrusted like every other printed note
    // field (printHit, get, recall). The escapes must be stripped from the
    // terminal while the stored row keeps the exact bytes.
    // ESC/CSI/OSC/BEL plus \u009b — the 8-bit C1 CSI terminals honour in
    // 8-bit mode, which terminalSafe's range claims and this pins.
    const hostile = '\u001b[2J\u001b]0;owned\u0007\u009b31mreal title';
    const { main } = await import('./cli.js');
    await main(['add', hostile, '--body', 'x']);
    expect(process.exitCode).toBeUndefined();
    expect(notesIn(dbPath).map((note) => note.title)).toEqual([hostile]);
    const echoed = logs.join('\n');
    expect(echoed).toContain('Jotted "[2J]0;owned31mreal title"');
    expect(echoed).not.toContain('\u001b');
    expect(echoed).not.toContain('\u009b');
  });

  it('`kinjot where` sanitizes pointer-derived strings — a crafted db_path cannot smuggle ANSI', async () => {
    // The pointer file is file-controlled input; its db_path is interpolated
    // into `where` output and every LocalModeError. `where` is the command
    // run when things are already broken — exactly when the pointer is most
    // likely to be garbage or hostile.
    const evilPath = join(dir, 'gone\u001b]0;owned\u0007\u009b31m.db');
    writeFileSync(
      join(dir, 'local-library.json'),
      JSON.stringify({
        version: 1,
        db_path: evilPath,
        workspace_uuid: FIXTURE_WORKSPACE,
        schema_version: 2,
      }),
    );
    const { main } = await import('./cli.js');
    await main(['where']);
    expect(process.exitCode).toBe(1);
    const output = [...logs, ...errors].join('\n');
    expect(output).toContain('target: unavailable');
    expect(output).not.toContain('\u001b');
    expect(output).not.toContain('\u009b');
  });

  it('`kinjot search` in local mode points at the desktop app instead of half-answering', async () => {
    const { main } = await import('./cli.js');
    await main(['search', 'kong']);
    expect(process.exitCode).toBe(4);
    expect(errors.join('\n')).toMatch(/search is not available in local mode/);
  });

  it('a stored key plus a local library and no mode refuses, naming `kinjot use account`', async () => {
    saveStoredKey(GOOD_KEY, dir);
    const fetchMock = vi.fn(() => {
      throw new Error('nothing may be sent to the server');
    });
    vi.stubGlobal('fetch', fetchMock);
    const { main } = await import('./cli.js');
    try {
      await main(['add', 'ambiguous', '--body', 'x']);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toContain('kinjot use account');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(notesIn(dbPath)).toHaveLength(0);
  });

  it('`kinjot use local` records the choice and unblocks the ambiguous machine', async () => {
    saveStoredKey(GOOD_KEY, dir);
    const { main } = await import('./cli.js');
    await main(['use', 'local']);
    expect(JSON.parse(readFileSync(configFilePath(dir), 'utf8'))).toEqual({
      version: 1,
      apiKey: GOOD_KEY,
      mode: 'local',
    });

    await main(['add', 'after choosing', '--body', 'x']);
    expect(process.exitCode).toBeUndefined();
    expect(notesIn(dbPath).map((note) => note.title)).toEqual(['after choosing']);
  });

  it('`kinjot where` names the target library, its identity, and the rung that decided', async () => {
    const { main } = await import('./cli.js');
    await main(['where']);
    const output = logs.join('\n');
    expect(output).toContain('mode:   local');
    expect(output).toContain(dbPath);
    expect(output).toContain(FIXTURE_WORKSPACE);
    expect(output).toMatch(/no API key is stored/);
    expect(process.exitCode).toBeUndefined();
  });

  it('`kinjot where` explains an ambiguous machine rather than raising', async () => {
    saveStoredKey(GOOD_KEY, dir);
    const { main } = await import('./cli.js');
    await main(['where']);
    expect(logs.join('\n')).toContain('kinjot use account');
    expect(process.exitCode).toBe(1);
  });

  it('`kinjot where` reports a dangling library without pretending the server is the target', async () => {
    rmSync(join(dir, 'local'), { recursive: true, force: true });
    const { main } = await import('./cli.js');
    await main(['where']);
    const output = logs.join('\n');
    expect(output).toContain('target: unavailable');
    expect(output).toContain('nothing was sent to the server');
    expect(process.exitCode).toBe(1);
  });
});
