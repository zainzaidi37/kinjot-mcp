import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { main } from './cli.js';
import { cachedMuteState, refreshMute } from './inbox-cache.js';

vi.mock('./git-context.js', () => ({
  gitContext: vi.fn(async () => ({ repo: 'owner/name', branch: 'feature/inbox' })),
}));

const ID = '1a2b3c4d-1111-4111-8111-111111111111';
const KEY_A = `kj_live_${'A'.repeat(43)}`;
const KEY_B = `kj_live_${'B'.repeat(43)}`;
const reply = {
  id: ID,
  status: 'sent',
  repeat_count: 1,
  send_kinds: ['question', 'blocker', 'handoff'],
  key_muted: false,
  truncated: [],
};
let dir: string;
let output: string[];
let errors: string[];
let requests: { url: string; body: unknown }[];

function stdin(value: string): void {
  const stream = Object.assign(Readable.from([Buffer.from(value)]), { isTTY: false });
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(stream as typeof process.stdin);
}

function fakeFetch(answer: unknown = reply, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json(answer, { status });
    }),
  );
}

const waitingArgv = [
  'notify',
  '--input-json',
  '--kind',
  'waiting',
  '--session',
  'session_1',
  '--id',
  ID,
  '--json',
];
const waitingText = JSON.stringify({ title: 'Last reply paragraph', detail: 'Private detail' });
const muteRequest = { url: 'https://api.example/mcp-api', body: { action: 'inbox_mute_state' } };
const waitingRequest = {
  url: 'https://api.example/mcp-api',
  body: {
    action: 'inbox_notify',
    id: '1a2b3c4d-1111-4111-8111-111111111111',
    kind: 'waiting',
    title: 'Last reply paragraph',
    detail: 'Private detail',
    context: { repo: 'owner/name', branch: 'feature/inbox', session_id: 'session_1' },
    source: 'cli',
  },
};

function fakeWaiting(
  check: Response | 'network',
  sent: Response = Response.json({
    ...reply,
    send_kinds: ['question', 'blocker', 'handoff', 'waiting'],
  }),
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { action: string };
      requests.push({ url, body });
      if (body.action === 'inbox_mute_state') {
        if (check === 'network') throw new Error('offline');
        return check;
      }
      if (body.action === 'inbox_notify') return sent;
      throw new Error(`unexpected action: ${body.action}`);
    }),
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kinjot-cli-inbox-'));
  vi.stubEnv('KINJOT_CONFIG_DIR', dir);
  vi.stubEnv('KINJOT_MODE', 'account');
  vi.stubEnv('KINJOT_API_URL', 'https://api.example/mcp-api');
  vi.stubEnv('KINJOT_API_KEY', KEY_A);
  output = [];
  errors = [];
  requests = [];
  vi.spyOn(console, 'log').mockImplementation((value) => output.push(String(value)));
  vi.spyOn(console, 'error').mockImplementation((value) => errors.push(String(value)));
  stdin('');
  fakeFetch();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  rmSync(dir, { recursive: true, force: true });
});

it('notify --input-json keeps a leading -- title out of argv and prints exact JSON', async () => {
  stdin(JSON.stringify({ title: '--private reply', detail: 'From stdin' }));
  await main(['notify', '--input-json', '--kind', 'question', '--json', '--id', ID]);
  expect(process.exitCode).toBeUndefined();
  expect(output).toEqual([JSON.stringify({ id: ID, status: 'sent', repeat_count: 1 })]);
  expect(requests[0]!.body).toEqual({
    action: 'inbox_notify',
    id: ID,
    kind: 'question',
    title: '--private reply',
    detail: 'From stdin',
    context: { repo: 'owner/name', branch: 'feature/inbox' },
    source: 'cli',
  });
  expect(requests[0]!.body).not.toHaveProperty('argv');
});

it('notify rejects a positional title with --input-json before any request', async () => {
  stdin(JSON.stringify({ title: 'stdin title' }));
  await main(['notify', 'argv title', '--input-json', '--kind', 'question']);
  expect(process.exitCode).toBe(2);
  expect(requests).toEqual([]);
});

it('notify accepts a positional title beginning with -- and empty stdin means no detail', async () => {
  stdin('');
  await main(['notify', '--leading title', '--kind', 'handoff', '--id', ID]);
  expect(requests[0]!.body).toEqual({
    action: 'inbox_notify',
    id: ID,
    kind: 'handoff',
    title: '--leading title',
    context: { repo: 'owner/name', branch: 'feature/inbox' },
    source: 'cli',
  });
});

