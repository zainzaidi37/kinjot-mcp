// The mode-selection rule (plans/desktop-app.md §5.4): where does this
// invocation write — the local library, or the account on the server?
//
// **Ambiguity is an error.** When both a local library and a stored API key
// exist and no mode has been chosen, this refuses and names the fix. It does
// not guess, because both silent guesses fail invisibly and in opposite
// directions: preferring the key ships a local-first user's private jots to a
// server they abandoned, and preferring local strands a signed-in user's jots
// on one machine while sync appears to work.
//
// The package already holds this philosophy one level down — `resolveConfig`
// refuses to fall back to a stored key when `KINJOT_API_KEY` is set, for the
// same reason.

import { configDir, configFilePath, loadStoredConfig, type KinjotMode } from './configFile.js';
import { pointerExists, pointerPath } from './local/pointer.js';

export type { KinjotMode };

/** Which rung of §5.4's precedence table decided. */
export type ModeReason =
  | 'env' // 1: KINJOT_MODE
  | 'stored' // 2: `kinjot use`
  | 'sole-local' // 3: a pointer and no key
  | 'sole-account' // 3: a key and no pointer
  | 'default-account'; // neither: account setup reports the missing key

export interface ModeResolution {
  readonly mode: KinjotMode;
  readonly reason: ModeReason;
  /** One line, for `kinjot where`: why this rung won. */
  readonly why: string;
  /** The config root every path below resolved against. */
  readonly dir: string;
  readonly localAvailable: boolean;
  readonly accountAvailable: boolean;
}

export class ModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModeError';
  }
}

function parseMode(value: string): KinjotMode | undefined {
  return value === 'local' || value === 'account' ? value : undefined;
}

/**
 * Under rung 1 the availability flags are informational (`kinjot where`), the
 * mode being already decided — so a corrupt config file reads as "no stored
 * key" here rather than blocking the env override it cannot affect.
 */
function safeStoredKey(dir: string): boolean {
  try {
    return loadStoredConfig(dir).apiKey !== undefined;
  } catch {
    return false;
  }
}

/**
 * Resolves the mode for one invocation.
 *
 * Availability is deliberately cheap and structural — does a pointer file
 * exist, is a key reachable — rather than "does the local library open". A
 * pointer whose `db_path` dangles still means the user chose local mode, so it
 * must keep the machine ambiguous rather than resolve quietly to the account;
 * the handshake in `local/library.ts` is what turns that into a loud refusal.
 */
export function resolveMode(env: Record<string, string | undefined> = process.env): ModeResolution {
  const dir = configDir(env);
  const localAvailable = pointerExists(dir);

  // Rung 1 before the config file is even read: KINJOT_MODE is the
  // per-command escape hatch, and needs nothing from `config.json` — so a
  // corrupt or unreadable file must not be able to block it.
  const rawEnvMode = env.KINJOT_MODE?.trim();
  if (rawEnvMode !== undefined && rawEnvMode !== '') {
    const mode = parseMode(rawEnvMode);
    if (mode === undefined) {
      throw new ModeError(
        `KINJOT_MODE must be "local" or "account" (got ${JSON.stringify(rawEnvMode)}). ` +
          `Nothing was written.`,
      );
    }
    const accountAvailable = (env.KINJOT_API_KEY?.trim() ?? '') !== '' || safeStoredKey(dir);
    return {
      dir,
      localAvailable,
      accountAvailable,
      mode,
      reason: 'env',
      why: `KINJOT_MODE=${mode} overrides everything else`,
    };
  }

  const stored = loadStoredConfig(dir); // may throw (corrupt file) — it names the file
  const accountAvailable = (env.KINJOT_API_KEY?.trim() ?? '') !== '' || stored.apiKey !== undefined;
  const base = { dir, localAvailable, accountAvailable };

  if (stored.mode !== undefined) {
    return {
      ...base,
      mode: stored.mode,
      reason: 'stored',
      why: `mode "${stored.mode}" stored in ${configFilePath(dir)} by \`kinjot use\``,
    };
  }

  // The app publishes the pointer on every launch, whichever workspace mounts.
  // A machine with a key and pointer needs an explicit mode; name both commands
  // so the refusal tells the user how to choose.
  if (localAvailable && accountAvailable) {
    throw new ModeError(
      `both a local library and an API key are set up on this machine, and no mode has been ` +
        `chosen — Kinjot will not guess which one your jots belong in. ` +
        `Run \`kinjot use account\` to keep writing to your Kinjot account, or ` +
        `\`kinjot use local\` to write to the desktop app's local library ` +
        `(or set KINJOT_MODE for a single command). Nothing was written.`,
    );
  }

  if (localAvailable) {
    return {
      ...base,
      mode: 'local',
      reason: 'sole-local',
      why: `a local library is set up (${pointerPath(dir)}) and no API key is stored`,
    };
  }

  if (accountAvailable) {
    return {
      ...base,
      mode: 'account',
      reason: 'sole-account',
      why: 'an API key is available and no local library is set up',
    };
  }

  // With neither option available, use the account path so a first-run user
  // gets the "No API key found. Run `kinjot key`" setup message.
  return {
    ...base,
    mode: 'account',
    reason: 'default-account',
    why: 'no local library and no stored API key on this machine',
  };
}
