import { chmodSync, mkdirSync, mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { gitContext, remoteRepo } from './git-context.js';

const root = mkdtempSync(join(tmpdir(), 'kinjot-git-context-'));
let dir: string;

beforeEach(() => {
  mkdirSync(root, { recursive: true });
  dir = mkdtempSync(join(root, 'git-context-'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
afterAll(() => {
  try {
    rmdirSync(root);
  } catch {
    /* leave a pre-existing or occupied tmp directory */
  }
});

function fakeGit(body: string): void {
  const bin = join(dir, 'git');
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  vi.stubEnv('PATH', `${dir}:${process.env.PATH}`);
}

it.each([
  ['git@private.example:owner/name.git', 'owner/name'],
  ['user@host:owner/name', 'owner/name'],
  ['ssh://user:secret@host/owner/name.git', 'owner/name'],
  ['https://user:secret@host/owner/name', 'owner/name'],
  ['https://host/owner/name.git', 'owner/name'],
  ['user:secret@host:owner/name', undefined],
])('parses remote %s as only owner/name', (remote, expected) => {
  const repo = remoteRepo(remote);
  expect(repo).toBe(expected);
  expect(repo ?? '').not.toContain('secret');
  expect(repo ?? '').not.toContain('host');
});

it('uses origin and branch, with safe git flags and no credential in context', async () => {
  const log = join(dir, 'calls');
  vi.stubEnv('GIT_TEST_LOG', log);
  fakeGit(
    'printf "%s\\n" "$*" >> "$GIT_TEST_LOG"\ncase "$*" in\n  *--show-toplevel) printf "%s\\n" "$GIT_TEST_TOP";;\n  *get-url*) printf "%s\\n" "https://user:secret@host/owner/name.git";;\n  *symbolic-ref*) printf "feature/inbox\\n";;\nesac',
  );
  vi.stubEnv('GIT_TEST_TOP', dir);
  expect(await gitContext(dir)).toEqual({ repo: 'owner/name', branch: 'feature/inbox' });
  const calls = (await import('node:fs')).readFileSync(log, 'utf8').trim().split('\n');
  expect(calls).toEqual([
    `-c core.fsmonitor=false -C ${dir} rev-parse --show-toplevel`,
    `-c core.fsmonitor=false -C ${dir} remote get-url origin`,
    `-c core.fsmonitor=false -C ${dir} symbolic-ref --quiet --short HEAD`,
  ]);
});

it('ignores inherited GIT_DIR pointing at another repository and uses cwd', async () => {
  const cwdRepo = join(dir, 'cwd-repository');
  const otherRepo = join(dir, 'other-repository');
  mkdirSync(cwdRepo);
  mkdirSync(otherRepo);
  vi.stubEnv('GIT_DIR', otherRepo);
  vi.stubEnv('GIT_WORK_TREE', otherRepo);
  vi.stubEnv('GIT_INDEX_FILE', join(otherRepo, 'index'));
  vi.stubEnv('GIT_CEILING_DIRECTORIES', otherRepo);
  vi.stubEnv('GIT_COMMON_DIR', otherRepo);
  vi.stubEnv('GIT_TEST_TOP', cwdRepo);
  fakeGit(
    'if [ -n "$GIT_DIR" ] || [ -n "$GIT_WORK_TREE" ] || [ -n "$GIT_INDEX_FILE" ] || [ -n "$GIT_CEILING_DIRECTORIES" ] || [ -n "$GIT_COMMON_DIR" ] || [ "$GIT_OPTIONAL_LOCKS" != 0 ]; then printf "other-repository\\n"; exit 0; fi\ncase "$*" in\n  *--show-toplevel) printf "%s\\n" "$GIT_TEST_TOP";;\n  *get-url*) exit 1;;\n  *symbolic-ref*) printf "cwd-branch\\n";;\nesac',
  );
  expect(await gitContext(cwdRepo)).toEqual({ repo: 'cwd-repository', branch: 'cwd-branch' });
  expect(process.env.GIT_DIR).toBe(otherRepo);
});

it('falls back to top basename without origin and names a detached HEAD', async () => {
  fakeGit(
    'case "$*" in\n  *--show-toplevel) printf "%s\\n" "$GIT_TEST_TOP";;\n  *rev-parse*--short*) printf "abc1234\\n";;\n  *) exit 1;;\nesac',
  );
  vi.stubEnv('GIT_TEST_TOP', dir);
  expect(await gitContext(dir)).toEqual({
    repo: dir.split('/').at(-1),
    branch: '(detached abc1234)',
  });
});

it('omits fields outside a repository', async () => {
  fakeGit('exit 1');
  expect(await gitContext(dir)).toEqual({});
});

it('keeps repo and branch at their caps and omits either one character over', async () => {
  fakeGit(
    'case "$*" in\n  *--show-toplevel) printf "%s\\n" "$GIT_TEST_TOP";;\n  *get-url*) printf "https://host/o/%s\\n" "$GIT_TEST_NAME";;\n  *symbolic-ref*) printf "%s\\n" "$GIT_TEST_BRANCH";;\nesac',
  );
  vi.stubEnv('GIT_TEST_TOP', dir);
  vi.stubEnv('GIT_TEST_NAME', 'n'.repeat(98));
  vi.stubEnv('GIT_TEST_BRANCH', 'b'.repeat(200));
  expect(await gitContext(dir)).toEqual({ repo: `o/${'n'.repeat(98)}`, branch: 'b'.repeat(200) });
  vi.stubEnv('GIT_TEST_NAME', 'n'.repeat(99));
  vi.stubEnv('GIT_TEST_BRANCH', 'b'.repeat(201));
  expect(await gitContext(dir)).toEqual({});
  vi.stubEnv('GIT_TEST_NAME', 'name');
  vi.stubEnv('GIT_TEST_BRANCH', '😀'.repeat(200));
  expect(await gitContext(dir)).toEqual({ repo: 'o/name', branch: '😀'.repeat(200) });
});

it.each(['relative', '/missing/kinjot-directory', '/bad\npath'])(
  'falls back from invalid cwd %j',
  async (bad) => {
    const log = join(dir, 'calls');
    vi.stubEnv('GIT_TEST_LOG', log);
    fakeGit('printf "%s\\n" "$*" >> "$GIT_TEST_LOG"\nexit 1');
    expect(await gitContext(bad)).toEqual({});
    expect((await import('node:fs')).readFileSync(log, 'utf8')).toContain(
      `-C ${process.cwd()} rev-parse`,
    );
  },
);

it('cuts a hung git process at its timeout', async () => {
  fakeGit('sleep 5');
  const started = Date.now();
  expect(await gitContext(dir)).toEqual({});
  expect(Date.now() - started).toBeLessThan(2_500);
}, 4_000);
