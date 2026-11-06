// @generated — DO NOT EDIT.
//
// Vendored copy of packages/core/src/extension-wire.ts, emitted by
// `pnpm --filter @kinjot/core emit:mcp-core` (plans/desktop-app.md §4.5).
// Edit the source module and re-run; CI fails on any difference.

import { z } from 'zod';
import { API_KEY_ACCESS_LEVELS } from './api-key.js';

/**
 * The shapes `supabase/functions/mcp-api/index.ts` answers to the actions the
 * browser extension uses (`plans/browser-extension-2026-11-03.md` §3.3 and
 * §5.9). The extension, the connect page and the CLI parse these one
 * definitions: the existing actions' response schemas moved here from
 * `packages/mcp/src/wire.ts`, which re-exports them. The Edge Function cannot
 * import core (`packages/core/scripts/emit-edge-core.mjs` vendors neither this
 * file nor `./api-key`), so it restates them by hand; PR-E's test parses every
 * answer of the new actions with {@link EXTENSION_RESPONSE_SCHEMAS}.
 *
 * Every request is `POST` `{action, ...params}` with `Authorization: Bearer
 * <key>`. Responses are deliberately looser than the row schemas: ids,
 * timestamps and source are strings, and additive server fields are stripped
 * rather than refused, so a newer backend never breaks an installed client.
 */

/**
 * The hosted `mcp-api` endpoint, pinned to prod's region by query parameter
 * (`docs/contracts/edge-functions.md`). `packages/mcp/src/config.ts`'s
 * `DEFAULT_API_URL` is this value, read from the vendored core.
 */
export const EXTENSION_API_URL =
  'https://opzbxxrjiiktduivkdwm.supabase.co/functions/v1/mcp-api?forceFunctionRegion=us-east-1';

export const EXTENSION_ACTIONS = [
  'key_info',
  'save_note',
  'list_recent_notes',
  'search_notes',
  'get_note',
  'recall',
  'inbox_list',
  'append_note',
  'list_folders',
  'list_tags',
  'inbox_unread',
  'revoke_key',
] as const;
export type ExtensionAction = (typeof EXTENSION_ACTIONS)[number];

// Each top-level schema is built inside a `/* @__PURE__ */` IIFE so a bundle
// that imports core's barrel but none of these drops them (Vite 8's Rolldown):
// zod 4's factories carry no side-effect annotation, and an annotation on an
// outer call alone still keeps its arguments' calls (#1805 review N7).
const searchHit = /* @__PURE__ */ (() =>
  z.object({
    id: z.string(),
    short_id: z.number().int().nullable().optional(),
    title: z.string(),
    tags: z.array(z.string()),
    updated_at: z.string(),
    gist: z.string().nullable().optional(),
  }))();

/** `get_note`, `append_note`: exactly one of `id` (a UUID or 8+ hex prefix) or `short_id`. */
const noteReference = /* @__PURE__ */ (() =>
  z.union([
    z.object({ id: z.string() }).strict(),
    z.object({ short_id: z.number().int().min(1).max(2147483647) }).strict(),
  ]))();

