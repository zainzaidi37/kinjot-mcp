import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { expect, it, vi } from 'vitest';
import { NotesApi } from './api.js';
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
