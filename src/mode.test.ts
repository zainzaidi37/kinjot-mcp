import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveStoredKey } from './configFile.js';
import { pointerPath } from './local/pointer.js';
import { ModeError, resolveMode } from './mode.js';

/**
 * The precedence table in plans/desktop-app.md §5.4, including the ambiguity
 * when a stored key and a local-library pointer coexist without a chosen mode.
 */

const GOOD_KEY = `kj_live_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V'.slice(0, 43)}`;

describe('resolveMode', () => {
  let dir: string;
  const env = (extra: Record<string, string | undefined> = {}) => ({
    KINJOT_CONFIG_DIR: dir,
    ...extra,
  });

  function writePointer(): void {
    writeFileSync(
      pointerPath(dir),
      JSON.stringify({
        version: 1,
        db_path: join(dir, 'local', 'library.db'),
        workspace_uuid: '11111111-1111-4111-8111-111111111111',
        schema_version: 2,
      }),
    );
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kinjot-mode-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('rung 4: both available and no mode is a hard error naming `kinjot use account`', () => {
    saveStoredKey(GOOD_KEY, dir);
    writePointer();
    expect(() => resolveMode(env())).toThrow(ModeError);
    const message = (() => {
      try {
        resolveMode(env());
        return '';
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(message).toContain('kinjot use account');
    expect(message).toContain('kinjot use local');
    expect(message).toContain('Nothing was written');
  });
});