/** The params each action takes, without `action`. */
export const EXTENSION_REQUEST_SCHEMAS = /* @__PURE__ */ (() =>
  ({
    key_info: z.object({}),
    save_note: z.object({
      id: z.guid(),
      title: z.string(),
      body: z.string(),
      tags: z.array(z.string()).optional(),
      folder: z.string().optional(),
      source: z.literal('mcp'),
    }),
    list_recent_notes: z.object({ limit: z.number().optional() }),
    search_notes: z.object({ query: z.string().min(1).max(1000) }),
    get_note: noteReference,
    recall: z.object({ query: z.string().min(1).max(1000), limit: z.number().optional() }),
    inbox_list: z.object({
      repo: z.string().optional(),
      kinds: z.array(z.string()).min(1).optional(),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    append_note: z.intersection(
      noteReference,
      z.object({ text: z.string().min(1), source: z.literal('mcp').optional() }),
    ),
    list_folders: z.object({}),
    list_tags: z.object({}),
    /**
     * `include_newest` asks for the newest unread item too: the popup's Inbox
     * tab sends it, the badge poll asks for the count only (#1811).
     */
    inbox_unread: z.object({ include_newest: z.literal(true).optional() }),
    revoke_key: z.object({}),
  }) satisfies Record<ExtensionAction, z.ZodType>)();

/** The 200 body each action answers. */
export const EXTENSION_RESPONSE_SCHEMAS = /* @__PURE__ */ (() =>
  ({
    /**
     * `name`, `account` and `pro` are hints: a backend before PR-E answers
     * `{access}` only, and a null or mistyped hint (`account` comes from the
     * nullable `auth.users.email`) reads as absent rather than failing the parse,
     * which would cost the CLI its access level (`packages/mcp/src/api.ts` `keyInfo`).
     */
    key_info: z.object({
      access: z.enum(API_KEY_ACCESS_LEVELS),
      name: z.string().optional().catch(undefined),
      account: z.string().optional().catch(undefined),
      pro: z.boolean().optional().catch(undefined),
    }),
    save_note: z.object({
      ai_excluded: z.unknown().optional(),
      note: z.object({ id: z.string(), title: z.string(), created_at: z.string() }),
      // The vocabulary is a hint for later tag spelling. A missing or malformed
      // hint must not turn a completed save into a parse failure.
      existing_tags: z.array(z.string()).optional().catch(undefined),
    }),
    list_recent_notes: z.object({ notes: z.array(searchHit) }),
    search_notes: z.object({ notes: z.array(searchHit), total: z.number() }),
    get_note: z.object({
      note: z.object({
        id: z.string(),
        short_id: z.number().int().nullable().optional(),
        title: z.string(),
        body: z.string(),
        folder_id: z.string().nullable(),
        source: z.string(),
        created_at: z.string(),
        updated_at: z.string(),
        tags: z.array(z.string()),
      }),
    }),
    recall: z.object({
      matches: z.array(
        z.object({
          id: z.string(),
          short_id: z.number().int().nullable().optional(),
          title: z.string(),
          gist: z.string().nullable(),
          similarity: z.number(),
          passage: z.string().nullable().optional(),
        }),
      ),
    }),
    inbox_list: z.object({
      items: z.array(
        z.object({
          id: z.string(),
          kind: z.string(),
          title: z.string(),
          detail: z.string().nullable(),
          context: z
            .object({
              agent: z.string().optional(),
              repo: z.string().optional(),
              branch: z.string().optional(),
              prs: z.array(z.string()).optional(),
              note: z.string().optional(),
              session_id: z.string().optional(),
            })
            .passthrough(),
          repeat_count: z.number(),
          created_at: z.string(),
          surfaced_at: z.string(),
          key_name: z.string().nullable(),
        }),
      ),
      other_open: z.number(),
    }),
    append_note: z.object({
      snapshot_skipped: z.literal(true).optional().catch(undefined),
      note: z.object({
        id: z.string(),
        short_id: z.number().int().nullable().optional(),
        title: z.string(),
        updated_at: z.string(),
      }),
    }),
    list_folders: z.object({
      folders: z.array(
        z.object({ id: z.string(), name: z.string(), parent_id: z.string().nullable() }),
      ),
    }),
    list_tags: z.object({ tags: z.array(z.string()) }),
    inbox_unread: z.object({
      unread: z.number(),
      newest: z
        .object({ kind: z.string(), title: z.string(), repo: z.string().nullable() })
        .nullable()
        .optional(),
    }),
    revoke_key: z.object({ revoked: z.literal(true) }),
  }) satisfies Record<ExtensionAction, z.ZodType>)();

export type ExtensionRequest<A extends ExtensionAction> = z.infer<
  (typeof EXTENSION_REQUEST_SCHEMAS)[A]
>;
export type ExtensionResponse<A extends ExtensionAction> = z.infer<
  (typeof EXTENSION_RESPONSE_SCHEMAS)[A]
>;

/**
 * The `code`s `supabase/functions/mcp-api/index.ts` answers to the actions
 * above (`key-gate.ts`, `_shared/bounded-body.ts`, `_shared/ai-configuration.ts`,
 * the read admission and the Inbox mapping), plus the Inbox's codes
 * (`invalid_id`, `invalid_source`, `invalid_title`, `invalid_context`,
 * `invalid_session` and `id_conflict` come only from `inbox_notify` and
 * `inbox_resolve`, which the extension does not call), plus `note_id_conflict`: PR-D's
 * 409 for a `save_note` id that already exists. `id_conflict` is the Inbox's
 * own refusal (`inbox_notify`), which installed CLIs map to exit 2
 * (`packages/mcp/src/cli.ts` `DEFINITE_INBOX_REFUSALS`), so a note conflict
 * never reuses it. The Inbox also forwards any `invalid_*` code its RPC
 * raises, so {@link ExtensionErrorSchema} keeps `code` an open string.
 */
export const EXTENSION_ERROR_CODES = [
  'key_access',
  'body_too_large',
  'body_timeout',
  'search_rate_limited',
  'recall_rate_limited',
  'ai_configuration_missing',
  'note_id_conflict',
  'id_conflict',
  'invalid_key',
  'rate_limited',
  'inbox_rate_limited',
  'inbox_item_not_found',
  'inbox_ambiguous_id',
  'inbox_access_off',
  'invalid_id',
  'invalid_kind',
  'invalid_source',
  'invalid_title',
  'invalid_request',
  'invalid_context',
  'invalid_session',
] as const;
export type ExtensionErrorCode = (typeof EXTENSION_ERROR_CODES)[number];

/** Every non-2xx body. Many refusals carry no `code`; an unknown one parses. */
export const ExtensionErrorSchema = /* @__PURE__ */ (() =>
  z.object({
    error: z.string(),
    code: z.string().optional(),
  }))();
export type ExtensionError = z.infer<typeof ExtensionErrorSchema>;

export function isExtensionErrorCode(code: unknown): code is ExtensionErrorCode {
  return typeof code === 'string' && (EXTENSION_ERROR_CODES as readonly string[]).includes(code);
}
