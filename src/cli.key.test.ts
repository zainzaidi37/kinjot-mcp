import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_API_URL } from './config.js';
import { configFilePath } from './configFile.js';

const GOOD_KEY = `kj_live_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V'.slice(0, 43)}`;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function setupResponse(init: RequestInit): Response {
  const { action } = JSON.parse(String(init.body)) as { action: string };
  return jsonResponse(200, action === 'key_info' ? { access: 'read_create' } : { notes: [] });
}

function capture() {
  const lines: string[] = [];
  return { write: (s: string) => (lines.push(s), true), all: () => lines.join('') };
}

describe('runKey', () => {
  let dir: string;
  let prevConfigDir: string | undefined;
  let prevApiKey: string | undefined;
  let prevApiUrl: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kinjot-key-'));
    prevConfigDir = process.env.KINJOT_CONFIG_DIR;
    prevApiKey = process.env.KINJOT_API_KEY;
    prevApiUrl = process.env.KINJOT_API_URL;
    process.env.KINJOT_CONFIG_DIR = dir;
    delete process.env.KINJOT_API_KEY;
    delete process.env.KINJOT_API_URL;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.KINJOT_CONFIG_DIR;
    else process.env.KINJOT_CONFIG_DIR = prevConfigDir;
    if (prevApiKey === undefined) delete process.env.KINJOT_API_KEY;
    else process.env.KINJOT_API_KEY = prevApiKey;
    if (prevApiUrl === undefined) delete process.env.KINJOT_API_URL;
    else process.env.KINJOT_API_URL = prevApiUrl;
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('happy path: validates the pasted key in one request, saves it, and prints success', async () => {
    process.env.KINJOT_API_KEY = `kj_live_${'B'.repeat(43)}`;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init: RequestInit) =>
      setupResponse(init),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { runKey } = await import('./cli.js');
    const stdout = capture();
    const stderr = capture();

    await runKey({ readHidden: async () => GOOD_KEY, stdout, stderr, env: process.env });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe(DEFAULT_API_URL);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${GOOD_KEY}`);
    expect(existsSync(configFilePath(dir))).toBe(true);
    expect(JSON.parse(readFileSync(configFilePath(dir), 'utf8')).apiKey).toBe(GOOD_KEY);
    expect(JSON.parse(readFileSync(configFilePath(dir), 'utf8')).apiUrl).toBeUndefined();
    expect(stdout.all()).toMatch(/ok ✔/);
    expect(stdout.all()).toContain(
      'API key access: Read and create — can read and create notes; edits, appends and session autosave need a full-access key.',
    );
    expect(stdout.all()).toContain('mcpServers');
    expect(stdout.all()).toContain('claude mcp add kinjot -- npx -y kinjot');
    expect(stdout.all()).toContain('codex mcp add kinjot -- npx -y kinjot');
    // The one-line commands come first; the JSON is the fallback for other clients.
    const output = stdout.all();
    expect(output.indexOf('claude mcp add')).toBeLessThan(output.indexOf('codex mcp add'));
    expect(output.indexOf('codex mcp add')).toBeLessThan(output.indexOf('mcpServers'));
  });

  it('refuses an API-rejected pasted key without replacing the saved account', async () => {
    const { saveStoredKey } = await import('./configFile.js');
    const previousKey = `kj_live_${'C'.repeat(43)}`;
    saveStoredKey(previousKey, dir);
    const before = readFileSync(configFilePath(dir), 'utf8');
    const fetchMock = vi.fn(async () => jsonResponse(401, { error: 'invalid API key' }));
    vi.stubGlobal('fetch', fetchMock);
    const { runKey } = await import('./cli.js');
    const stdout = capture();

    await expect(
      runKey({ readHidden: async () => GOOD_KEY, stdout, stderr: capture(), env: process.env }),
    ).rejects.toThrow('API key was rejected');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readFileSync(configFilePath(dir), 'utf8')).toBe(before);
    expect(stdout.all()).not.toContain('ok ✔');
  });
});
