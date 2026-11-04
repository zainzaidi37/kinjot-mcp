// @generated — DO NOT EDIT.
//
// Vendored copy of packages/core/src/attachments.ts, emitted by
// `pnpm --filter @kinjot/core emit:mcp-core` (plans/desktop-app.md §4.5).
// Edit the source module and re-run; CI fails on any difference.

/**
 * Image attachments (plans/image-attachments-2026-09-20.md §3.1–§3.2, §4.3).
 *
 * These mirror a SQL contract — `20260920115518_note_attachments_bucket.sql` —
 * exactly as the row schemas in `packages/core/src/index.ts` mirror their tables. They live in
 * core rather than in the SPA because the same constants describe the Supabase
 * backend and the R2 one, and because a self-hosted operator's client and their
 * database must agree on them.
 *
 * There is deliberately no attachment *row* schema: the object key is minted at
 * upload time and the public URL travels with the synced and exported note
 * body. The object has no separate manifest row or outbox entry.
 *
 * This module is emitted as `supabase/functions/_shared/core/attachments.ts` by
 * `pnpm --filter @kinjot/core emit:edge-core`, which accepts no import here but
 * `zod`; the SQL migration is the copy kept equal by review.
 */
export const ATTACHMENT_BUCKET = 'note-attachments';

/**
 * The extensions the bucket's name-shape policy admits, and the declared MIME
 * type each one maps to. The map is the whole reason this is not just a list:
 * Storage checks `allowed_mime_types` against the *declared* Content-Type, so
 * an uploader that declares the wrong type for its extension is rejected by
 * the server rather than silently storing a mislabelled object.
 *
 * `jpg` and `jpeg` both map to `image/jpeg`; the policy regex accepts `jpe?g`.
 */
export const ATTACHMENT_MIME_TYPES = {
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
} as const;

export type AttachmentExtension = keyof typeof ATTACHMENT_MIME_TYPES;
export const ATTACHMENT_EXTENSIONS = Object.keys(
  ATTACHMENT_MIME_TYPES,
) as readonly AttachmentExtension[];

/**
 * The object key shape, as a regex identical to the one in the INSERT policy.
 * `<uid>/<uuid>.<ext>`: the first segment is the tenant boundary the policy
 * checks against `auth.uid()`, the second is a client-minted UUID, and nothing
 * in the key comes from a filename, a body path or a content hash.
 *
 * On R2 the first segment is instead the opaque per-user prefix
 * (`attachmentPrefix` in `supabase/functions/_shared/attachment-r2.ts`). It is
 * UUID-shaped, so one pattern covers both backends and R2 public URLs carry no
 * user id.
 *
 * Kept as a source-of-truth constant so a client can refuse a malformed key
 * before a round trip — never as the authorization. The policy is.
 */
export const ATTACHMENT_KEY_PATTERN = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(webp|png|jpe?g)$/;

/**
 * Per-object ceiling, enforced server-side by `storage.buckets.file_size_limit`.
 * On R2 it is the size the grant signs.
 *
 * Exactly `MAX_IMPORT_FILE_BYTES` (25 MiB), so no stored attachment can be one
 * an export round trip's own importer would reject.
 */
export const ATTACHMENT_MAX_OBJECT_BYTES = 25 * 1024 * 1024;

/**
 * Time bound on one upload attempt, shared by both backends.
 *
 * Without it a stalled connection hangs the upload for as long as the browser's
 * own default allows — which, for `fetch`, is effectively forever — with the
 * paste affordance waiting on it. Generous rather than tight: 25 MiB on a poor
 * mobile connection is a slow but legitimate upload.
 *
 * Lives in core beside the shared attachment constants because both the web
 * backends and the agent upload path use the same deadline.
 */
export const ATTACHMENT_UPLOAD_TIMEOUT_MS = 60_000;

/**
 * The only header names an agent upload grant may tell a client to send with
 * its PUT; the `upload_image` client refuses a grant that names any other. It is
 * a credential boundary: on Supabase Storage, storage-js's upload merges its
 * client's `apikey` and `Authorization` into the request, and in an Edge
 * Function those carry the service-role key. The hosted grant's header names
 * are pinned to this list by `mcp-api-image-upload.unit.test.ts`, never
 * projected from a client.
 *
 * `x-upsert` is left out because a signed upload takes upsert from its token,
 * and a second PUT with `x-upsert: true` is refused as a duplicate (measured on
 * the local stack, 2026-09-25).
 */
export const ATTACHMENT_UPLOAD_HEADER_NAMES = ['content-type', 'cache-control'] as const;

/**
 * Per-user ceilings, checked before an upload against `attachment_usage()`.
 *
 * On the Supabase backend these are **advisory**
 * (`plans/image-attachments-2026-09-20.md` D9): the browser uploads directly
 * under RLS, so a session-JWT holder can PUT past them, and it is the
 * operator's own project and bill. On the hosted R2 backend the equivalent
 * check happens inside the grant function, where it is real.
 *
 * The count ceiling is not redundant with the byte ceiling: bytes alone permit
 * millions of tiny objects, which costs per-write charges and would make any
 * bounded listing of a prefix incomplete. `attachment_usage()` stops scanning
 * at `ATTACHMENT_OBJECT_COUNT_LIMIT + 1` rows for that reason and reports
 * `truncated`, which a caller must treat as over-quota rather than as a prompt
 * to scan further.
 */
export const ATTACHMENT_TOTAL_BYTES_LIMIT = 1024 * 1024 * 1024;
export const ATTACHMENT_OBJECT_COUNT_LIMIT = 2000;

/**
 * The **hosted** byte ceiling, which is deliberately a different number from
 * the one above rather than a raise of it.
 *
 * `ATTACHMENT_TOTAL_BYTES_LIMIT` is the Supabase-backend ceiling: advisory on a
 * BYO project, in the operator's own bucket and on their own bill
 * (`plans/image-attachments-2026-09-20.md` D9), and equal to the SQL contract.
 * Hosted's bytes
 * are in R2 instead, where `attachment-grant` is the only source of an upload
 * URL and the ceiling is enforced there: 2 GiB
 * (`plans/image-management-2026-09-22.md` §1). `mintAttachmentGrant` enforces
 * it for `attachment-grant` and `mcp-api`'s `image_upload`.
 *
 * Raising the shared constant instead would also raise what a BYO operator's
 * client advertises and pre-checks against, in a project this repository does
 * not pay for and whose `attachment_usage()` was never told.
 *
 * The **object** ceiling is not duplicated: it is 2,000 on both backends, and
 * the migration's scan bound (`limit 2001`) is written against that one number.
 */
export const ATTACHMENT_HOSTED_TOTAL_BYTES_LIMIT = 2 * 1024 * 1024 * 1024;
