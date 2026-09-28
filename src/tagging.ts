import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * Tag hygiene is enforced in code, not in tool descriptions: lowercase,
 * whitespace collapsed to dashes, deduped, at most 5. Otherwise search
 * fragments into Auth/auth/authentication variants.
 */
function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/\s+/g, '-');
}

// Mirrors Tidy's reservedTagName in supabase/functions/_shared/tidy-tag.ts;
// the package boundary forbids importing the Edge Function helper here.
export function isReservedTag(tag: string): boolean {
  return tag.trim().replace(/^#+/, '').toLowerCase() === 'autosave';
}

export function normalizeTags(tags: string[], vocabulary?: string[]): string[] {
  const canonical = new Map<string, string>();
  for (const existing of vocabulary ?? []) {
    const normalized = normalizeTag(existing);
    if (normalized.length > 0 && !canonical.has(normalized)) canonical.set(normalized, existing);
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const normalized = normalizeTag(raw);
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(canonical.get(normalized) ?? normalized);
    if (out.length === 5) break;
  }
  return out;
}

/**
 * The repo/project tag is detected here rather than supplied by the calling
 * agent, so it is always present and consistently spelled. MCP hosts spawn
 * stdio servers in the session's working directory: walk up to the git
 * toplevel and use its basename, falling back to the directory itself when
 * not inside a repo. A ceiling leaves the start directory eligible, but the
 * walk never enters the ceiling directory or its parents. Without a ceiling,
 * the walk continues to the filesystem root as before.
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