it('notify reads piped detail and sends validated flags with three PRs', async () => {
  stdin('piped detail');
  await main([
    'notify',
    'A handoff',
    '--kind',
    'handoff',
    '--id',
    ID,
    '--pr',
    'https://github.com/o/r/pull/1',
    '--pr',
    'https://wrong.test',
    '--pr',
    'https://github.com/o/r/pull/2',
    '--note',
    '#a10',
    '--session',
    'Session_1',
    '--agent',
    'codex',
    '--no-cache',
  ]);
  expect(requests[0]!.body).toEqual({
    action: 'inbox_notify',
    id: ID,
    kind: 'handoff',
    title: 'A handoff',
    detail: 'piped detail',
    context: {
      repo: 'owner/name',
      branch: 'feature/inbox',
      agent: 'codex',
      prs: ['https://github.com/o/r/pull/1', 'https://github.com/o/r/pull/2'],
      note: 'A10',
      session_id: 'Session_1',
    },
    source: 'cli',
  });
});

it.each([
  [['notify', 'Idle', '--kind', 'waiting'], 2, 'invalid_session'],
  [['notify', 'Idle', '--kind', 'waiting', '--session', 'bad!'], 2, '--session is invalid'],
  [['notify', 'Done', '--kind', 'done', '--agent', 'Bad Name'], 2, '--agent is invalid'],
  [['notify', 'Done', '--kind', 'done', '--id', 'bad'], 2, '--id must be a UUID'],
] as const)('notify validates session, agent and id: %j', async (argv, code, message) => {
  await main([...argv]);
  expect(process.exitCode).toBe(code);
  expect(errors.join('\n')).toContain(message);
  expect(requests).toEqual([]);
});

it('CLI cache hit makes no request, no-cache bypasses, and each answer refreshes it', async () => {
  fakeFetch({ ...reply, status: 'muted', send_kinds: ['handoff'] });
  await main(['notify', 'Ask', '--kind', 'question', '--id', ID]);
  expect(requests).toHaveLength(1);
  process.exitCode = undefined;
  await main(['notify', 'Ask again', '--kind', 'question', '--id', ID, '--json']);
  expect(requests).toHaveLength(1);
  expect(output.at(-1)).toBe(JSON.stringify({ id: ID, status: 'muted', repeat_count: 0 }));
  fakeFetch(reply);
  await main(['notify', 'Ask again', '--kind', 'question', '--id', ID, '--no-cache']);
  expect(requests).toHaveLength(2);
  await main(['notify', 'Ask again', '--kind', 'question', '--id', ID]);
  expect(requests).toHaveLength(3);
});

it('CLI mute cache is keyed by API URL and key prefix', async () => {
  fakeFetch({ ...reply, status: 'muted', key_muted: true });
  await main(['notify', 'A', '--kind', 'question', '--id', ID]);
  vi.stubEnv('KINJOT_API_KEY', KEY_B);
  await main(['notify', 'B', '--kind', 'question', '--id', ID]);
  vi.stubEnv('KINJOT_API_KEY', KEY_A);
  vi.stubEnv('KINJOT_API_URL', 'https://other.example/mcp-api');
  await main(['notify', 'C', '--kind', 'question', '--id', ID]);
  expect(requests.map((request) => request.url)).toEqual([
    'https://api.example/mcp-api',
    'https://api.example/mcp-api',
    'https://other.example/mcp-api',
  ]);
  expect(Object.keys(JSON.parse(readFileSync(join(dir, 'inbox-cache.json'), 'utf8')))).toHaveLength(
    3,
  );
});

it('corrupt cache is ignored and rewritten', async () => {
  writeFileSync(join(dir, 'inbox-cache.json'), '{broken');
  await main(['notify', 'A', '--kind', 'question', '--id', ID]);
  expect(requests).toHaveLength(1);
  expect(Object.keys(JSON.parse(readFileSync(join(dir, 'inbox-cache.json'), 'utf8')))).toHaveLength(
    1,
  );
});

