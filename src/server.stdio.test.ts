import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { expect, it, vi } from 'vitest';
import { NotesApi } from './api.js';
import { serveBackend } from './backend.js';
import { DatabaseSync, FIXTURE_WORKSPACE, makeLibraryFixture } from './local/library-fixture.js';
import { pointerPath } from './local/pointer.js';
import { serveStdio } from './server.js';

it('K1: stdio advertises only the resolved account key access', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kinjot-stdio-'));
  const apiKey = `kj_live_${'A'.repeat(43)}`;
  const apiUrl = 'https://api.example.test/mcp';
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(url).toBe(apiUrl);
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${apiKey}`);
    expect(JSON.parse(String(init?.body))).toEqual({ action: 'key_info' });
    return new Response(JSON.stringify({ access: 'read_create' }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'stdio-access-test', version: '1' });
  const connect = McpServer.prototype.connect;
  let closeServer: (() => Promise<void>) | undefined;
  vi.spyOn(McpServer.prototype, 'connect').mockImplementation(function (this: McpServer) {
    closeServer = () => this.close();
    return connect.call(this, serverTransport);
  });
  try {
    await serveStdio(new NotesApi({ apiUrl, apiKey }), 'test', {
      KINJOT_MODE: 'account',
      KINJOT_CONFIG_DIR: dir,
      KINJOT_API_URL: apiUrl,
      KINJOT_API_KEY: apiKey,
    });
    await client.connect(clientTransport);
    const tools = await client.listTools();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      'find_jots',
      'get_jot',
      'inbox',
      'jot',
      'list_open_tasks',
      'list_recent_jots',
      'notify',
      'recall_jots',
      'upload_image',
    ]);
  } finally {
    await client.close();
    await closeServer?.();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each(['account key', 'account endpoint', 'account to local', 'local replacement'] as const)(
  'K2: stdio keeps tag spelling with its successful vocabulary owner: %s',
  async (scenario) => {
    const dir = mkdtempSync(join(tmpdir(), 'kinjot-vocabulary-'));
    const accountChange = scenario === 'account key' || scenario === 'account endpoint';
    const apiKey = `kj_live_${'A'.repeat(43)}`;
    const nextKey = `kj_live_${'B'.repeat(43)}`;
    const apiUrl = 'http://127.0.0.1:1/account-a';
    const nextUrl = 'http://127.0.0.1:1/account-b';
    const secondWorkspace = '22222222-2222-4222-8222-222222222222';
    const env = {
      KINJOT_MODE: scenario === 'local replacement' ? 'local' : 'account',
      KINJOT_CONFIG_DIR: dir,
      KINJOT_API_URL: apiUrl,
      KINJOT_API_KEY: apiKey,
    };
    const requests: {
      url: string;
      authorization: string | undefined;
      body: Record<string, unknown>;
    }[] = [];
    let failAccount = false;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({
        url: String(url),
        authorization: (init?.headers as Record<string, string>).authorization,
        body,
      });
      if (body.action === 'key_info') return Response.json({ access: 'full' });
      if (body.action === 'edit_note')
        return Response.json({
          note: { id: body.id, title: body.title, updated_at: '2026-10-26T00:00:00Z' },
        });
      expect(body.action).toBe('save_note');
      if (failAccount)
        return Response.json({ error: 'synthetic temporary save failure' }, { status: 500 });
      return Response.json({
        note: { id: body.id, title: body.title, created_at: '2026-10-26T00:00:00Z' },
        existing_tags: ['ZETA'],
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    let fixture: ReturnType<typeof makeLibraryFixture> | undefined;
    if (scenario === 'local replacement') {
      fixture = makeLibraryFixture(dir);
      const db = new DatabaseSync(fixture.dbPath);
      try {
        db.prepare(
          'INSERT INTO tags (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run(
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          fixture.workspaceId,
          'ZETA',
          '2026-10-26T00:00:00Z',
          '2026-10-26T00:00:00Z',
        );
      } finally {
        db.close();
      }
    }
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'vocabulary-owner-test', version: '1' });
    const connect = McpServer.prototype.connect;
    let closeServer: (() => Promise<void>) | undefined;
    vi.spyOn(McpServer.prototype, 'connect').mockImplementation(function (this: McpServer) {
      closeServer = () => this.close();
      return connect.call(this, serverTransport);
    });
    const outputs: unknown[] = [];
    const jot = async (title: string, tags: string[] = []) => {
      const result = await client.callTool({
        name: 'jot',
        arguments: { title, body: 'synthetic fixture body', tags },
      });
      outputs.push(result);
      return result;
    };
    const edit = async (title: string) => {
      const result = await client.callTool({
        name: 'edit_jot',
        arguments: {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          title,
          add_tags: ['zeta'],
        },
      });
      outputs.push(result);
      return result;
    };
    try {
      await serveStdio(serveBackend(env), 'test', env);
      await client.connect(clientTransport);
      const first = await jot('A vocabulary');
      expect(first.isError).not.toBe(true);
      expect(JSON.stringify(first)).toMatch(/existing tags include: .*\bZETA\b/);
      const second = await jot('A canonical tag', ['zeta']);
      expect(second.isError).not.toBe(true);
      expect(JSON.stringify(second)).toContain('tags: ZETA');
      if (fixture) {
        const db = new DatabaseSync(fixture.dbPath);
        try {
          expect(
            db
              .prepare(
                'SELECT t.name FROM tags t JOIN note_tags nt ON nt.tag_id = t.id JOIN notes n ON n.id = nt.note_id WHERE n.title = ? AND lower(t.name) = ?',
              )
              .all('A canonical tag', 'zeta'),
          ).toEqual([{ name: 'ZETA' }]);
        } finally {
          db.close();
        }
      } else {
        expect(
          requests.filter((request) => request.body.action === 'save_note').at(-1)?.body.tags,
        ).toContain('ZETA');
      }
      if (accountChange) {
        const edited = await edit('A canonical edit');
        expect(edited.isError).not.toBe(true);
        expect(requests.at(-1)?.body).toMatchObject({
          action: 'edit_note',
          add_tags: ['ZETA'],
        });
      }
      const switchIndex = requests.length;
      if (scenario === 'account key') {
        env.KINJOT_API_KEY = nextKey;
        failAccount = true;
      }
      if (scenario === 'account endpoint') {
        env.KINJOT_API_URL = nextUrl;
        failAccount = true;
      }
      if (scenario === 'account to local') {
        env.KINJOT_MODE = 'local';
        fixture = makeLibraryFixture(dir);
        for (const suffix of ['', '-wal', '-shm'])
          rmSync(`${fixture.dbPath}${suffix}`, { force: true });
      }
      if (scenario === 'local replacement') {
        for (const suffix of ['', '-wal', '-shm'])
          rmSync(`${fixture!.dbPath}${suffix}`, { force: true });
        fixture = makeLibraryFixture(dir, { workspaceId: secondWorkspace, publishPointer: false });
      }
      const failed = await jot('B refused', ['zeta']);
      expect(failed.isError).toBe(true);
      if (accountChange) {
        const edited = await edit('B after refused save');
        expect(edited.isError).not.toBe(true);
        expect(requests.at(-1)?.body).toMatchObject({
          action: 'edit_note',
          add_tags: ['zeta'],
        });
      }
      if (scenario === 'account to local') {
        expect(JSON.stringify(failed)).toContain('named by the pointer is missing');
        fixture = makeLibraryFixture(dir);
      } else if (scenario === 'local replacement') {
        expect(JSON.stringify(failed)).toContain('disagree about which workspace');
        const pointer = JSON.parse(readFileSync(pointerPath(dir), 'utf8')) as Record<
          string,
          unknown
        >;
        writeFileSync(
          pointerPath(dir),
          JSON.stringify({ ...pointer, workspace_uuid: secondWorkspace }),
        );
      } else {
        expect(JSON.stringify(failed)).toContain('synthetic temporary save failure');
        failAccount = false;
      }
      const repaired = await jot('B repaired', ['zeta']);
      expect(repaired.isError).not.toBe(true);
      const postSwitch = requests.slice(switchIndex);
      if (env.KINJOT_MODE === 'local') {
        expect(postSwitch).toEqual([]);
        const db = new DatabaseSync(fixture!.dbPath);
        try {
          const tags = db.prepare('SELECT name FROM tags WHERE lower(name) = ?').all('zeta');
          expect(tags).toEqual([{ name: 'zeta' }]);
          const notes = JSON.stringify(db.prepare('SELECT * FROM notes').all());
          expect(notes).not.toContain('vocabularyOwner');
          expect(notes).not.toContain(apiKey);
          expect(notes).not.toContain(nextKey);
          expect(notes).not.toContain(
            JSON.stringify(`${fixture!.dbPath}\0${fixture!.workspaceId}`).slice(1, -1),
          );
        } finally {
          db.close();
        }
      } else {
        const saves = postSwitch.filter((request) => request.body.action === 'save_note');
        expect(saves.length).toBeGreaterThanOrEqual(2);
        for (const request of postSwitch) {
          expect(request.url).toBe(env.KINJOT_API_URL);
          expect(request.authorization).toBe(`Bearer ${env.KINJOT_API_KEY}`);
        }
        expect(saves.at(-1)?.body).toMatchObject({ action: 'save_note', title: 'B repaired' });
        expect(saves.at(-1)?.body.tags).toContain('zeta');
        expect(saves.at(-1)?.body.tags).not.toContain('ZETA');
        const edits = postSwitch.filter((request) => request.body.action === 'edit_note');
        expect(edits).toHaveLength(1);
        expect(edits[0]?.body.add_tags).toEqual(['zeta']);
      }
      const serialized = JSON.stringify({
        outputs,
        bodies: requests.map((request) => request.body),
      });
      expect(serialized).not.toContain('vocabularyOwner');
      if (fixture) {
        for (const workspaceId of [FIXTURE_WORKSPACE, secondWorkspace]) {
          expect(serialized).not.toContain(
            JSON.stringify(`${fixture.dbPath}\0${workspaceId}`).slice(1, -1),
          );
        }
      }
      for (const key of [apiKey, nextKey]) {
        expect(serialized).not.toContain(key);
        for (const url of [apiUrl, nextUrl]) {
          expect(serialized).not.toContain(
            createHash('sha256').update(`${url}\0${key}`).digest('hex'),
          );
        }
      }
    } finally {
      await client.close();
      await closeServer?.();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
