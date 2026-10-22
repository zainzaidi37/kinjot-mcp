import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';

// K2 (#1499): the Claude Code Stop hook derives a reply's title and execs
// `kinjot add <title>`, and `main` refuses a lone flag-shaped title (`---`)
// with exit 2. The hook's real argv and stdin are recorded by a `kinjot`
// stand-in on PATH, then replayed into this package's real `main`.

const STOP_HOOK = fileURLToPath(
  new URL(
    '../../../integrations/claude-code/plugins/kinjot/scripts/stop-hook.mjs',
    import.meta.url,
  ),
);
const KEY = `kj_live_${'C'.repeat(43)}`;
const saved = { env: { ...process.env }, stdin: Object.getOwnPropertyDescriptor(process, 'stdin') };
let dir: string | undefined;

afterEach(() => {
  process.env = { ...saved.env };
  if (saved.stdin) Object.defineProperty(process, 'stdin', saved.stdin);
  process.exitCode = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

it('saves an autosaved reply that opens with a Markdown rule through the CLI the hook calls', async () => {
  dir = mkdtempSync(join(tmpdir(), 'kinjot-capture-title-'));
  const record = join(dir, 'call.json');
  const shim = join(dir, 'kinjot');
  writeFileSync(
    shim,
    `#!${process.execPath}\n` +
      `const chunks = [];\n` +
      `process.stdin.on('data', (c) => chunks.push(c)).on('end', () => {\n` +
      `  require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({\n` +
      `    argv: process.argv.slice(2), stdin: Buffer.concat(chunks).toString('utf8') }));\n` +
      `});\n`,
  );
  chmodSync(shim, 0o755);
  const reply = '---\n\nThe migration landed and the backfill finished.';
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`,
    KINJOT_AUTOCAPTURE: '1',
  };
  delete env.CLAUDE_PLUGIN_DATA;
  const hook = spawnSync(process.execPath, [STOP_HOOK], {
    cwd: dir,
    env,
    input: JSON.stringify({ last_assistant_message: reply, cwd: dir }),
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(hook.status, hook.stderr).toBe(0);
  const call = JSON.parse(readFileSync(record, 'utf8')) as { argv: string[]; stdin: string };

  process.env = {
    ...saved.env,
    KINJOT_API_KEY: KEY,
    KINJOT_API_URL: 'https://example.test/functions/v1/mcp-api',
    KINJOT_CONFIG_DIR: dir,
    KINJOT_MODE: 'account',
  };
  Object.defineProperty(process, 'stdin', {
    configurable: true,
    value: Readable.from([Buffer.from(call.stdin)]),
  });
  const bodies: Array<{ action: string; title?: string; body?: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as { action: string; title?: string };
      bodies.push(request);
      return new Response(
        JSON.stringify({
          ai_excluded: false,
          note: {
            id: crypto.randomUUID(),
            title: request.title,
            created_at: '2026-10-22T00:00:00Z',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { main } = await import('./cli.js');
  await main(call.argv);

  expect(errors.mock.calls).toEqual([]);
  expect(process.exitCode ?? 0).toBe(0);
  expect(bodies).toHaveLength(1);
  expect(bodies[0]!.action).toBe('save_note');
  expect(bodies[0]!.body).toContain(reply);
});