it.each([
  ['kind', { send_kinds: ['question', 'blocker'], key_muted: false }],
  ['key', { send_kinds: ['question', 'waiting'], key_muted: true }],
] as const)(
  'cold waiting muted by %s checks without text and sends no notify',
  async (_why, state) => {
    stdin(waitingText);
    fakeWaiting(Response.json(state));
    await main(waitingArgv);
    expect(requests).toEqual([muteRequest]);
    expect(output).toEqual([JSON.stringify({ id: ID, status: 'muted', repeat_count: 0 })]);
    expect(process.exitCode).toBeUndefined();
    expect(
      cachedMuteState(dir, { apiUrl: 'https://api.example/mcp-api', apiKey: KEY_A }, 'waiting'),
    ).toBe('muted');
  },
);

it('cold waiting on checks without text and then sends the item', async () => {
  stdin(waitingText);
  fakeWaiting(Response.json({ send_kinds: ['question', 'waiting'], key_muted: false }));
  await main(waitingArgv);
  expect(requests).toEqual([muteRequest, waitingRequest]);
  expect(output).toEqual([JSON.stringify({ id: ID, status: 'sent', repeat_count: 1 })]);
  expect(process.exitCode).toBeUndefined();
});

it('warm waiting enabled sends only notify', async () => {
  refreshMute(
    dir,
    { apiUrl: 'https://api.example/mcp-api', apiKey: KEY_A },
    {
      send_kinds: ['waiting'],
      key_muted: false,
    },
  );
  stdin(waitingText);
  fakeWaiting(Response.json({ send_kinds: [], key_muted: true }));
  await main(waitingArgv);
  expect(requests).toEqual([waitingRequest]);
  expect(output).toEqual([JSON.stringify({ id: ID, status: 'sent', repeat_count: 1 })]);
});

it('waiting notify mute answer refreshes cache and suppresses the next send', async () => {
  const config = { apiUrl: 'https://api.example/mcp-api', apiKey: KEY_A };
  refreshMute(dir, config, { send_kinds: ['waiting'], key_muted: false });
  stdin(waitingText);
  fakeWaiting(
    Response.json({ send_kinds: ['waiting'], key_muted: false }),
    Response.json({ ...reply, status: 'muted', repeat_count: 0, send_kinds: ['question'] }),
  );
  await main(waitingArgv);
  expect(requests).toEqual([waitingRequest]);
  expect(cachedMuteState(dir, config, 'waiting')).toBe('muted');

  stdin(waitingText);
  await main(waitingArgv);
  expect(requests).toEqual([waitingRequest]);
  expect(output).toEqual([
    JSON.stringify({ id: ID, status: 'muted', repeat_count: 0 }),
    JSON.stringify({ id: ID, status: 'muted', repeat_count: 0 }),
  ]);
  expect(process.exitCode).toBeUndefined();
});

it('warm waiting muted sends no request', async () => {
  refreshMute(
    dir,
    { apiUrl: 'https://api.example/mcp-api', apiKey: KEY_A },
    {
      send_kinds: ['question'],
      key_muted: false,
    },
  );
  stdin(waitingText);
  await main(waitingArgv);
  expect(requests).toEqual([]);
  expect(output).toEqual([JSON.stringify({ id: ID, status: 'muted', repeat_count: 0 })]);
  expect(process.exitCode).toBeUndefined();
});

it('waiting --no-cache bypasses a warm mute and checks before sending', async () => {
  refreshMute(
    dir,
    { apiUrl: 'https://api.example/mcp-api', apiKey: KEY_A },
    {
      send_kinds: ['question'],
      key_muted: false,
    },
  );
  stdin(waitingText);
  fakeWaiting(Response.json({ send_kinds: ['waiting'], key_muted: false }));
  await main([...waitingArgv, '--no-cache']);
  expect(requests).toEqual([muteRequest, waitingRequest]);
  expect(output).toEqual([JSON.stringify({ id: ID, status: 'sent', repeat_count: 1 })]);
});

it('old backend rejects the waiting check with exit 4 and no notify', async () => {
  stdin(waitingText);
  fakeWaiting(Response.json({ error: 'unknown action' }, { status: 400 }));
  await main(waitingArgv);
  expect(requests).toEqual([muteRequest]);
  expect(process.exitCode).toBe(4);
  expect(errors).toEqual([
    'error: This Kinjot deployment does not support this Inbox action yet; its operator needs to update it.',
  ]);
});

it('waiting rejects a check missing key_muted and sends no notify', async () => {
  stdin(waitingText);
  fakeWaiting(Response.json({ send_kinds: ['waiting'] }));
  await main(waitingArgv);
  expect(requests).toEqual([muteRequest]);
  expect(output).toEqual([]);
  expect(process.exitCode).toBe(1);
});

