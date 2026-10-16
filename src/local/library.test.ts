import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openLocalLibrary } from './library.js';
import { makeLibraryFixture } from './library-fixture.js';
const makeLibrary = makeLibraryFixture;

describe('the pointer handshake', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kinjot-lib-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a dangling db_path is a hard error that never falls through to the server', () => {
    makeLibrary(dir);
    rmSync(join(dir, 'local'), { recursive: true, force: true });
    let message = '';
    try {
      openLocalLibrary(dir);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(join(dir, 'local', 'library.db'));
    expect(message).toContain('nothing was sent to the server');
    // And the refusal did not mint the library it was pointed at.
    expect(existsSync(join(dir, 'local', 'library.db'))).toBe(false);
  });

  it('refuses when the pointer and meta disagree about the workspace', () => {
    makeLibrary(dir, { pointer: { workspace_uuid: '22222222-2222-4222-8222-222222222222' } });
    expect(() => openLocalLibrary(dir)).toThrow(/disagree about which workspace/);
  });
});
