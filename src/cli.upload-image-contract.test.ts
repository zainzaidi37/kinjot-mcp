import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { png } from './image-fixture.js';
import { main } from './cli.js';

const KEY = `kj_live_${'a'.repeat(43)}`;
const PUBLIC = 'https://images.example/image.png';
const GRANT = {
  uploadUrl: 'https://storage.example/object?credential=private',
  method: 'PUT',
  headers: { 'content-type': 'image/png' },
  publicUrl: PUBLIC,
  expiresAt: '2026-09-25T00:00:00Z',
  expiresInSeconds: 600,
};

describe('upload-image CLI contract', () => {
  let dir: string;
  let file: string;
  let stdout: string[];
  let stderr: string[];
  let calls: { url: string; init: RequestInit }[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kinjot-cli-image-'));
    file = join(dir, 'shot.png');
    writeFileSync(file, png(2, 3));
    stdout = [];
    stderr = [];
    calls = [];
    vi.stubEnv('KINJOT_CONFIG_DIR', dir);
    vi.stubEnv('KINJOT_MODE', 'account');
    vi.stubEnv('KINJOT_API_KEY', KEY);
    vi.stubEnv('KINJOT_API_URL', 'https://api.example/mcp-api');
    vi.spyOn(console, 'log').mockImplementation((message) => void stdout.push(String(message)));
    vi.spyOn(console, 'error').mockImplementation((message) => void stderr.push(String(message)));
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return calls.length === 1 ? Response.json(GRANT) : new Response(null, { status: 200 });
      }),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    process.exitCode = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts argv, leaves stdout as one composable Markdown line, and audits on stderr', async () => {
    await main(['upload-image', file, '--alt', 'Result']);
    expect(stdout).toEqual([`![Result](${PUBLIC})`]);
    expect(stderr).toEqual([`uploaded ${file} (${png(2, 3).byteLength} bytes, 2×3)`]);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      action: 'image_upload',
      ext: 'png',
      bytes: png(2, 3).byteLength,
    });
    expect(calls[1]?.url).toBe(GRANT.uploadUrl);
  });

  it('prints one JSON object on stdout for --json', async () => {
    await main(['upload-image', '--json', file]);
    expect(stderr).toEqual([`uploaded ${file} (${png(2, 3).byteLength} bytes, 2×3)`]);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0] ?? '')).toEqual({
      markdown: `![image](${PUBLIC})`,
      url: PUBLIC,
      path: file,
      bytes: png(2, 3).byteLength,
      width: 2,
      height: 3,
    });
  });

  it('returns 2 for missing path and unknown flags', async () => {
    await main(['upload-image']);
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
    await main(['upload-image', file, '--other', 'value']);
    expect(process.exitCode).toBe(2);
    expect(calls).toEqual([]);
  });

  // A second positional argument is a usage error with exit status 2.
  it('rejects a second upload-image path', async () => {
    await main(['upload-image', file, 'other.png']);
    expect(process.exitCode).toBe(2);
    expect(calls).toEqual([]);
  });

  // The stderr audit line strips C0 controls from a real image path.
  it('sanitizes a controlled filename in the audit line', async () => {
    const controlled = join(dir, 'shot\x1b[31m\x07.png');
    writeFileSync(controlled, png(2, 3));
    await main(['upload-image', controlled]);
    expect(stderr).toEqual([
      `uploaded ${join(dir, 'shot[31m.png')} (${png(2, 3).byteLength} bytes, 2×3)`,
    ]);
    expect(process.exitCode).toBe(undefined);
  });

  // CLI paths remain relative to its working directory.
  it('resolves a relative image path for the CLI', async () => {
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      await main(['upload-image', 'shot.png']);
      expect(stdout).toEqual([`![image](${PUBLIC})`]);
      expect(stderr).toEqual([`uploaded ${file} (${png(2, 3).byteLength} bytes, 2×3)`]);
    } finally {
      process.chdir(cwd);
    }
  });

  it('returns 4 for local mode and key_access', async () => {
    vi.stubEnv('KINJOT_MODE', 'local');
    await main(['upload-image', file]);
    expect(process.exitCode).toBe(4);
    expect(calls).toEqual([]);
    process.exitCode = undefined;
    vi.stubEnv('KINJOT_MODE', 'account');
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ code: 'key_access', error: 'Read key cannot create' }, { status: 403 }),
        ),
    );
    await main(['upload-image', file]);
    expect(process.exitCode).toBe(4);
  });

  it('returns 4 for an older backend and 1 for an upload failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ error: 'unknown action' }, { status: 400 })),
    );
    await main(['upload-image', file]);
    expect(process.exitCode).toBe(4);
    process.exitCode = undefined;
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(GRANT))
        .mockResolvedValueOnce(new Response(null, { status: 403 })),
    );
    await main(['upload-image', file]);
    expect(process.exitCode).toBe(1);
    expect(stderr.join('\n')).not.toContain(GRANT.uploadUrl);
  });
});
