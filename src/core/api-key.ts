// @generated — DO NOT EDIT.
//
// Vendored copy of packages/core/src/api-key.ts, emitted by
// `pnpm --filter @kinjot/core emit:mcp-core` (plans/desktop-app.md §4.5).
// Edit the source module and re-run; CI fails on any difference.

/**
 * The API key's access levels and format. A leaf module, so
 * `./extension-connect` and `./extension-wire` import them without a cycle
 * through the barrel (`./index`), which re-exports both.
 */
export const API_KEY_ACCESS_LEVELS = ['read', 'read_create', 'full'] as const;
export type ApiKeyAccess = (typeof API_KEY_ACCESS_LEVELS)[number];

// API key format. A key is "kj_live_" + 43 base62 characters (~256 bits).
//
// This declaration is the source. The web app generates keys with
// `generateApiKey` (`apps/web/src/data/api-keys-repo.ts`); it does not import
// the pattern. The CLI reads the generated vendored copy
// (`packages/mcp/src/core/api-key.ts`), re-exported by
// `packages/mcp/src/config.ts`. The Edge Function cannot import it (the
// Deno/npm boundary), so its `KEY_PATTERN` (`supabase/functions/mcp-api/index.ts`)
// is the one hand-written copy, pinned to this one by `.source`/`.flags`
// equality in `supabase/tests/core-mirror.unit.test.ts`.
export const API_KEY_PATTERN = /^kj_live_[A-Za-z0-9]{43}$/;
