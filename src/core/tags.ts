// @generated — DO NOT EDIT.
//
// Vendored copy of packages/core/src/tags.ts, emitted by
// `pnpm --filter @kinjot/core emit:mcp-core` (plans/desktop-app.md §4.5).
// Edit the source module and re-run; CI fails on any difference.

/**
 * Agent tag hygiene, shared by `packages/mcp` (through its vendored core) and
 * the browser extension.
 *
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

// Tidy's `reservedTagName` in `supabase/functions/_shared/tidy-tag.ts` is this
// function, through the copy `packages/core/scripts/emit-edge-core.mjs`
// generates, so Tidy and agents reserve the same names. It trims after the `#`
// strip, so `normalizeTag(tag) === 'autosave'` exactly when this is true.
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
