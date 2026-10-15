import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// Stores the API key once per machine so terminal use and MCP configs don't
// need KINJOT_API_KEY in every env block (see resolveConfig in config.ts).

const LEGACY_CONFIG_VERSION = 1;
const ENDPOINT_CONFIG_VERSION = 2;

/** The two things `kinjot` can be pointed at (plans/desktop-app.md §5.4). */
export type KinjotMode = 'local' | 'account';

export const KINJOT_MODES: readonly KinjotMode[] = ['local', 'account'];

/**
 * `mode` is optional. Hosted key and mode-only files stay at version 1;
 * endpoint/key pairs use version 2 so older readers fail closed.
 *
 * Older installed CLIs ignore unknown fields, so writing a custom endpoint in
 * v1 would make them send its key to hosted. They reject v2 before using the
 * key, which is the intentional compatibility boundary.
 *
 * `apiKey` is optional for the same family of reasons in the other direction:
 * `kinjot use local` must be recordable on a machine that has no key at all.
 * The one cost, stated because it is the mirror image of the rule above: a
 * config written by `kinjot use local` before any `kinjot key` has no `apiKey`,
 * and a CLI older than this one rejects that file as "unexpected shape". A
 * machine that has only ever chosen local mode has nothing for an older CLI to
 * do, and the alternative — refusing to record the mode without a key — leaves
 * `KINJOT_MODE` as the only way to run local mode.
 */
interface StoredConfig {
  version: 1 | 2;
  apiKey?: string;
  apiUrl?: string;
  mode?: KinjotMode;
}

// os.homedir() rather than XDG_CONFIG_HOME/%APPDATA%: an MCP host launches
// this process with its own, often-stripped env (no XDG/APPDATA vars), but
// os.homedir() is resolved from the OS user record, not env — it names the
// same directory whether kinjot is run from a shell or an MCP host.
export function configDir(env: Record<string, string | undefined> = process.env): string {
  return env.KINJOT_CONFIG_DIR?.trim() || join(homedir(), '.kinjot');
}

export function configFilePath(dir: string): string {
  return join(dir, 'config.json');
}

/**
 * Writes the config file, preserving whatever `loadStoredConfig` reads back.
 *
 * Read-modify-write rather than overwrite, because the file carries two
 * independent settings: `kinjot key` must not erase a stored mode, and
 * `kinjot use` must not erase the key.
 */
