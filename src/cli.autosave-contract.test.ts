import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotesApi } from './api.js';
import { main } from './cli.js';

const NOTE_ID = '12345678-1234-8234-8234-123456789abc';
const KEY = `kj_live_${'a'.repeat(43)}`;
const API_URL = 'http://127.0.0.1:9/functions/v1/mcp-api';
const config = { apiUrl: API_URL, apiKey: KEY };

const edited = { id: NOTE_ID, short_id: 10, title: 'Target', updated_at: '2026-09-24T00:00:00Z' };
const full = {
  ...edited,
  body: 'plain',
  folder_id: null,
  source: 'cli',
  created_at: '2026-09-24T00:00:00Z',
  tags: ['autosave'],
};

describe('autosave CLI contract', () => {
  let dir: string;
  let output: string[];
  let errors: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kinjot-autosave-contract-'));
    output = [];
    errors = [];
    vi.stubEnv('KINJOT_CONFIG_DIR', dir);
    vi.stubEnv('KINJOT_MODE', 'account');
    vi.stubEnv('KINJOT_API_KEY', KEY);
    vi.stubEnv('KINJOT_API_URL', API_URL);
    vi.spyOn(console, 'log').mockImplementation((...args) => void output.push(args.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(args.join(' ')));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    process.exitCode = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  function stub(body: unknown, status = 200) {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it.each([
    ['12345678-1234-4234-8234-123456789abc', false],
    [NOTE_ID, true],
    ['ABCDEF12-1234-1234-8234-123456789ABC', false],
  ])('passes valid --id %s to save_note', async (id, flagFirst) => {
    const normalizedId = id.toLowerCase();
    const fetchMock = stub({
      note: { id: normalizedId, title: 'Title', created_at: full.created_at },
    });
    const argv = flagFirst
      ? ['add', '--id', id, 'Title', '--body', 'body']
      : ['add', 'Title', '--id', id, '--body', 'body'];
    await main(argv);
    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      action: 'save_note',
      id: normalizedId,
      title: 'Title',
      body: 'body',
    });
    expect(output).toEqual([`Jotted "Title" (id ${normalizedId}).`]);
  });

  it('normalizes an uppercase id for a direct API caller', async () => {
    const id = 'ABCDEF12-1234-4234-8234-123456789ABC';
    const fetchMock = stub({
      note: { id: id.toLowerCase(), title: 'Title', created_at: full.created_at },
    });
    await new NotesApi(config, fetchMock).saveNote({ id, title: 'Title', body: 'body' });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).id).toBe(id.toLowerCase());
  });

  it('refuses malformed --id before fetching, and rejects missing values', async () => {
    const fetchMock = stub({});
    await main(['add', 'Title', '--id', 'broken', '--body', 'body']);
    expect(process.exitCode).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    process.exitCode = undefined;
    await main(['add', 'Title', '--id']);
    expect(process.exitCode).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the ordinary add request and output shape', async () => {
    const fetchMock = stub({ note: { id: NOTE_ID, title: 'Title', created_at: full.created_at } });
    await main(['add', 'Title', '--body', 'body']);
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(request).toEqual({
      action: 'save_note',
      id: request.id,
      title: 'Title',
      body: 'body',
      source: 'cli',
    });
    expect(output).toEqual([`Jotted "Title" (id ${NOTE_ID}).`]);
  });

  it.each([
    ['whitespace from stdin', ' \n\t ', true],
    ['NUL from stdin', 'entry\u0000text', true],
    ['malformed Unicode', 'entry\ud800text', false],
    ['over the edit limit', 'x'.repeat(100_001), false],
  ])('rejects %s with exit 2 before a request', async (_name, text, fromStdin) => {
    const fetchMock = stub({ note: edited });
    if (fromStdin) {
      const stream = Object.assign(Readable.from([Buffer.from(text)]), { isTTY: false });
      vi.spyOn(process, 'stdin', 'get').mockReturnValue(stream as typeof process.stdin);
    }
    await main(['append', NOTE_ID, ...(fromStdin ? [] : ['--text', text])]);
    expect(process.exitCode).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, undefined],
    [true, 0],
    [false, 5],
  ])(
    'sends snapshot only for --no-snapshot and returns the echo outcome',
    async (flag, exitCode) => {
      const fetchMock = stub({
        note: edited,
        ...(flag === true ? { snapshot_skipped: true } : {}),
      });
      await main([
        'append',
        NOTE_ID,
        '--text',
        'entry',
        ...(flag === undefined ? [] : ['--no-snapshot']),
      ]);
      const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
      expect(Object.hasOwn(request, 'snapshot')).toBe(flag !== undefined);
      if (flag !== undefined) expect(request.snapshot).toBe(false);
      expect(process.exitCode ?? 0).toBe(exitCode ?? 0);
      expect(output).toEqual(['Appended to A19 "Target".']);
    },
  );

  it('get preserves body line breaks and strips terminal controls on stdout', async () => {
    const fetchMock = stub({
      note: { ...full, body: 'first\r\n\tsecond\n\x1b[31mthird\rfourth\u009b0m\x7f\x00\n' },
    });
    await main(['get', NOTE_ID]);
    expect(process.exitCode).toBeUndefined();
    expect(errors).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      action: 'get_note',
      id: NOTE_ID,
    });
    expect(output).toEqual([
      'A19  Target  [autosave]  (updated 2026-09-24)',
      '',
      'first\n\tsecond\n[31mthirdfourth0m\n',
    ]);
  });

  it('get flattens newlines in its header title and tags', async () => {
    stub({ note: { ...full, title: 'first\nsecond', tags: ['tag\ninjected', 'ordinary'] } });
    await main(['get', NOTE_ID]);
    expect(process.exitCode).toBeUndefined();
    expect(errors).toEqual([]);
    expect(output).toEqual([
      'A19  firstsecond  [taginjected, ordinary]  (updated 2026-09-24)',
      '',
      'plain',
    ]);
  });

  it('prints exact stored fields as terminal-safe JSON', async () => {
    const body =
      'start\n\tCRLF\r\nlone\rCR\x1b[31m\u0000\u001f\u007f\u0085\u061c\u200e\u200f\u202e\u2066\u2069\u2028\u2029 café العربية';
    const note = { ...full, body };
    stub({ note });
    await main(['get', NOTE_ID, '--json']);
    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(output[0]!)).toEqual(note);
    expect(output[0]).not.toMatch(
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/,
    );
    expect(output[0]).toContain('café');
  });

  it.each([
    ['specific 404', 404, { error: 'note not found' }, 3],
    ['bare 404', 404, {}, 1],
    ['server failure', 500, { error: 'internal error' }, 1],
    ['old backend', 400, { error: 'unknown action' }, 4],
    ['key access', 403, { error: 'this API key cannot edit', code: 'key_access' }, 4],
    ['Pro gate', 403, { error: 'AI recall requires the Pro plan' }, 1],
  ])('classifies %s by typed API status and error', async (_name, status, body, code) => {
    stub(body, status);
    await main(['append', NOTE_ID, '--text', 'entry']);
    expect(process.exitCode).toBe(code);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^error: /);
    if (_name === 'key access') expect(errors).toEqual(['error: this API key cannot edit']);
  });

  it.each([
    ['get by UUID', ['get', NOTE_ID]],
    ['get by label', ['get', 'A19']],
    ['append by label', ['append', 'A19', '--text', 'entry']],
  ])('returns exit 3 for a definite missing note: %s', async (_name, argv) => {
    const fetchMock = stub({ error: 'note not found' }, 404);
    await main(argv);
    expect(process.exitCode).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses and clears the 30-second default deadline on success', async () => {
    const fetchMock = stub({ note: full });
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    await new NotesApi(config, fetchMock).getNote(NOTE_ID);
    const index = timerSpy.mock.calls.findIndex((call) => call[1] === 30_000);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(clearSpy).toHaveBeenCalledWith(timerSpy.mock.results[index]?.value);
  });

  it('classifies network errors and unknown flags', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    await main(['append', NOTE_ID, '--text', 'entry']);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    await main(['append', NOTE_ID, '--text', 'entry', '--unknown', 'x']);
    expect(process.exitCode).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('classifies an unknown command, an unparseable reply, and empty append text', async () => {
    const fetchMock = stub({ note: { id: NOTE_ID } });
    await main(['unknown-command']);
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
    await main(['append', NOTE_ID, '--text', '']);
    expect(process.exitCode).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    process.exitCode = undefined;
    await main(['append', NOTE_ID, '--text', 'entry']);
    expect(process.exitCode).toBe(1);
  });

  it('marks an unsupported edit action without changing its human-facing error', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: 'unknown action' }, { status: 400 }));
    const api = new NotesApi(config, fetchMock);
    await expect(api.editNote({ id: NOTE_ID, title: 'new' })).rejects.toMatchObject({
      kind: 'unsupported_action',
      message: 'This Kinjot backend does not support agent edits yet; update the deployment.',
    });
  });

  it.each(['request', 'body'])('times out a stalled %s with exit 1', async (stage) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        stage === 'request'
          ? new Promise<Response>(() => {})
          : Promise.resolve(new Response(new ReadableStream({ start() {} }), { status: 200 })),
      );
    vi.stubGlobal('fetch', fetchMock);
    const original = NotesApi.prototype.appendNote;
    vi.spyOn(NotesApi.prototype, 'appendNote').mockImplementation((input) =>
      original.call(new NotesApi(config, fetchMock, { deadlineMs: 15 }), input),
    );
    await main(['append', NOTE_ID, '--text', 'entry']);
    expect(process.exitCode).toBe(1);
    expect(errors[0]).toContain('timed out');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
});