it('waiting network check failure exits 1 and sends no notify', async () => {
  stdin(waitingText);
  fakeWaiting('network');
  await main(waitingArgv);
  expect(requests).toEqual([muteRequest]);
  expect(process.exitCode).toBe(1);
  expect(output).toEqual([]);
});

it.each([
  [401, { error: 'invalid or revoked API key', code: 'invalid_key' }, 1],
  [429, { error: 'Inbox cap reached; stop sending.', code: 'inbox_rate_limited' }, 1],
  [500, { error: 'internal error' }, 1],
  [400, { error: 'invalid_context', code: 'invalid_context' }, 2],
  [403, { error: 'This key cannot create.', code: 'key_access' }, 4],
] as const)('waiting check HTTP %i refuses without notify', async (status, body, exit) => {
  stdin(waitingText);
  fakeWaiting(Response.json(body, { status }));
  await main(waitingArgv);
  expect(requests).toEqual([muteRequest]);
  expect(process.exitCode).toBe(exit);
  expect(output).toEqual([]);
});

it('local waiting refuses before a request', async () => {
  vi.stubEnv('KINJOT_MODE', 'local');
  stdin(waitingText);
  await main(waitingArgv);
  expect(requests).toEqual([]);
  expect(process.exitCode).toBe(4);
});

it('question sends directly without a mute check', async () => {
  stdin(JSON.stringify({ title: 'Need a decision', detail: 'Choose A' }));
  await main(['notify', '--input-json', '--kind', 'question', '--id', ID, '--json']);
  expect(requests).toEqual([
    {
      url: 'https://api.example/mcp-api',
      body: {
        action: 'inbox_notify',
        id: '1a2b3c4d-1111-4111-8111-111111111111',
        kind: 'question',
        title: 'Need a decision',
        detail: 'Choose A',
        context: { repo: 'owner/name', branch: 'feature/inbox' },
        source: 'cli',
      },
    },
  ]);
  expect(output).toEqual([JSON.stringify({ id: ID, status: 'sent', repeat_count: 1 })]);
});

it('inbox listing preserves detail line breaks, strips terminal controls and keeps JSON exact', async () => {
  const response = {
    items: [
      {
        id: ID,
        kind: 'handoff',
        title: '\u001b[31mBad\ninjected',
        detail: 'line\r\n\tsecond\nthird\rfourth\u001b[0m\u009b31m\x7f\x00',
        context: {},
        repeat_count: 1,
        created_at: '2026-09-25',
        surfaced_at: '2026-09-25',
        key_name: null,
      },
    ],
    other_open: 2,
  };
  fakeFetch(response);
  await main(['inbox', '--all', '--kind', 'any']);
  expect(requests[0]!.body).toEqual({
    action: 'inbox_list',
    kinds: ['question', 'blocker', 'handoff', 'done'],
    limit: 10,
  });
  expect(process.exitCode).toBeUndefined();
  expect(errors).toEqual([]);
  expect(output).toEqual([
    `${ID}  HANDOFF  [31mBadinjected`,
    '  line\n  \tsecond\n  thirdfourth[0m31m',
    '2 other open Inbox items.',
  ]);
  output.length = 0;
  await main(['inbox', '--json']);
  expect(requests[1]!.body).toEqual({
    action: 'inbox_list',
    repo: 'owner/name',
    kinds: ['handoff'],
    limit: 10,
  });
  expect(JSON.parse(output[0]!)).toEqual(response);
  expect(output[0]).not.toContain('\u001b');
});

it('inbox listing uses the singular count for one other open item', async () => {
  fakeFetch({ items: [], other_open: 1 });
  await main(['inbox', '--all']);
  expect(output).toEqual(['1 other open Inbox item.']);
  expect(requests[0]!.body).toEqual({ action: 'inbox_list', kinds: ['handoff'], limit: 10 });
});

it('inbox resolve sends the exact body and prints its result', async () => {
  fakeFetch({ id: ID, status: 'resolved' });
  await main(['inbox', 'resolve', '1a2b3c4d', '--note', 'Picked up']);
  expect(requests[0]!.body).toEqual({
    action: 'inbox_resolve',
    ref: '1a2b3c4d',
    resolution: 'Picked up',
  });
  expect(output).toEqual(['Resolved 1a2b3c4d.']);
});