function writeStoredConfig(
  dir: string,
  patch: Partial<Omit<StoredConfig, 'version'>>,
  version?: StoredConfig['version'],
): void {
  // Recreate a corrupt file: loadStoredConfig tells the user to run
  // `kinjot key` to recreate it. The write commands are the repair path, so an
  // unreadable config must not block them. Only fields the loader can read are
  // preserved.
  let existing: Partial<Omit<StoredConfig, 'version'>> = {};
  let existingIsValid = false;
  if (existsSync(configFilePath(dir))) {
    try {
      existing = loadStoredConfig(dir);
      existingIsValid = true;
    } catch {
      existing = {};
    }
  }
  const existingVersion = existingIsValid
    ? (() => {
        try {
          const parsed = JSON.parse(readFileSync(configFilePath(dir), 'utf8')) as {
            version?: unknown;
          };
          return parsed.version === ENDPOINT_CONFIG_VERSION
            ? ENDPOINT_CONFIG_VERSION
            : LEGACY_CONFIG_VERSION;
        } catch {
          return LEGACY_CONFIG_VERSION;
        }
      })()
    : LEGACY_CONFIG_VERSION;
  const next: StoredConfig = { version: version ?? existingVersion, ...existing, ...patch };

  mkdirSync(dir, { recursive: true });
  // mkdirSync's `mode` option and writeFileSync's creation mode are both
  // subject to the process umask, so don't rely on them — chmod explicitly
  // to guarantee the exact bits regardless of the caller's environment.
  chmodSync(dir, 0o700);

  const file = configFilePath(dir);
  const tmp = join(dir, `.config.json.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(tmp, '');
  chmodSync(tmp, 0o600); // lock down perms before the key is ever written into the file
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, file); // rename replaces the destination in one step (atomic on POSIX; replaces on Windows too)
}

export function saveStoredKey(key: string, dir: string): void {
  // Hosted keys remain readable by older CLIs. Explicitly clear a previous
  // endpoint so changing back to hosted cannot retain a stale self-host URL.
  writeStoredConfig(dir, { apiKey: key, apiUrl: undefined }, LEGACY_CONFIG_VERSION);
}

/** Stores an endpoint and the key that was validated against it as one pair. */
export function saveStoredAccount(apiKey: string, apiUrl: string, dir: string): void {
  // v2 is a fail-closed compatibility boundary: older CLIs reject it instead
  // of ignoring apiUrl and sending this self-host key to the hosted service.
  writeStoredConfig(dir, { apiKey, apiUrl }, ENDPOINT_CONFIG_VERSION);
}

/** `kinjot use local|account` — the persisted rung of §5.4's precedence. */
export function saveStoredMode(mode: KinjotMode, dir: string): void {
  writeStoredConfig(dir, { mode });
}

/**
 * Loads the stored config, if any. Missing file → `{}` (first run).
 * Corrupt JSON or the wrong shape → throws, naming the file and pointing at
 * `kinjot key` to recreate it — callers must not swallow this into a
 * "no key found" state, since that would hide a real problem.
 */
export function loadStoredConfig(
  dir: string,
  stderr: { write: (chunk: string) => unknown } = process.stderr,
): { apiKey?: string; apiUrl?: string; mode?: KinjotMode } {
  const file = configFilePath(dir);
  if (!existsSync(file)) return {};

  const raw = readFileSync(file, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${file} is not valid JSON. Run \`kinjot key\` to recreate it.`);
  }
  const record = parsed as Partial<StoredConfig>;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (record.version !== LEGACY_CONFIG_VERSION && record.version !== ENDPOINT_CONFIG_VERSION) ||
    // Both fields optional, but a file carrying neither is not a config this
    // package wrote — it is the "unexpected shape" case, and saying so is what
    // keeps a typo'd key field from reading as "no key stored".
    (record.apiKey === undefined && record.mode === undefined) ||
    (record.apiKey !== undefined && typeof record.apiKey !== 'string') ||
    (record.version === LEGACY_CONFIG_VERSION && record.apiUrl !== undefined) ||
    (record.version === ENDPOINT_CONFIG_VERSION &&
      (typeof record.apiUrl !== 'string' || record.apiUrl === '' || record.apiKey === undefined)) ||
    (record.mode !== undefined && !KINJOT_MODES.includes(record.mode))
  ) {
    throw new Error(`${file} has an unexpected shape. Run \`kinjot key\` to recreate it.`);
  }

  // Windows: skip perms handling entirely. The user profile directory is
  // already ACL'd to the current user by the OS — same posture gh and npm
  // take for their own config files.
  if (process.platform !== 'win32') {
    const mode = statSync(file).mode & 0o777;
    if (mode & 0o077) {
      chmodSync(file, 0o600);
      // stderr, never stdout: a bare `kinjot` invocation is an MCP stdio
      // server, and anything written to stdout corrupts JSON-RPC framing.
      stderr.write(
        `warning: tightened permissions on ${file} to 0600 (were 0${mode.toString(8)})\n`,
      );
    }
  }

  return { apiKey: record.apiKey, apiUrl: record.apiUrl, mode: record.mode };
}

/** Loads the stored key, if any. Missing file, or a file with no key → undefined. */
export function loadStoredKey(
  dir: string,
  stderr: { write: (chunk: string) => unknown } = process.stderr,
): string | undefined {
  return loadStoredConfig(dir, stderr).apiKey;
}

/** Loads the stored mode, if one was ever chosen. */
export function loadStoredMode(
  dir: string,
  stderr: { write: (chunk: string) => unknown } = process.stderr,
): KinjotMode | undefined {
  return loadStoredConfig(dir, stderr).mode;
}
