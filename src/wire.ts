import { z } from 'zod';
import {
  ATTACHMENT_UPLOAD_HEADER_NAMES,
  EXTENSION_RESPONSE_SCHEMAS,
  UploadedAttachmentSchema,
} from './core/index.js';

const uploadHeaders = z
  .record(z.string(), z.string())
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
// The actions the browser extension shares are defined once, in core's
// `extension-wire.ts` (`EXTENSION_RESPONSE_SCHEMAS`).
const shared = EXTENSION_RESPONSE_SCHEMAS;

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
  inbox_list: shared.inbox_list,
  inbox_resolve: z.object({ id: z.string(), status: z.literal('resolved') }),
  key_info: shared.key_info,
  save_note: shared.save_note,
  list_recent_notes: shared.list_recent_notes,
  list_open_tasks: z.object({
    notes: z.array(
      z.object({
        id: z.string(),
        short_id: z.number().int().nullable().optional(),
        title: z.string(),
        folder: z.string().nullable(),
        tasks: z.array(
          z.object({ text: z.string(), line: z.number(), due: z.string().nullable() }),
        ),
      }),
    ),
    scanned: z.number(),
    truncated: z.boolean(),
  }),
  search_notes: shared.search_notes,
  recall: shared.recall,
  edit_note: z.object({
    ai_excluded: z.unknown().optional(),
    note: z.object({
      id: z.string(),
      short_id: z.number().int().nullable().optional(),
      title: z.string(),
      updated_at: z.string(),
    }),
  }),
  append_note: shared.append_note,
  get_note: shared.get_note,
};
