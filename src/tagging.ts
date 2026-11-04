import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * A tag's default spelling: trimmed, leading `#`s dropped, trimmed again,
 * lowercase, and whitespace runs collapsed to `-`. Dropping the `#` lines this up with the
 * web's `normalizeTagName` (`apps/web/src/data/repo.ts`) and Tidy's
 * (`supabase/functions/_shared/tidy-tag.ts`), which store tags without a
 * leading `#`. normalizeTags also dedupes, caps the result at 5 and prefers a
 * vocabulary spelling, except one that starts with `#`.
 */
export function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#+/, '').trim().toLowerCase().replace(/\s+/g, '-');
}

// Tidy's `reservedTagName` (`supabase/functions/_shared/tidy-tag.ts`) plus a
// trim after the `#` strip, so `normalizeTag(tag) === 'autosave'` exactly when
// this is true; the package boundary forbids importing the Edge Function helper.
export function isReservedTag(tag: string): boolean {
  return tag.trim().replace(/^#+/, '').trim().toLowerCase() === 'autosave';
}

export function normalizeTags(tags: string[], vocabulary?: string[]): string[] {
  const canonical = new Map<string, string>();
  for (const existing of vocabulary ?? []) {
    // A stored `#name` shares its key with `name`; adopting it would keep writing the `#` spelling.
    if (existing.trim().startsWith('#')) continue;
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
