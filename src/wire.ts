import { z } from 'zod';
import {
  API_KEY_ACCESS_LEVELS,
  ATTACHMENT_UPLOAD_HEADER_NAMES,
  UploadedAttachmentSchema,
} from './core/index.js';

const uploadHeaders = z
  .record(z.string())
  .refine(
    (headers) =>
      Object.keys(headers).every((name) =>
        ATTACHMENT_UPLOAD_HEADER_NAMES.some((allowed) => allowed === name.toLowerCase()),
      ),
    { message: 'upload grant contains an unsafe header' },
  );

export const imageUploadGrantSchema = z.object({
  uploadUrl: z
    .string()
    .url()
    .refine((value) => /^https?:\/\//i.test(value)),
  method: z.literal('PUT'),
  headers: uploadHeaders,
  publicUrl: UploadedAttachmentSchema.shape.publicUrl.refine((value) => {
    // eslint-disable-next-line no-control-regex
    return !/[\s\x00-\x1f\x7f-\x9f()<>[\]\\]/u.test(value);
  }),
  expiresAt: z.string(),
  expiresInSeconds: z.number().int().positive(),
});

// Public mcp-api envelopes, deliberately looser than database row schemas:
// ids/timestamps/source are strings and additive server fields are tolerated.
const searchHit = z.object({
  id: z.string(),
  short_id: z.number().int().nullable().optional(),
  title: z.string(),
  tags: z.array(z.string()),
  updated_at: z.string(),
  gist: z.string().nullable().optional(),
});

export const wireSchemas = {
  image_upload: imageUploadGrantSchema,
  inbox_mute_state: z.object({ send_kinds: z.array(z.string()), key_muted: z.boolean() }),
  inbox_notify: z.object({
    id: z.string(),
    status: z.enum(['sent', 'repeated', 'duplicate', 'muted']),
    repeat_count: z.number(),
    send_kinds: z.array(z.string()),
    key_muted: z.boolean(),
    truncated: z.array(z.string()),
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
  inbox_resolve: z.object({ id: z.string(), status: z.literal('resolved') }),
  key_info: z.object({ access: z.enum(API_KEY_ACCESS_LEVELS) }),
  save_note: z.object({
    ai_excluded: z.unknown(),
    note: z.object({ id: z.string(), title: z.string(), created_at: z.string() }),
    // This vocabulary hint has always been best-effort, including malformed
    // hints from old deployments. It must never prevent a successful save.
    existing_tags: z.array(z.string()).optional().catch(undefined),
  }),
  list_recent_notes: z.object({ notes: z.array(searchHit) }),
  search_notes: z.object({ notes: z.array(searchHit), total: z.number() }),
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
  edit_note: z.object({
    ai_excluded: z.unknown(),
    note: z.object({
      id: z.string(),
      short_id: z.number().int().nullable().optional(),
      title: z.string(),
      updated_at: z.string(),
    }),
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
};
