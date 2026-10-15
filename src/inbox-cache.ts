import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { InboxNotifyResult } from './api.js';
import type { Config } from './config.js';

interface Entry {
  at: number;
  send_kinds: string[];
  key_muted: boolean;
}
type Cache = Record<string, Entry>;

const TTL_MS = 60 * 60 * 1000;
const cacheKey = (config: Config) => `${config.apiUrl}\n${config.apiKey.slice(0, 16)}`;
const cachePath = (dir: string) => join(dir, 'inbox-cache.json');

function read(dir: string): Cache {
  try {
    const value: unknown = JSON.parse(readFileSync(cachePath(dir), 'utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
    return value as Cache;
  } catch {
    return {};
  }
}

export type MuteCacheState = 'muted' | 'enabled' | 'unknown';

export function cachedMuteState(
  dir: string,
  config: Config,
  kind: string,
  now = Date.now(),
): MuteCacheState {
  const entry = read(dir)[cacheKey(config)];
  if (
    !entry ||
    !Number.isFinite(entry.at) ||
    now - entry.at < 0 ||
    now - entry.at >= TTL_MS ||
    typeof entry.key_muted !== 'boolean' ||
    !Array.isArray(entry.send_kinds) ||
    !entry.send_kinds.every((value) => typeof value === 'string')
  )
    return 'unknown';
  return entry.key_muted || !entry.send_kinds.includes(kind) ? 'muted' : 'enabled';
}

export function cachedMute(dir: string, config: Config, kind: string, now = Date.now()): boolean {
  return cachedMuteState(dir, config, kind, now) === 'muted';
}

export function refreshMute(
  dir: string,
  config: Config,
  answer: Pick<InboxNotifyResult, 'send_kinds' | 'key_muted'>,
  now = Date.now(),
): void {
  const entries = read(dir);
  entries[cacheKey(config)] = {
    at: now,
    send_kinds: answer.send_kinds,
    key_muted: answer.key_muted,
  };
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = join(dir, `.inbox-cache.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    writeFileSync(temp, `${JSON.stringify(entries)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, cachePath(dir));
  } catch {
    /* A cache write failure leaves mute decisions to the server. */
  }
}
