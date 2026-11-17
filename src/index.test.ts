import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { NotesApi } from './api.js';
import { serveBackend } from './backend.js';
import { main, runKey } from './cli.js';
import { DEFAULT_API_URL, resolveConfig } from './config.js';
import { configFilePath, saveStoredAccount, saveStoredKey } from './configFile.js';
import { buildServer } from './server.js';

const GOOD_KEY = `kj_live_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V'.slice(0, 43)}`;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type RegisteredTool = {
  description: string;
  // What the SDK validates a tools/call against before the handler runs. The
  // tests below call the handler directly, so nothing here checks it.
  inputSchema: { safeParse: (value: unknown) => { success: boolean } };
  handler: (
    args: unknown,
    extra: unknown,
  ) => Promise<{ isError?: boolean; content: { text: string }[] }>;
};

function registeredTools(server: ReturnType<typeof buildServer>): Record<string, RegisteredTool> {
  return (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
}

describe('resolveConfig', () => {
  it('does not combine an environment key with an unrelated stored endpoint', () => {
    const loadStored = vi.fn(() => ({
      apiKey: `kj_live_${'z'.repeat(43)}`,
      apiUrl: 'https://stored.example/functions/v1/mcp-api',
    }));
    expect(resolveConfig({ KINJOT_API_KEY: GOOD_KEY }, loadStored)).toEqual({
      apiKey: GOOD_KEY,
      apiUrl: DEFAULT_API_URL,
    });
    expect(loadStored).not.toHaveBeenCalled();
  });

  it("K6: a hosted key is never sent to a self-host endpoint it wasn't saved or typed with (#1883, #1904)", async () => {
    const selfHostUrl = 'https://byo-operator.example/functions/v1/mcp-api';
    const hostedKey = `kj_live_${'H'.repeat(43)}`;
    const dir = mkdtempSync(join(tmpdir(), 'kinjot-endpoint-'));
    // `resolveConfig`'s default loader reads `configDir()` from process.env.
    vi.stubEnv('KINJOT_CONFIG_DIR', dir);
    const fetchMock = vi.fn(async () => jsonResponse(200, { notes: [] }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      // The audit's sequence: a self-host pair, then `kinjot key` with a hosted
      // key, while the MCP client's env still names the self-host endpoint.
      saveStoredAccount(`kj_live_${'S'.repeat(43)}`, selfHostUrl, dir);
      saveStoredKey(hostedKey, dir);
      const env = { KINJOT_MODE: 'account', KINJOT_CONFIG_DIR: dir, KINJOT_API_URL: selfHostUrl };

      expect(() => resolveConfig(env)).toThrow(
        `KINJOT_API_URL (${selfHostUrl}) differs from the endpoint saved with the key in`,
      );
      expect(() => resolveConfig(env)).toThrow(`(${DEFAULT_API_URL})`);
      await expect(async () => serveBackend(env).listRecentNotes(1)).rejects.toThrow(selfHostUrl);
      expect(fetchMock).not.toHaveBeenCalled();

      // The same pair with no environment URL, or the matching one, still works.
      expect(resolveConfig({ ...env, KINJOT_API_URL: undefined })).toEqual({
        apiUrl: DEFAULT_API_URL,
        apiKey: hostedKey,
      });
      expect(resolveConfig({ ...env, KINJOT_API_URL: DEFAULT_API_URL }).apiUrl).toBe(
        DEFAULT_API_URL,
      );

      // A hosted key pasted into `kinjot key` or `kinjot init` with that env URL
      // still set, and no --api-url, is neither sent there nor saved with it.
      const saved = readFileSync(configFilePath(dir), 'utf8');
      const refusal = `KINJOT_API_URL (${selfHostUrl}) is set in your environment`;
      const sink = { write: () => true };
      await expect(
        runKey({ env, readHidden: async () => hostedKey, stdout: sink, stderr: sink }),
      ).rejects.toThrow(refusal);
      vi.stubEnv('KINJOT_API_URL', selfHostUrl);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exitCode = process.exitCode;
      try {
        await main(['init', '--key', hostedKey]);
        expect(errors).toHaveBeenCalledWith(expect.stringContaining(refusal));
        expect(process.exitCode).toBe(1);
      } finally {
        process.exitCode = exitCode;
        errors.mockRestore();
      }
      expect(fetchMock).not.toHaveBeenCalled();
      expect(readFileSync(configFilePath(dir), 'utf8')).toBe(saved);

      // The mirror (#1904): a hosted KINJOT_API_KEY left in the shell is never
      // sent to the endpoint `init-selfhost` sets up; the piped key is, and
      // with nothing piped nothing is sent.
      const selfKey = `kj_live_${'B'.repeat(43)}`;
      const notices = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
      const failures = vi.spyOn(console, 'error').mockImplementation(() => {});
      const stdin = Object.getOwnPropertyDescriptor(process, 'stdin');
      const pipe = (text: string, isTTY = false) => {
        const input = Object.assign(Readable.from([Buffer.from(text)]), {
          isTTY,
          setRawMode: () => input,
        });
        Object.defineProperty(process, 'stdin', { configurable: true, value: input });
      };
      try {
        vi.unstubAllEnvs();
        vi.stubEnv('KINJOT_CONFIG_DIR', dir);
        vi.stubEnv('KINJOT_API_KEY', hostedKey);
        vi.stubEnv('KINJOT_API_URL', undefined);
        pipe(`${selfKey}\n`);
        await main(['init-selfhost', '--api-url', selfHostUrl]);
        expect(process.exitCode).toBe(exitCode);
        const sent = (fetchMock.mock.calls as unknown as [string, RequestInit][]).map(
          ([url, init]) => [url, new Headers(init.headers).get('authorization')] as const,
        );
        expect(sent.length).toBeGreaterThan(0);
        expect(
          sent.every(([url, auth]) => url.startsWith(selfHostUrl) && auth === `Bearer ${selfKey}`),
        ).toBe(true);
        expect(notices.mock.calls.join('')).toContain(
          'KINJOT_API_KEY is set in your environment, but `kinjot init-selfhost` never sends it',
        );

        fetchMock.mockClear();
        pipe('');
        await main(['init-selfhost', '--api-url', selfHostUrl]);
        expect(process.exitCode).toBe(1);
        expect(fetchMock).not.toHaveBeenCalled();

        // On a TTY, a typed project ref and an empty hidden answer send nothing.
        process.exitCode = exitCode;
        pipe(`${'p'.repeat(20)}\r\r`, true);
        await main(['init-selfhost']);
        expect(process.exitCode).toBe(1);
        expect(fetchMock).not.toHaveBeenCalled();

        // `kinjot init` with a self-host --api-url and no --key refuses the env key.
        process.exitCode = exitCode;
        failures.mockClear();
        await main(['init', '--api-url', selfHostUrl]);
        expect(failures).toHaveBeenCalledWith(
          expect.stringContaining(
            'KINJOT_API_KEY is set in your environment, but `kinjot init` only sends a key',
          ),
        );
        expect(process.exitCode).toBe(1);
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        process.exitCode = exitCode;
        if (stdin) Object.defineProperty(process, 'stdin', stdin);
        notices.mockRestore();
        out.mockRestore();
        logs.mockRestore();
        failures.mockRestore();
      }
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildServer', () => {
  it('jot forwards title, body, tags, and folder in the save request', async () => {
    const uuid = vi
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue('11111111-1111-4111-8111-111111111111');
    try {
      const fetchMock = vi.fn(async () =>
        jsonResponse(200, { note: { id: 'n1', title: 'Deploy notes', created_at: 'now' } }),
      );
      const server = buildServer(
        new NotesApi(
          { apiUrl: 'https://api.example', apiKey: GOOD_KEY },
          fetchMock as unknown as typeof fetch,
        ),
        '0.0.0-test',
        { repoTag: 'my-repo' },
      );
      await registeredTools(server).jot!.handler(
        { title: 'Deploy notes', body: 'Fix the proxy', tags: ['Infra'], folder: 'Operations' },
        {},
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(
        (fetchMock.mock.calls[0]! as unknown as [string, RequestInit])[1].body as string,
      );
      expect(body).toEqual({
        action: 'save_note',
        id: '11111111-1111-4111-8111-111111111111',
        title: 'Deploy notes',
        body: 'Fix the proxy',
        tags: ['infra', 'my-repo'],
        folder: 'Operations',
        source: 'mcp',
      });
    } finally {
      uuid.mockRestore();
    }
  });

  it('edit_jot forwards every accepted field in the edit request', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        note: { id: 'n1', short_id: 1, title: 'Updated notes', updated_at: 'now' },
      }),
    );
    const server = buildServer(
      new NotesApi(
        { apiUrl: 'https://api.example', apiKey: GOOD_KEY },
        fetchMock as unknown as typeof fetch,
      ),
      '0.0.0-test',
      { repoTag: null },
    );
    await registeredTools(server).edit_jot!.handler(
      {
        id: 'A10',
        old_string: 'before',
        new_string: 'after',
        title: 'Updated notes',
        add_tags: ['Infra'],
        remove_tags: ['#Old'],
        folder: 'Operations',
      },
      {},
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (fetchMock.mock.calls[0]! as unknown as [string, RequestInit])[1].body as string,
    );
    expect(body).toEqual({
      action: 'edit_note',
      short_id: 1,
      old_string: 'before',
      new_string: 'after',
      title: 'Updated notes',
      add_tags: ['infra'],
      remove_tags: ['old'],
      folder: 'Operations',
      source: 'mcp',
    });
  });

  it('K2: a #-prefixed agent tag joins its plain spelling and edit_jot removes it by that key', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(request);
      return request.action === 'save_note'
        ? jsonResponse(200, {
            note: { id: 'n1', title: request.title, created_at: 'now' },
            existing_tags: ['#infra', 'db'],
          })
        : jsonResponse(200, { note: { id: 'n1', short_id: 1, title: 't', updated_at: 'now' } });
    });
    const server = buildServer(
      new NotesApi(
        { apiUrl: 'https://api.example', apiKey: GOOD_KEY },
        fetchMock as unknown as typeof fetch,
      ),
      '0.0.0-test',
      { repoTag: null },
    );
    const tools = registeredTools(server);
    await tools.jot!.handler({ title: 'One', body: 'b', tags: ['#Infra'] }, {});
    await tools.jot!.handler({ title: 'Two', body: 'b', tags: ['##Infra', 'Auth Flow'] }, {});
    await tools.edit_jot!.handler(
      { id: 'A10', add_tags: ['#DB'], remove_tags: ['#Infra', '#Auth Flow', '# Infra'] },
      {},
    );

    expect(
      bodies.map(({ action, tags, add_tags, remove_tags }) => ({
        action,
        tags,
        add_tags,
        remove_tags,
      })),
    ).toEqual([
      { action: 'save_note', tags: ['infra'], add_tags: undefined, remove_tags: undefined },
      {
        action: 'save_note',
        tags: ['infra', 'auth-flow'],
        add_tags: undefined,
        remove_tags: undefined,
      },
      {
        action: 'edit_note',
        tags: undefined,
        add_tags: ['db'],
        remove_tags: ['infra', 'auth-flow', 'infra'],
      },
    ]);
  });

  it('find_jots forwards the full multi-word query in the search request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { notes: [], total: 0 }));
    const server = buildServer(
      new NotesApi(
        { apiUrl: 'https://api.example', apiKey: GOOD_KEY },
        fetchMock as unknown as typeof fetch,
      ),
      '0.0.0-test',
      { repoTag: null },
    );
    await registeredTools(server).find_jots!.handler({ query: 'nginx proxy failure' }, {});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (fetchMock.mock.calls[0]! as unknown as [string, RequestInit])[1].body as string,
    );
    expect(body).toEqual({ action: 'search_notes', query: 'nginx proxy failure' });
  });
});
