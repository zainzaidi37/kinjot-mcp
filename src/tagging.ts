import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { normalizeTags } from './core/index.js';

// Re-exported from `packages/core/src/tags.ts`, which the browser extension
// shares, so this module's importers are unchanged.
export { isReservedTag, normalizeTag, normalizeTags } from './core/index.js';

/**
 * The repo/project tag uses the detected git toplevel's basename rather than an
 * agent-supplied name, so its spelling follows the checkout. Walk up from
 * startDir, falling back to that directory's basename outside a repo. An empty
 * normalized basename returns null. A ceiling leaves the start directory
 * eligible, but the walk never enters the ceiling directory or its parents.
 * Without a ceiling, the walk continues to the filesystem root.
 */
export function detectRepoTag(startDir = process.cwd(), ceiling?: string): string | null {
  let dir = startDir;
  const ceilingDir = ceiling === undefined ? undefined : resolve(ceiling);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return normalizeTags([basename(dir)])[0] ?? null;
    const parent = dirname(dir);
    if (parent === dir || (ceilingDir !== undefined && resolve(parent) === ceilingDir)) break;
    dir = parent;
  }
  return normalizeTags([basename(startDir)])[0] ?? null;
}
