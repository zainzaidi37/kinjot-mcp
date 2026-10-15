import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configFilePath, loadStoredMode, saveStoredKey, saveStoredMode } from './configFile.js';
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

  it('rung 1: KINJOT_MODE wins over a stored mode, and over what exists', () => {
    saveStoredKey(GOOD_KEY, dir);
    saveStoredMode('account', dir);
    const resolution = resolveMode(env({ KINJOT_MODE: 'local' }));
    expect(resolution.mode).toBe('local');
    expect(resolution.reason).toBe('env');
    expect(resolution.why).toContain('KINJOT_MODE');
  });

  it('rung 1: an unrecognized KINJOT_MODE is refused rather than ignored', () => {
    expect(() => resolveMode(env({ KINJOT_MODE: 'server' }))).toThrow(ModeError);
    expect(() => resolveMode(env({ KINJOT_MODE: 'server' }))).toThrow(/"local" or "account"/);
  });

  it('rung 1: KINJOT_MODE works over a corrupt config file — the escape hatch needs nothing from it', () => {
    writeFileSync(configFilePath(dir), '{ not valid json');
    const resolution = resolveMode(env({ KINJOT_MODE: 'local' }));
    expect(resolution.mode).toBe('local');
    expect(resolution.reason).toBe('env');
    // A corrupt file reads as "no stored key" for the informational flags.
    expect(resolution.accountAvailable).toBe(false);
  });

  it('rung 2: a stored mode beats both options being present', () => {
    saveStoredKey(GOOD_KEY, dir);
    writePointer();
    saveStoredMode('local', dir);
    const resolution = resolveMode(env());
    expect(resolution.mode).toBe('local');
    expect(resolution.reason).toBe('stored');
    expect(resolution.why).toContain(configFilePath(dir));
  });

  it("rung 3: a stored key and no pointer resolves to the account (today's users, unchanged)", () => {
    saveStoredKey(GOOD_KEY, dir);
    const resolution = resolveMode(env());
    expect(resolution).toMatchObject({
      mode: 'account',
      reason: 'sole-account',
      accountAvailable: true,
      localAvailable: false,
    });
  });

  it('rung 3: KINJOT_API_KEY counts as the account option even with no config file', () => {
    expect(resolveMode(env({ KINJOT_API_KEY: GOOD_KEY })).reason).toBe('sole-account');
  });

  it('rung 3: a pointer and no key resolves to local', () => {
    writePointer();
    const resolution = resolveMode(env());
    expect(resolution).toMatchObject({ mode: 'local', reason: 'sole-local' });
    expect(resolution.why).toContain(pointerPath(dir));
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

  it('rung 4 fires on a pointer whose library is missing — a dangling pointer is still a choice', () => {
    saveStoredKey(GOOD_KEY, dir);
    writePointer(); // names ~/local/library.db, which does not exist
    expect(() => resolveMode(env())).toThrow(/kinjot use account/);
  });

  it('neither option: stays on the account path so `kinjot key` is still the first-run message', () => {
    expect(resolveMode(env())).toMatchObject({ mode: 'account', reason: 'default-account' });
  });

  it('a corrupt config file is propagated by name rather than read as "no key"', () => {
    writeFileSync(configFilePath(dir), '{ not json');
    expect(() => resolveMode(env())).toThrow(configFilePath(dir));
  });
});

describe('stored mode in config.json', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kinjot-mode-cfg-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps version at 1 — bumping it breaks every older installed CLI (§5.4)', () => {
    saveStoredMode('local', dir);
    expect(JSON.parse(readFileSync(configFilePath(dir), 'utf8'))).toEqual({
      version: 1,
      mode: 'local',
    });
  });

  it('the key and the mode do not erase each other', () => {
    saveStoredKey(GOOD_KEY, dir);
    saveStoredMode('local', dir);
    expect(JSON.parse(readFileSync(configFilePath(dir), 'utf8'))).toEqual({
      version: 1,
      apiKey: GOOD_KEY,
      mode: 'local',
    });
    saveStoredKey(`${GOOD_KEY.slice(0, -1)}Z`, dir);
    expect(loadStoredMode(dir)).toBe('local');
    saveStoredMode('account', dir);
    expect(JSON.parse(readFileSync(configFilePath(dir), 'utf8')).apiKey).toBe(
      `${GOOD_KEY.slice(0, -1)}Z`,
    );
  });

  it('refuses a mode value it does not understand', () => {
    writeFileSync(configFilePath(dir), JSON.stringify({ version: 1, mode: 'server' }));
    expect(() => loadStoredMode(dir)).toThrow(/unexpected shape/);
  });
});
