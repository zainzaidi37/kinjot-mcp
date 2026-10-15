// Configuration comes from environment variables (so the same values work in
// an MCP server entry's "env" block and a shell) or the stored key file
// written by `kinjot key` (see configFile.ts). The API key is the only
// secret; it is a user-scoped key from the web app's settings page — the
// Supabase service-role key must never appear anywhere in this package.

import { configDir, configFilePath, loadStoredConfig } from './configFile.js';

const LEGACY_DEFAULT_API_URL = 'https://opzbxxrjiiktduivkdwm.supabase.co/functions/v1/mcp-api';

// Hosted Edge Functions run beside the us-east-1 database (CLAUDE.md). The
// region is selected by query parameter; custom endpoints keep their URL.
export const DEFAULT_API_URL = `${LEGACY_DEFAULT_API_URL}?forceFunctionRegion=us-east-1`;

/** Old saved/default endpoints still mean production, including in CLI setup. */
export function normalizeDefaultApiUrl(url: string): string {
  return url === LEGACY_DEFAULT_API_URL ? DEFAULT_API_URL : url;
}

export const API_KEY_PATTERN = /^kj_live_[A-Za-z0-9]{43}$/;

export interface Config {
  apiUrl: string;
  apiKey: string;
}

interface StoredAccountConfig {
  apiKey?: string;
  apiUrl?: string;
}

function defaultLoadStored(): StoredAccountConfig {
  return loadStoredConfig(configDir());
}

export function resolveConfig(
  env: Record<string, string | undefined> = process.env,
  loadStored: () => StoredAccountConfig | string | undefined = defaultLoadStored,
): Config {
  const explicitApiUrl = env.KINJOT_API_URL?.trim() || undefined;
  const envKey = env.KINJOT_API_KEY?.trim() ?? '';

  if (envKey !== '') {
    // No fallback to a stored key here: silently using a different key than
    // the one the user thinks they set could write to the wrong account.
    if (!API_KEY_PATTERN.test(envKey)) {
      throw new Error(
        'KINJOT_API_KEY does not look like a Kinjot key (expected kj_live_ + 43 characters). ' +
          'It overrides any stored key, so the stored key (if any) will not be used until this is fixed or unset.',
      );
    }
    return { apiUrl: normalizeDefaultApiUrl(explicitApiUrl ?? DEFAULT_API_URL), apiKey: envKey };
  }

  const loaded = loadStored();
  const stored = typeof loaded === 'string' ? { apiKey: loaded } : loaded;
  if (stored?.apiKey === undefined) {
    throw new Error('No API key found. Run `kinjot key` to set one up, or set KINJOT_API_KEY.');
  }
  if (!API_KEY_PATTERN.test(stored.apiKey)) {
    throw new Error(
      `The key stored in ${configFilePath(configDir(env))} does not look like a Kinjot key. Run \`kinjot key\` to set a new one.`,
    );
  }
  return {
    apiUrl: normalizeDefaultApiUrl(explicitApiUrl ?? stored.apiUrl ?? DEFAULT_API_URL),
    apiKey: stored.apiKey,
  };
}