it.each([
  ['inbox_access_off', 403, 2],
  ['invalid_request', 400, 2],
  ['invalid_id', 400, 2],
  ['id_conflict', 409, 2],
  ['inbox_ambiguous_id', 409, 2],
  ['inbox_item_not_found', 404, 3],
  ['key_access', 403, 4],
  ['inbox_rate_limited', 429, 1],
] as const)('CLI exit code uses %s code, not server message', async (code, status, expected) => {
  fakeFetch({ code, error: 'arbitrary wording' }, status);
  await main(['notify', 'Ask', '--kind', 'question', '--id', ID, '--no-cache']);
  expect(process.exitCode).toBe(expected);
  expect(errors).toEqual(['error: arbitrary wording']);
});

it.each([
  [401, { error: 'invalid or revoked API key' }],
  [500, { error: 'internal error' }],
  [429, { error: 'Inbox cap reached; stop sending.', code: 'inbox_rate_limited' }],
] as const)('CLI treats HTTP %i as ambiguous exit 1', async (status, body) => {
  fakeFetch(body, status);
  await main(['notify', 'Ask', '--kind', 'question', '--id', ID, '--no-cache']);
  expect(process.exitCode).toBe(1);
});

it.each([
  ['notify', ['notify', 'Ask', '--kind', 'question', '--id', ID, '--no-cache']],
  ['list', ['inbox', '--all']],
  ['resolve', ['inbox', 'resolve', '1a2b3c4d']],
] as const)('coded invalid_key 401 on Inbox %s exits 1 with the key hint', async (_name, argv) => {
  fakeFetch({ error: 'invalid or revoked API key', code: 'invalid_key' }, 401);
  await main([...argv]);
  expect(process.exitCode).toBe(1);
  expect(errors).toEqual([
    'error: API key was rejected — it may have been revoked. Create a new one in Settings → API keys.',
  ]);
  expect(requests).toHaveLength(1);
});

it('coded rate_limited 429 uses ambiguous exit 1 and the server message', async () => {
  fakeFetch({ error: 'rate limit exceeded (60 writes/min)', code: 'rate_limited' }, 429);
  await main(['notify', 'Ask', '--kind', 'question', '--id', ID, '--no-cache']);
  expect(process.exitCode).toBe(1);
  expect(errors).toEqual(['error: rate limit exceeded (60 writes/min)']);
});

it('an unlisted invalid code does not become a definite exit 2', async () => {
  fakeFetch({ error: 'invalid or revoked API key', code: 'invalid_key' }, 400);
  await main(['notify', 'Ask', '--kind', 'question', '--id', ID, '--no-cache']);
  expect(process.exitCode).toBe(1);
  expect(errors).toEqual(['error: invalid or revoked API key']);
});

it.each([401, 429, 503])(
  'HTTP %i takes precedence over a definite refusal code',
  async (status) => {
    fakeFetch({ error: 'wrong status for this code', code: 'invalid_id' }, status);
    await main(['notify', 'Ask', '--kind', 'question', '--id', ID, '--no-cache']);
    expect(process.exitCode).toBe(1);
  },
);

it('recall 503 with ai_configuration_missing exits 1 with the server message', async () => {
  fakeFetch(
    { error: 'AI is not configured for this deployment.', code: 'ai_configuration_missing' },
    503,
  );
  await main(['recall', 'query']);
  expect(process.exitCode).toBe(1);
  expect(errors).toEqual(['error: AI is not configured for this deployment.']);
  expect(requests[0]!.body).toEqual({ action: 'recall', query: 'query' });
});

it('CLI treats a network failure as ambiguous exit 1', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('offline');
    }),
  );
  await main(['notify', 'Ask', '--kind', 'question', '--id', ID, '--no-cache']);
  expect(process.exitCode).toBe(1);
});

it('old backend and local mode exit 4', async () => {
  fakeFetch({ error: 'unknown action' }, 400);
  await main(['notify', 'Ask', '--kind', 'question', '--id', ID]);
  expect(process.exitCode).toBe(4);
  expect(errors.at(-1)).toContain('This Kinjot deployment does not have the Inbox yet');
  process.exitCode = undefined;
  vi.stubEnv('KINJOT_MODE', 'local');
  await main(['inbox']);
  expect(process.exitCode).toBe(4);
  expect(errors.at(-1)).toContain('The Kinjot Inbox needs a Kinjot account');
});
