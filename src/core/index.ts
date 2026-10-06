// @generated — DO NOT EDIT.
//
// Vendored copy of packages/core/src/index.ts, emitted by
// `pnpm --filter @kinjot/core emit:mcp-core` (plans/desktop-app.md §4.5).
// Edit the source module and re-run; CI fails on any difference.

import { z } from 'zod';
import { NOTE_LABEL_PATTERN } from './note-label.js';

// Canonical data model. Mirrors the Postgres schema exactly (see
// docs/technical-plan.md, Phase 0). Timestamps are ISO-8601 strings as
// returned by Postgres timestamptz columns; `updated_at` is always set
// server-side (Postgres trigger in Phase 2+).

export const NOTE_SOURCES = ['web', 'mcp', 'cli', 'vscode'] as const;

const uuid = z.string().uuid();
const timestamptz = z.string().datetime({ offset: true });

/**
 * A jsonb column whose shape belongs to its writer. Deliberately not
 * `z.unknown()`: that accepts *any* value including `undefined`, which makes
 * the object key optional, so a row missing the column entirely would parse.
 * A jsonb column is always present in a server row — null or a value.
 */
const jsonbValue = z.custom<unknown>((value) => value !== undefined, {
  message: 'Required',
});
const codePointLength = (minimum: number, maximum: number) =>
  z.string().refine((value) => {
    const count = Array.from(value).length;
    return count >= minimum && count <= maximum;
  });

/**
 * The pull cursor's ordering key (plans/sync-cursor-fence.md): the xid8 of the
 * transaction that last wrote the row, as a bigint. Server-set by a Postgres
 * trigger, exactly like `updated_at` — clients never write it.
 *
 * Nullable, and required rather than optional, in the *local* schemas: null
 * means "no server revision yet". A row that has never been synced has no
 * transaction id to carry, and Phase 4 reads null as "must not exist on the
 * server". Optional would add an `undefined` third state that means the same
 * thing, so the type is `number | null` and every construction site must say
 * which it is. Rows read back from the server always carry one — see the
 * `Server*` schemas below.
 *
 * Number, not bigint: xid8 is `epoch << 32 | xid`, so passing
 * Number.MAX_SAFE_INTEGER takes roughly 9e15 transactions.
 */
const syncSeq = z.number().int();

export const NoteSchema = z.object({
  id: uuid,
  user_id: uuid,
  title: z.string(),
  body: z.string(),
  folder_id: uuid.nullable(),
  trashed_from_folder_id: uuid.nullable().default(null),
  source: z.enum(NOTE_SOURCES),
  /**
   * A note holds at most one pin, scoped to exactly one view: All Notes
   * (`pinned_in` null) or a single folder (`pinned_in` = that folder's id).
   * `pinned_at` set = pinned, and orders pinned notes (most recent first).
   * Client-written like `deleted_at` — an ordering preference, not a sync
   * cursor.
   */
  pinned_at: timestamptz.nullable(),
  pinned_in: uuid.nullable(),
  sync_seq: syncSeq.nullable(),
  created_at: timestamptz,
  updated_at: timestamptz,
  deleted_at: timestamptz.nullable(),
  // A backend one release behind omits this column. The default keeps the
  // inferred Note key required while allowing its server rows to parse.
  short_id: z.number().int().positive().nullable().default(null),
});
export type Note = z.infer<typeof NoteSchema>;
export type NoteSource = Note['source'];
export { NOTE_LABEL_MAX_CHARS, NOTE_LABEL_PATTERN } from './note-label.js';
export { noteLabel, parseNoteLabel } from './note-label.js';

export const FolderSchema = z.object({
  id: uuid,
  user_id: uuid,
  name: z.string().min(1),
  parent_id: uuid.nullable(),
  ai_excluded_at: timestamptz.nullable().default(null),
  sync_seq: syncSeq.nullable(),
  created_at: timestamptz,
  updated_at: timestamptz,
  deleted_at: timestamptz.nullable(),
  /**
   * Synced folder pin: the instant the folder was pinned, null when it is not
   * (20261001180000_folder_pins.sql). Client-written, like notes.pinned_at. A
   * backend one release behind, an older cached row and an older desktop row
   * all omit it; the default keeps the inferred Folder key required while
   * those rows still parse.
   */
  pinned_at: timestamptz.nullable().default(null),
});
export type Folder = z.infer<typeof FolderSchema>;

export const TagSchema = z.object({
  id: uuid,
  user_id: uuid,
  name: z.string().min(1),
  sync_seq: syncSeq.nullable(),
  created_at: timestamptz,
  updated_at: timestamptz,
  deleted_at: timestamptz.nullable(),
});
export type Tag = z.infer<typeof TagSchema>;

export const EXPORT_FORMAT_VERSION = 2;

// V1 is frozen because real export files on users' disks are validated against it.
export const ExportManifestV1Schema = z
  .object({
    formatVersion: z.number().int().positive(),
    exportedAt: NoteSchema.shape.created_at,
    fileFormat: z.enum(['frontmatter', 'clean']),
    folders: z
      .object({
        id: FolderSchema.shape.id,
        parentId: FolderSchema.shape.parent_id,
        name: z.string(),
      })
      .strict()
      .array(),
    tags: z
      .object({
        id: TagSchema.shape.id,
        name: z.string(),
      })
      .strict()
      .array(),
    notes: z
      .object({
        id: NoteSchema.shape.id,
        folderId: NoteSchema.shape.folder_id,
        path: z.string().min(1),
        title: z.string(),
        tagIds: TagSchema.shape.id.array(),
        source: NoteSchema.shape.source,
        created: NoteSchema.shape.created_at,
        updated: NoteSchema.shape.updated_at,
      })
      .strict()
      .array(),
  })
  .strict();
export type ExportManifestV1 = z.infer<typeof ExportManifestV1Schema>;

/** Version sidecar paths are constrained, never free-form — see below. */
export const EXPORT_VERSION_FILE_PATH =
  /^versions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;

// V1 deliberately accepts any positive integer; the dispatcher gates it, while v2 is literal.
export const ExportManifestV2Schema = z
  .object({
    formatVersion: z.literal(2),
    exportedAt: ExportManifestV1Schema.shape.exportedAt,
    fileFormat: ExportManifestV1Schema.shape.fileFormat,
    folders: ExportManifestV1Schema.shape.folders,
    tags: ExportManifestV1Schema.shape.tags,
    notes: ExportManifestV1Schema.shape.notes.element
      .extend({
        pinnedAt: NoteSchema.shape.pinned_at,
        pinnedIn: NoteSchema.shape.pinned_in,
      })
      .strict()
      .array(),
    versionFiles: z
      .object({
        noteId: uuid,
        path: z.string().regex(EXPORT_VERSION_FILE_PATH),
        count: z.number().int().nonnegative(),
      })
      .strict()
      .array(),
    history: z
      .object({
        included: z.boolean(),
        reason: z.enum(['excluded', 'offline', 'unavailable', 'recording-off']).optional(),
      })
      .strict(),
  })
  .strict();
export type ExportManifestV2 = z.infer<typeof ExportManifestV2Schema>;

/** One note's full version history, newest first. Written to versions/<noteId>.json. */
export const ExportNoteVersionsFileSchema = z
  .object({
    noteId: uuid,
    versions: z
      .object({
        id: uuid,
        title: z.string(),
        body: z.string(),
        created: NoteSchema.shape.created_at,
      })
      .strict()
      .array(),
  })
  .strict();
export type ExportNoteVersionsFile = z.infer<typeof ExportNoteVersionsFileSchema>;

export const ExportManifestSchema = ExportManifestV2Schema;
export type ExportManifest = ExportManifestV2;

// API keys for MCP/CLI access. The full key is shown once at creation; only
// its SHA-256 hex digest is stored. Column grants hide key_hash from clients,
// so reads use ApiKeyPublicSchema; the full schema exists for the Edge
// Function and for the one insert that stores the hash.
export const API_KEY_ACCESS_LEVELS = ['read', 'read_create', 'full'] as const;
export type ApiKeyAccess = (typeof API_KEY_ACCESS_LEVELS)[number];

export const ApiKeySchema = z.object({
  id: uuid,
  user_id: uuid,
  name: z.string().min(1),
  key_prefix: z.string().min(1),
  key_hash: z.string().regex(/^[0-9a-f]{64}$/),
  access: z.enum(API_KEY_ACCESS_LEVELS),
  last_used_at: timestamptz.nullable(),
  revoked_at: timestamptz.nullable(),
  created_at: timestamptz,
  updated_at: timestamptz,
  deleted_at: timestamptz.nullable(),
});
export type ApiKey = z.infer<typeof ApiKeySchema>;

export const ApiKeyPublicSchema = ApiKeySchema.omit({ key_hash: true });
export type ApiKeyPublic = z.infer<typeof ApiKeyPublicSchema>;

// API key format. A key is "kj_live_" + 43 base62 characters (~256 bits); the
// stored prefix is the first 16 characters, enough to recognize a key without
// revealing it.
//
// THIS declaration is the source. The web app (generation) imports it, but the
// other two runtimes cannot and hold hand-written copies instead: the Edge
// Function's `KEY_PATTERN` (supabase/functions/mcp-api/index.ts — the
// Deno/npm boundary) and the CLI's (packages/mcp/src/config.ts — loading the
// vendored core would drag zod into every MCP server start). Both copies are
// pinned back to this one by `.source` equality:
// supabase/tests/core-mirror.unit.test.ts and packages/mcp/src/index.test.ts.
// The comment here used to claim the constant was simply "shared", which it
// has never been.
export const API_KEY_PATTERN = /^kj_live_[A-Za-z0-9]{43}$/;
export const API_KEY_PREFIX_LENGTH = 16;

const KEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function generateApiKey(): string {
  const chars: string[] = [];
  while (chars.length < 43) {
    const bytes = new Uint8Array(64);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      // Rejection sampling: 248 = 4 * 62, so bytes below it map uniformly.
      if (byte < 248 && chars.length < 43) chars.push(KEY_ALPHABET[byte % 62]!);
    }
  }
  return `kj_live_${chars.join('')}`;
}

export function apiKeyPrefix(key: string): string {
  return key.slice(0, API_KEY_PREFIX_LENGTH);
}

/** SHA-256 hex digest — the only form of a key ever stored server-side. */
export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Entitlements: one profile per auth user, auto-created at signup by a
// Postgres trigger. plan is server-authoritative — clients can only read
// their own row; changes come from the billing webhook (service role).
export const PLANS = ['free', 'pro'] as const;

export const ProfileSchema = z.object({
  user_id: uuid,
  plan: z.enum(PLANS),
  /** Provider event timestamp that last set plan (out-of-order guard). */
  plan_event_at: timestamptz.nullable(),
  /**
   * Version recording (on by default for accounts created since 2026-09-28).
   * The one profiles column
   * clients may write — a column-level grant scoped to their own row; the
   * capture trigger reads it server-side, so it gates web and MCP edits alike.
   */
  version_history_enabled: z.boolean(),
  /** Allow tidiness runs to create folders when needed. */
  tidy_create_folders: z.boolean(),
  /** Allow tidiness runs to create tags when needed. */
  tidy_create_tags: z.boolean(),
  /** Allow manual tidiness runs to merge equivalent tags. */
  tidy_merge_tags: z.boolean(),
  /**
   * The billing provider's subscription reference, written by the webhook.
   * Hidden from clients by column grants, so client-side rows never include
   * it — optional so parsing a client-visible row still works.
   */
  billing_ref: z.string().nullable().optional(),
  created_at: timestamptz,
  updated_at: timestamptz,
  deleted_at: timestamptz.nullable(),
});
export type Profile = z.infer<typeof ProfileSchema>;
export type Plan = Profile['plan'];

// Phase 4 AI recall. These tables are server-managed: only Edge Functions
// (service role) write them; clients at most read their own rows. The
// schemas mirror the SQL exactly — `embedding` is pgvector vector(1024)
// serialized as a JSON number array at the PostgREST boundary.
export const EMBEDDING_DIM = 1024;

// No deleted_at on either derived table: embeddings and queue rows are
// hard-deleted (a soft-deleted embedding would retain a representation of
// content the user discarded) — see the migration for the full rationale.
export const NoteEmbeddingSchema = z.object({
  note_id: uuid,
  user_id: uuid,
  embedding: z.array(z.number()).length(EMBEDDING_DIM),
  // A model-written one-line summary (20260708171220); null means generation
  // was attempted and failed, never that the note has nothing worth
  // summarizing.
  gist: z.string().nullable(),
  // notes.sync_seq the embedded content was read at (20260920100000). Null on
  // rows written before the fence existed, or by a writer that omitted it;
  // note_embeddings_refuse_stale skips an update carrying a lower value.
  source_seq: syncSeq.nullable(),
  // SHA-256 of bounded provider inputs and identity. Null means never skip.
  input_hash: z.string().nullable(),
  created_at: timestamptz,
  updated_at: timestamptz,
});
export type NoteEmbedding = z.infer<typeof NoteEmbeddingSchema>;

// One row returned by public.match_related_notes; embeddings stay server-side.
export const RelatedNoteSchema = z.object({
  note_id: uuid,
  similarity: z.number(),
  gist: z.string().nullable(),
  source_maybe_stale: z.boolean(),
});
export type RelatedNote = z.infer<typeof RelatedNoteSchema>;

// Derived keyword-search state. PostgREST serializes tsvector as text;
// clients do not sync this table (20261003120400_note_search_index.sql).
export const NoteSearchSchema = z.object({
  note_id: uuid,
  user_id: uuid,
  search: z.string().nullable(),
  created_at: timestamptz,
  updated_at: timestamptz,
});
export type NoteSearch = z.infer<typeof NoteSearchSchema>;

export const EmbeddingJobSchema = z.object({
  note_id: uuid,
  user_id: uuid,
  attempts: z.number().int(),
  created_at: timestamptz,
  updated_at: timestamptz,
});
export type EmbeddingJob = z.infer<typeof EmbeddingJobSchema>;

// Phase 5 Tidiness. Run and change rows are user content fetched on demand;
// tidy_jobs is rebuildable server-only queue state.
export const TIDY_TRIGGERS = ['manual', 'capture', 'prompted'] as const;
export const TIDY_RUN_STATUSES = [
  'running',
  'pending_confirm',
  'applied',
  'failed',
  'reverted',
] as const;
export const TIDY_CHANGE_KINDS = [
  'create_folder',
  'create_tag',
  'move_note',
  'retag_note',
  'merge_tags',
  'rename_note',
] as const;

export const TidyRunSchema = z.object({
  id: uuid,
  user_id: uuid,
  trigger: z.enum(TIDY_TRIGGERS),
  status: z.enum(TIDY_RUN_STATUSES),
  model: z.string().nullable(),
  note_count: z.number().int(),
  change_count: z.number().int(),
  skipped_count: z.number().int(),
  error: z.string().nullable(),
  /** Prompted runs only: the user's words. Always rendered as plain text. */
  instruction: z.string().nullable(),
  /** The plan a paused run is holding; shape is owned by the Edge Function. */
  pending_plan: jsonbValue.nullable(),
  pending_expires_at: timestamptz.nullable(),
  /** Stamped by resume_tidy_run — the user's consent to a paused plan. */
  confirmed_at: timestamptz.nullable(),
  created_at: timestamptz,
  updated_at: timestamptz,
  deleted_at: timestamptz.nullable(),
});
export type TidyRun = z.infer<typeof TidyRunSchema>;

/**
 * What the confirm card shows. Everything *rendered* is a denormalized name,
 * because the UI renders it as plain text. The one id here is never displayed:
 * a merge is approved by its winner (`merge_winner_ids` on the confirm request)
 * and names are not a key — two tags can differ only by case, and a winner can
 * be a tag the same plan is about to create, so it has no id the client could
 * look up locally. The last three fields are zero-defaulted: the manual pause
 * happens before assignments are planned and cannot know them.
 */
export const TidyPendingSummarySchema = z.object({
  merges: z.array(
    z.object({
      winner_tag_id: uuid,
      winner_name: z.string(),
      loser_names: z.array(z.string()),
    }),
  ),
  create_folders: z.array(z.object({ name: z.string() })),
  create_tags: z.array(z.object({ name: z.string() })),
  moves_by_destination: z
    .array(z.object({ folder_name: z.string(), count: z.number().int().nonnegative() }))
    .default([]),
  retag_note_count: z.number().int().nonnegative().default(0),
  removal_count: z.number().int().nonnegative().default(0),
  /** Present on new prompted pauses. Absent means a recovered legacy pause
   * whose assignment half can only be approved as a whole. */
  note_changes: z
    .array(
      z.object({
        note_id: uuid,
        note_title: z.string(),
        from_folder_name: z.string(),
        to_folder_name: z.string(),
        added_tag_names: z.array(z.string()),
        /** The subset of `added_tag_names` this plan creates, and whether the
         * destination folder is one of its own creations. The confirm leg
         * matches a declined creation by *id*, so a card that matched by name
         * would disable notes bound to a pre-existing folder or tag that merely
         * shares the name. Both are omitted when there is nothing to say. */
        added_new_tag_names: z.array(z.string()).optional(),
        to_folder_is_new: z.boolean().optional(),
        removed_tag_names: z.array(z.string()),
        from_title: z.string().optional(),
        to_title: z.string().optional(),
      }),
    )
    .optional(),
  /** What the run's note scope actually covered. Every prompted run resolves a
   * scope before the snapshot cap — an empty one meaning the whole live
   * non-Trash library — so this is present on all of them, not only the ones a
   * clarification answer narrowed. `matched` is every note the scope selected;
   * `included` is how many the 400-note snapshot could carry. The card must say
   * so whenever `matched > included` — telling a user a partial snapshot covered
   * their whole library is the dishonesty this field exists to prevent. It stays
   * optional in the schema because a pause stored by an older build has none. */
  scope: z
    .object({
      matched: z.number().int().nonnegative(),
      included: z.number().int().nonnegative(),
    })
    .optional(),
});
export type TidyPendingSummary = z.infer<typeof TidyPendingSummarySchema>;

/**
 * One clarification question and its options. **Everything here is app-authored
 * and deterministic — no model call produces it** (`planClarification` in
 * `supabase/functions/_shared/tidy-clarify.ts`). That is what makes answering
 * safe: `label` is display text only, and `scope` is the server's own object,
 * echoed here purely so the client can render and, later, name an option by its
 * opaque `id`. The confirm leg re-reads the chosen option's scope from the
 * stored `pending_plan` row and never from the request, so an answer can only
 * ever *narrow* the note set the planner is shown. Multiple-choice UI is not
 * an injection defense; re-reading the scope server-side is.
 *
 * The ids are opaque and per-pause. Scopes are visible to the client, which is
 * fine — they name the user's own folders and tags.
 */
export const TidyClarifyScopeSchema = z.object({
  folder_ids: z.array(uuid).optional(),
  tag_ids: z.array(uuid).optional(),
  folder_tag_match: z.enum(['all', 'any']).optional(),
  titles: z.enum(['untitled', 'all']).optional(),
  notes: z.enum(['unfiled', 'all']).optional(),
  /** "my 2 latest notes": the N most recently updated notes matching every
   * other dimension. Recency is `updated_at`, the order the note list and
   * `tidy_snapshot` are already in. It narrows what *matched*, not just what
   * the 400-note cap could carry, so the card's count stays truthful. */
  recent: z.number().int().positive().max(9999).optional(),
});
export type TidyClarifyScope = z.infer<typeof TidyClarifyScopeSchema>;

export const TidyClarifyQuestionSchema = z.object({
  id: z.string().min(1),
  prompt: z.string(),
  options: z
    .array(z.object({ id: z.string().min(1), label: z.string(), scope: TidyClarifyScopeSchema }))
    .min(2)
    .max(4)
    // Option ids are the card's selection keys, React keys and radio `value`s
    // all at once, so two options sharing one id would silently answer as a
    // single option. The server's generator already threads unique ids; this is
    // defence against a malformed or drifted response, not a live bug.
    .refine(
      (options) => new Set(options.map((option) => option.id)).size === options.length,
      'option ids must be unique within a question',
    ),
});
export type TidyClarifyQuestion = z.infer<typeof TidyClarifyQuestionSchema>;

/** At most one round, at most three questions. Both caps are contract, not
 * taste: `plans/tidy-titles-and-clarification.md` §Product contract. */
export const MAX_TIDY_CLARIFY_QUESTIONS = 3;

/**
 * The one questions-array shape, shared by every boundary that parses a
 * clarification round: this schema, the `pending_clarify` stream event, and the
 * client's recovery read of a stored pause. They used to state three different
 * rules (min 1 / max 3 here, no bounds at all on the wire, min 1 and no maximum
 * on recovery), which is drift waiting to happen — one exported schema means
 * they cannot disagree again.
 *
 * Question ids name the radio groups and index the selection map in
 * `TidyClarifyCard.tsx`; duplicates would make two questions share one answer.
 *
 * Note this closes a field, where the neighbouring `error.code` is deliberately
 * left open. The difference is what the field *is*: `code` is an extensible
 * vocabulary, and a newer server must be able to send a name this bundle has
 * never heard of. The 1-3 question cap is not a vocabulary — it is a stated
 * product contract (`plans/tidy-titles-and-clarification.md` §Product contract)
 * that the server enforces on the way out. A fourth question arriving would
 * mean the contract changed, and that change belongs in a deploy that updates
 * both sides, not in a client quietly rendering more questions than the product
 * promises.
 *
 * The two boundaries fail differently, and the difference is deliberate. On the
 * live stream this throws inside `parseTidyStreamEvent`, so an old bundle meets
 * a raised cap as "malformed stream data" — bounded, because `maybeClarify`
 * runs before `consume_recall_quota_pro`, so nothing has been charged. Reading
 * the same pause back later is the graceful path: `loadPendingTidyRun` turns a
 * shape it cannot parse into a discardable pause rather than an error, which is
 * what keeps the run from blocking every later one for the rest of its TTL.
 */
export const TidyClarifyQuestionsSchema = z
  .array(TidyClarifyQuestionSchema)
  .min(1)
  .max(MAX_TIDY_CLARIFY_QUESTIONS)
  .refine(
    (questions) => new Set(questions.map((question) => question.id)).size === questions.length,
    'question ids must be unique',
  );

export const TidyClarificationSchema = z.object({
  instruction: z.string(),
  questions: TidyClarifyQuestionsSchema,
});
export type TidyClarification = z.infer<typeof TidyClarificationSchema>;

/**
 * Which shape of pause a `pending_confirm` run is holding, and therefore which
 * card the user is owed. A manual pause stops after the taxonomy call and its
 * ops are individually vetoable; a prompted pause holds a whole planned run and
 * is all-or-nothing, because its moves and tag removals have no name-shaped
 * tick-box the approval vocabulary could carry.
 *
 * Deliberately *not* on the `pending_confirm` stream event: the client already
 * knows which mode it started, and the server only ever pauses a manual run as
 * `manual_taxonomy` and a prompted run as `prompted_full`. Putting it on the
 * wire would add a field the SPA and the Edge Function have to agree on across
 * a non-atomic deploy, to say something the client cannot get wrong. Recovery
 * from a run row reads it off the stored `pending_plan`, which is authoritative.
 */
export const TIDY_PENDING_KINDS = ['manual_taxonomy', 'prompted_full', 'prompted_clarify'] as const;
export type TidyPendingKind = (typeof TIDY_PENDING_KINDS)[number];

/**
 * How long a prompted instruction may be. The enforcing copy is
 * `supabase/functions/_shared/tidy-plan.ts` (Deno cannot import this package);
 * this one exists so the client can say the limit before spending a round trip
 * on a 413. Keep the two in step.
 */
export const MAX_TIDY_INSTRUCTION_CHARS = 500;

/** A planner declining an instruction it cannot serve inside the op vocabulary. */
export const TidyRefusalSchema = z.object({ refusal: z.string() });
export type TidyRefusal = z.infer<typeof TidyRefusalSchema>;

/** The engine's identity for an `error` frame, when it has one worth telling
 * apart. `refused` is the planner declining an instruction — an answer, not a
 * fault, and never a charge. Compared by value at the point of use rather than
 * enumerated on the wire: see the `error` event's schema. */
export const TIDY_REFUSED_CODE = 'refused';

const TidyCreateFolderPayloadSchema = z.object({
  kind: z.literal('create_folder'),
  folder_id: uuid,
  name: z.string(),
  parent_id: uuid.nullable(),
});
const TidyCreateTagPayloadSchema = z.object({
  kind: z.literal('create_tag'),
  tag_id: uuid,
  name: z.string(),
});
const TidyMoveNotePayloadSchema = z.object({
  kind: z.literal('move_note'),
  note_id: uuid,
  note_title: z.string(),
  from_folder_id: uuid.nullable(),
  to_folder_id: uuid.nullable(),
  to_folder_name: z.string().nullable(),
  pin_cleared: z.boolean(),
  pinned_at: timestamptz.nullable(),
  pinned_in: uuid.nullable(),
});
const TidyRetagNotePayloadSchema = z.object({
  kind: z.literal('retag_note'),
  note_id: uuid,
  note_title: z.string(),
  added: z.array(
    z.object({
      tag_id: uuid,
      name: z.string(),
      link_revived: z.boolean(),
      /**
       * The link's `sync_seq` as this run left it. The undo fences its delete
       * on it, so a link the user removed and re-added is not deleted again
       * (audit finding F6). Optional because every entry logged before the
       * fence shipped carries no value, and those keep the older behaviour.
       */
      sync_seq: z.number().int().optional(),
    }),
  ),
  removed: z.array(z.object({ tag_id: uuid, name: z.string() })),
});
const TidyMergeTagsPayloadSchema = z.object({
  kind: z.literal('merge_tags'),
  winner_tag_id: uuid,
  winner_name: z.string(),
  losers: z.array(
    z.object({
      tag_id: uuid,
      name: z.string(),
      moved: z.array(
        z.object({
          note_id: uuid,
          winner_link_created: z.boolean(),
          /** The created winner link's `sync_seq`; see `added.sync_seq`. Only
           * present where `winner_link_created` is true, because that is the
           * only case the undo deletes the link again. */
          winner_link_sync_seq: z.number().int().optional(),
        }),
      ),
    }),
  ),
});
const TidyRenameNotePayloadSchema = z.object({
  kind: z.literal('rename_note'),
  note_id: uuid,
  from_title: z.string(),
  to_title: z.string(),
});

export const TidyChangePayloadSchema = z.discriminatedUnion('kind', [
  TidyCreateFolderPayloadSchema,
  TidyCreateTagPayloadSchema,
  TidyMoveNotePayloadSchema,
  TidyRetagNotePayloadSchema,
  TidyMergeTagsPayloadSchema,
  TidyRenameNotePayloadSchema,
]);
export type TidyChangePayload = z.infer<typeof TidyChangePayloadSchema>;

export const TidyChangeSchema = z
  .object({
    id: uuid,
    run_id: uuid,
    user_id: uuid,
    seq: z.number().int(),
    kind: z.enum(TIDY_CHANGE_KINDS),
    payload: TidyChangePayloadSchema,
    result: z.unknown().nullable(),
    reverted_at: timestamptz.nullable(),
    created_at: timestamptz,
    updated_at: timestamptz,
    deleted_at: timestamptz.nullable(),
  })
  .refine((change) => change.kind === change.payload.kind, {
    message: 'kind must match payload.kind',
    path: ['payload', 'kind'],
  });
export type TidyChange = z.infer<typeof TidyChangeSchema>;

export const AgentActivityObjectSchema = z.object({
  id: uuid,
  name: z.string(),
  created: z.literal(true).optional(),
});
export type AgentActivityObject = z.infer<typeof AgentActivityObjectSchema>;

const AgentActivityBaseSchema = z.object({
  id: uuid,
  user_id: uuid,
  note_id: uuid,
  api_key_id: uuid,
  actor: z.enum(['mcp', 'cli']),
  version_id: uuid.nullable(),
  created_at: timestamptz,
});

export const AgentActivitySchema = z.discriminatedUnion('kind', [
  AgentActivityBaseSchema.extend({
    kind: z.literal('capture'),
    detail: z.object({
      folder: AgentActivityObjectSchema.nullable(),
      tags: z.array(AgentActivityObjectSchema),
    }),
  }),
  AgentActivityBaseSchema.extend({
    kind: z.literal('edit'),
    detail: z.object({
      title_changed: z.literal(true).optional(),
      body: z
        .object({ removed: z.number().int().nonnegative(), added: z.number().int().nonnegative() })
        .optional(),
      tags_added: z.array(AgentActivityObjectSchema).optional(),
      tags_removed: z.array(AgentActivityObjectSchema).optional(),
      folder_from: AgentActivityObjectSchema.nullable().optional(),
      folder_to: AgentActivityObjectSchema.optional(),
      pin_cleared: z.object({ pinned_in: uuid, pinned_at: timestamptz.nullable() }).optional(),
    }),
  }),
  AgentActivityBaseSchema.extend({
    kind: z.literal('append'),
    detail: z.object({ added: z.number().int().nonnegative() }),
  }),
]);
export type AgentActivity = z.infer<typeof AgentActivitySchema>;

/** Server-written Inbox rows: no sync cursor or client mutation surface. */
export const INBOX_KINDS = ['question', 'blocker', 'handoff', 'done', 'waiting'] as const;
export const INBOX_AGENT_KINDS = ['question', 'blocker', 'handoff', 'done'] as const;
export const INBOX_AGENT_ACCESS = ['off', 'read', 'resolve'] as const;
export const INBOX_PER_KEY_HOUR_CAP = 30;
export const INBOX_PER_ACCOUNT_DAY_CAP = 200;
export const INBOX_TITLE_LIMIT = 120;
export const INBOX_DETAIL_LIMIT = 600;
export const INBOX_RESOLUTION_LIMIT = 200;
const STORED_NOTE_LABEL_PATTERN = new RegExp(
  NOTE_LABEL_PATTERN.source,
  NOTE_LABEL_PATTERN.flags.replace('i', ''),
);

export const InboxContextSchema = z.object({
  agent: z
    .string()
    .regex(/^[a-z0-9._-]{1,40}$/)
    .optional(),
  repo: codePointLength(1, 100).optional(),
  branch: codePointLength(1, 200).optional(),
  prs: z.array(z.string().url()).max(3).optional(),
  note: z.string().regex(STORED_NOTE_LABEL_PATTERN).optional(),
  session_id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,100}$/)
    .optional(),
});
export type InboxContext = z.infer<typeof InboxContextSchema>;

export const InboxItemSchema = z.object({
  id: uuid,
  user_id: uuid,
  api_key_id: uuid,
  source: z.enum(['mcp', 'cli']),
  kind: z.enum(INBOX_KINDS),
  title: codePointLength(1, INBOX_TITLE_LIMIT),
  detail: codePointLength(1, INBOX_DETAIL_LIMIT).nullable(),
  context: InboxContextSchema,
  dedupe_key: z.string().regex(/^[0-9a-f]{64}$/),
  last_send_id: uuid.nullable(),
  repeat_count: z.number().int().min(1),
  repeated_at: timestamptz.nullable(),
  surfaced_at: timestamptz,
  read_at: timestamptz.nullable(),
  snoozed_until: timestamptz.nullable(),
  resolved_at: timestamptz.nullable(),
  resolved_by: z.enum(['user', 'agent']).nullable(),
  resolved_key_id: uuid.nullable(),
  resolution: codePointLength(1, INBOX_RESOLUTION_LIMIT).nullable(),
  created_at: timestamptz,
  updated_at: timestamptz,
  deleted_at: timestamptz.nullable(),
});
export type InboxItem = z.infer<typeof InboxItemSchema>;

export const InboxSettingsSchema = z.object({
  user_id: uuid,
  send_kinds: z.array(z.enum(INBOX_KINDS)),
  muted_key_ids: z.array(uuid).max(100),
  agent_access: z.enum(INBOX_AGENT_ACCESS),
  toast: z.boolean(),
  created_at: timestamptz,
  updated_at: timestamptz,
});
export type InboxSettings = z.infer<typeof InboxSettingsSchema>;

export const TidyJobSchema = z.object({
  note_id: uuid,
  user_id: uuid,
  attempts: z.number().int(),
  created_at: timestamptz,
  updated_at: timestamptz,
});
export type TidyJob = z.infer<typeof TidyJobSchema>;

export const TidyStreamEventSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('progress'),
    data: z.object({
      /**
       * Widened to an open string. The trap this retires: a *narrower* type
       * here (an enum over the two values the server emits today) would throw
       * on a third value a future function adds, and `parseTidyStreamEvent`'s
       * `.parse` throwing turns a live, still-applying run (`EdgeRuntime.
       * waitUntil`, §0) into "Tidiness failed — malformed stream data." on any
       * bundle cached before that deploy. The server itself still emits only
       * `'planning'` and `'applying'` — enforced by a narrow helper
       * server-side (`tidy-notes/stream.ts`'s `TidyStreamContext.progress`) —
       * until the 2026 stale bundles have aged out; widening here just means a
       * value it *does* send one day parses instead of crashing every browser
       * that hasn't refreshed. See the forward-compat test in index.test.ts.
       */
      stage: z.string(),
      done: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
      /**
       * Which of the three planning/apply sub-steps this event reports on:
       * `'taxonomy'`, `'assignments'`, or `'applying'`. Optional and open, following the
       * `error` event's `code` field below in this same union (deliberately
       * not an enum, for the same non-atomic-deploy reason) — an older function never
       * sends it, and a newer one may send a phase this bundle has never heard
       * of. `stage` keeps its old two-value meaning forever: `'taxonomy'` and
       * `'assignments'` both ride `stage: 'planning'`, so a client that has
       * never heard of `phase` still shows the right word, just not the finer
       * one. The client prefers `phase` when it recognizes it and falls back
       * to `stage` otherwise (`tidyProgressLabel`, `apps/web/.../TidyModal.tsx`).
       */
      phase: z.string().optional(),
    }),
  }),
  z.object({
    event: z.literal('done'),
    data: z.object({
      runId: uuid,
      applied: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
      change_counts: z.record(z.string(), z.number().int().nonnegative()).optional(),
      /**
       * Present only when the applied plan was empty (plans/tidy-transparency.md
       * §3) — that is the only time a caller needs to say more than `applied`/
       * `skipped` already do. `reasons` is the honest two-way split the server
       * can actually derive, since it holds ops, not interpretation:
       * `reasons: {}` means the planner proposed nothing at all; a non-empty
       * record means it proposed ops and validation (`TidyDropTally` in
       * tidy-plan.ts) dropped every one, with per-reason-code counts.
       *
       * Deliberately not a field on `taxonomySchema`/`assignmentSchema`: under
       * `strict: true` every declared property there is required, so a
       * `reason` field would be one the model has to fill on *every* call —
       * precisely how the taxonomy call talked itself into the `refusal` veto
       * that 8b77267 removed. Diagnostics are derived server-side from the
       * tally, never planner-authored.
       *
       * `reasons` is open-keyed (`z.record`), following `error.code`'s and
       * `phase`'s precedent above: a reason code this bundle has never heard
       * of parses instead of throwing. No model-authored text crosses the
       * wire here — only counts and closed-set reason codes — and no
       * redundant total the client could just sum itself.
       */
      diagnostics: z
        .object({ reasons: z.record(z.string(), z.number().int().nonnegative()) })
        .optional(),
    }),
  }),
  /** Terminal: the run paused for a human confirm and the stream ends here. */
  z.object({
    event: z.literal('pending_confirm'),
    data: z.object({ runId: uuid, summary: TidyPendingSummarySchema }),
  }),
  /**
   * Terminal in exactly the same sense: the run paused to ask, and no `done`
   * follows. A client that treats the stream ending here as a failure would
   * report an error for a run that is waiting on the user.
   */
  z.object({
    event: z.literal('pending_clarify'),
    // The shared shape, not a bare array: the wire is the same contract the
    // stored pause and the planner's own output answer to.
    data: z.object({ runId: uuid, questions: TidyClarifyQuestionsSchema }),
  }),
  z.object({
    event: z.literal('error'),
    /**
     * Deliberately an open string, not an enum over the codes this build knows.
     * Both directions of a non-atomic deploy have to keep the engine's message:
     * an older function omits `code` entirely, and a newer one may send a code
     * this bundle has never heard of. An enum would reject the second and the
     * client would replace a real error with "malformed stream data" — which is
     * exactly the stale-bundle hazard this arc has been careful about. Meaning
     * is assigned at the point of use, by comparing against
     * `TIDY_REFUSED_CODE`; anything else is a plain failure.
     */
    data: z.object({ message: z.string(), code: z.string().optional() }),
  }),
]);
export type TidyStreamEvent = z.infer<typeof TidyStreamEventSchema>;

// parseTidyStreamEvent filters through this set: a name missing here is
// silently dropped, and the client reports "stream ended unexpectedly".
const TIDY_STREAM_EVENT_NAMES = new Set([
  'progress',
  'done',
  'pending_confirm',
  'pending_clarify',
  'error',
]);

/** Unknown events are forward-compatible; known events remain strictly validated. */
export function parseTidyStreamEvent(event: string, data: unknown): TidyStreamEvent | null {
  if (!TIDY_STREAM_EVENT_NAMES.has(event)) return null;
  return TidyStreamEventSchema.parse({ event, data });
}

/**
 * Mirrors the `recall_usage` table. `month` is a period key, not a month:
 * 'YYYY-MM' is the UTC-calendar-month fallback (no subscription anchor) and
 * 'YYYY-MM-DD' is the start date of a billing-anchored period. Both formats
 * are accepted by the table's check constraint; the column keeps its original
 * name because deployed clients still filter on it.
 */
export const PERIOD_KEY_PATTERN = /^\d{4}-\d{2}(-\d{2})?$/;

export const RecallUsageSchema = z.object({
  user_id: uuid,
  month: z.string().regex(PERIOD_KEY_PATTERN),
  count: z.number().int(),
  semantic_search_count: z.number().int(),
  /**
   * Dictation credits and audio seconds spent in this period
   * (`plans/voice-to-text.md` §3b). Two counters and not one: credits are the
   * meter, seconds are the audit trail that makes a future re-pricing
   * reconcilable — and the figure a human is actually shown. Both are `not
   * null default 0` on the table, so a row always carries them.
   */
  voice_credits: z.number().int(),
  voice_seconds: z.number().int(),
  created_at: timestamptz,
  updated_at: timestamptz,
  deleted_at: timestamptz.nullable(),
});
export type RecallUsage = z.infer<typeof RecallUsageSchema>;

/**
 * The caller's own counters plus the quota window they belong to, as returned
 * by the `current_recall_usage()` RPC. The window is server-resolved: with
 * billing-anchored periods a browser cannot derive the period key, and one
 * that guessed would silently report zero usage.
 */
export const RecallPeriodUsageSchema = z.object({
  period_key: z.string().regex(PERIOD_KEY_PATTERN),
  period_start: timestamptz,
  period_end: timestamptz,
  recall_count: z.number().int(),
  semantic_search_count: z.number().int(),
  /**
   * Dictation counters, `.optional()` for the same reason the voice fields on
   * {@link UsageLimitsSchema} are. This RPC's return shape is a property of
   * the *database*, and on BYO the database is whatever the operator last ran
   * `update` against while `byo.kinjot.com` serves them the newest client. A
   * backend one release behind returns five columns, not seven; requiring
   * these would throw on the Usage tab of every operator who has not updated,
   * which is the normal state during a rollout rather than a fault. Read them
   * as zero when absent.
   */
  voice_credits: z.number().int().optional(),
  voice_seconds: z.number().int().optional(),
});
export type RecallPeriodUsage = z.infer<typeof RecallPeriodUsageSchema>;

/**
 * One dictation engine's price, as the server publishes it
 * (`plans/voice-to-text.md` §2b, verified 2026-09-19). Mirrors
 * `supabase/functions/_shared/voice-credits.ts`, which is the server's copy,
 * and `apps/web/src/lib/voice/credits.ts`, which is the client's fallback.
 *
 * `model` is deliberately a plain string rather than an enum: the rate table
 * is *data* the server owns, and a client that rejected a row naming an
 * engine it had not heard of would fail the whole response the first time a
 * newer backend added one.
 */
export const VoiceCreditRateSchema = z.object({
  model: z.string().min(1),
  credits_per_minute: z.number().int().positive(),
  is_default: z.boolean(),
});
export type VoiceCreditRate = z.infer<typeof VoiceCreditRateSchema>;

/**
 * Effective per-period limits returned by the authenticated usage-limits
 * function. `month` is the UTC calendar month the response was built in; it is
 * unrelated to the caller's quota window (which comes from
 * {@link RecallPeriodUsageSchema}) and is retained only for older clients.
 *
 * A `null` limit means **uncapped** (WP-H of
 * `plans/byo-selfhost-distribution.md`). A self-hosted deployment's operator
 * pays their own provider bills, so `RECALL_MONTHLY_LIMIT=unlimited` switches
 * the ceiling off — and the wire form has to be a shape the Usage view can
 * render as "no limit" rather than as the int4 the quota RPC receives. Hosted
 * never sends it: `_shared/limits.ts` reaches uncapped only through that one
 * word, which no numeric misconfiguration can spell.
 */
export const UsageLimitsSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  recall_monthly_limit: z.number().int().positive().nullable(),
  history_search_monthly_limit: z.number().int().positive().nullable(),
  /**
   * Dictation's separate ceiling and the prices behind it
   * (`plans/voice-to-text.md` §3f). **Both are `.optional()`, and that is
   * load-bearing rather than tidy.** The frontend ↔ Edge Function axis is
   * ungated on BYO: `byo.kinjot.com` serves catalog head to every operator
   * while the backend they own is whatever they last ran `update` against, so
   * a newer client routinely meets a `usage-limits` that has never heard of
   * voice. **Absence is the normal case during a rollout, not a fault** —
   * requiring either field would throw for every operator who has not
   * updated. The client falls back to its own copy of the rate table and
   * never errors.
   *
   * `null` on the limit keeps its established meaning from the two fields
   * above: uncapped, which a self-hosted operator reaches with
   * `VOICE_CREDITS_MONTHLY_LIMIT=unlimited`. Undefined means "this backend
   * did not say"; the two are different answers and the UI treats them so.
   */
  voice_credits_monthly_limit: z.number().int().positive().nullable().optional(),
  voice_credit_rates: z.array(VoiceCreditRateSchema).optional(),
  /**
   * The longest single recording this deployment accepts, in seconds
   * (`VOICE_MAX_SECONDS`, default 300).
   *
   * `.optional()` for the same N−1 reason as the two fields above, and with
   * the same client contract: **absent means "this backend did not say"**, and
   * the client falls back to its own constant rather than erroring.
   *
   * It is on the wire at all because without it a lowered ceiling is
   * unreachable. The client caps its own recording, so if it capped at 120
   * against a deployment configured at 30, every request would be refused
   * `cap_too_large` before any provider spend and paid dictation would be
   * dead for that operator with no way to discover why. The client takes
   * `min(server, client)`.
   *
   * Not nullable: unlike the quota ceilings there is no "uncapped" reading —
   * an unbounded single request is the cost-safety hole §7 exists to close,
   * and `maxCapSeconds()` collapses the `unlimited` sentinel to the default
   * for that reason.
   */
  voice_max_seconds: z.number().int().positive().optional(),
});
export type UsageLimits = z.infer<typeof UsageLimitsSchema>;

export const AiSecretNameSchema = z.enum(['OPENAI_API_KEY', 'VOYAGE_API_KEY']);
export type AiSecretName = z.infer<typeof AiSecretNameSchema>;

/** Presence-only status from the authenticated deployment runtime. */
export const AiConfigurationSchema = z
  .object({
    state: z.enum(['missing', 'partial', 'configured']),
    openai: z.boolean(),
    voyage: z.boolean(),
    missing: z.array(AiSecretNameSchema),
  })
  .superRefine((value, ctx) => {
    const expected = [
      ...(value.openai ? [] : (['OPENAI_API_KEY'] as const)),
      ...(value.voyage ? [] : (['VOYAGE_API_KEY'] as const)),
    ];
    const expectedState =
      expected.length === 0 ? 'configured' : expected.length === 2 ? 'missing' : 'partial';
    if (
      value.state !== expectedState ||
      value.missing.length !== expected.length ||
      value.missing.some((name, index) => name !== expected[index])
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'inconsistent AI configuration' });
    }
  });
export type AiConfiguration = z.infer<typeof AiConfigurationSchema>;

// The recall Edge Function's response shape, shared with the web UI.
export const RecallSourceSchema = z.object({
  id: uuid,
  title: z.string(),
});
export type RecallSource = z.infer<typeof RecallSourceSchema>;

/** One completed Recall row as stored by Postgres, including derived search state. */
export const StoredRecallSchema = z.object({
  id: uuid,
  user_id: uuid,
  query: z.string(),
  answer: z.string(),
  sources: z.array(RecallSourceSchema),
  search_embedding: z.array(z.number()).length(EMBEDDING_DIM).nullable(),
  pinned_at: timestamptz.nullable(),
  created_at: timestamptz,
  updated_at: timestamptz,
  deleted_at: timestamptz.nullable(),
});
export type StoredRecall = z.infer<typeof StoredRecallSchema>;

/** Client-visible completed Recall answer; derived vectors never cross this boundary. */
export const RecallSchema = StoredRecallSchema.omit({ search_embedding: true });
export type Recall = z.infer<typeof RecallSchema>;
export const RecallMetaSchema = RecallSchema.omit({ answer: true });
export type RecallMeta = z.infer<typeof RecallMetaSchema>;
export const SemanticRecallMatchSchema = RecallMetaSchema.extend({
  similarity: z.number().min(0).max(1),
});
export type SemanticRecallMatch = z.infer<typeof SemanticRecallMatchSchema>;

export interface RecallListOptions {
  pageSize?: number;
  offset?: number;
  search?: string;
}

export interface RecallListPage {
  items: RecallMeta[];
  total: number;
  hasMore: boolean;
}

export const RecallDoneSchema = z.object({
  recallId: uuid.optional(),
  historySaved: z.boolean().optional(),
});
export type RecallDone = z.infer<typeof RecallDoneSchema>;
export const RecallAnswerSchema = z.object({
  answer: z.string(),
  sources: z.array(RecallSourceSchema),
});
export type RecallAnswer = z.infer<typeof RecallAnswerSchema>;

export const RecallMatchSchema = RecallSourceSchema.extend({
  similarity: z.number().finite(),
});
export type RecallMatch = z.infer<typeof RecallMatchSchema>;

export const RecallStreamEventSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('matches'),
    data: z.object({
      matches: z.array(RecallMatchSchema),
      total: z.number().int().nonnegative(),
    }),
  }),
  z.object({
    event: z.literal('answer.delta'),
    data: z.object({ text: z.string() }),
  }),
  z.object({
    event: z.literal('sources'),
    data: z.object({ sources: z.array(RecallSourceSchema) }),
  }),
  z.object({
    event: z.literal('done'),
    data: RecallDoneSchema,
  }),
  z.object({
    event: z.literal('error'),
    data: z.object({ message: z.string() }),
  }),
]);
export type RecallStreamEvent = z.infer<typeof RecallStreamEventSchema>;

const RECALL_STREAM_EVENT_NAMES = new Set(['matches', 'answer.delta', 'sources', 'done', 'error']);

/** Unknown events are forward-compatible; known events remain strictly validated. */
export function parseRecallStreamEvent(event: string, data: unknown): RecallStreamEvent | null {
  if (!RECALL_STREAM_EVENT_NAMES.has(event)) return null;
  return RecallStreamEventSchema.parse({ event, data });
}

// The billing-links Edge Function's response shape. Checkouts are only
// minted for users who can use them (null for pro); portal URLs are
// pre-signed and short-lived — fetched on click, never cached.
//
// `plan` was always in the function's body and was dropped here until the
// standalone `/upgrade` route needed it (`plans/checkout-flow.md` WP2). It is
// the difference between "no checkout was minted" and "no checkout was minted
// *because you already subscribed*", and inferring that from two nulls is
// wrong in exactly the case that matters: a pro row whose `billing_ref` is
// missing answers null to both, and reading that as an error tells a paying
// user their checkout is broken.
export const BillingLinksSchema = z.object({
  plan: z.enum(PLANS),
  checkoutUrl: z.string().url().nullable(),
  portalUrl: z.string().url().nullable(),
});
export type BillingLinks = z.infer<typeof BillingLinksSchema>;

// The delete-account Edge Function's 200 body is a closed contract: only this
// exact shape proves the auth user is gone and local recovery state may be
// retired, so adding a field is a breaking change (`.strict()` enforces it —
// clients treat any other 200 as an ambiguous, possibly partial deletion).
export const DeletedAccountResponseSchema = z.object({ deleted: z.literal(true) }).strict();

// The `kinjot_schema_compatibility()` RPC's response: one integer naming the
// sync-protocol epoch the connected database's schema speaks (migration
// 20260924062132, the kinjot-named twin of 20260910033812). WP3 of
// `plans/byo-supabase-implementation.md`.
//
// Strict on purpose. A database whose answer the client cannot recognize is
// not a database it should sync against: a float, a string, a negative number
// and a null must all land in the same unsupported bucket, and the client must
// never coerce its way to a number it can compare.
export const SchemaCompatibilityEpochSchema = z.number().int().positive();
export type SchemaCompatibilityEpoch = z.infer<typeof SchemaCompatibilityEpochSchema>;

// Note version history. Every content edit snapshots the note's *previous*
// title/body here (Postgres trigger). Rows are user content — soft-deletable
// and purged on account deletion — but immutable in practice: clients get
// SELECT only, and reads are Pro-gated by RLS. Not sync-pulled; fetched on
// demand, so there is no Dexie table for them.
export const NoteVersionSchema = z.object({
  id: uuid,
  note_id: uuid,
  user_id: uuid,
  title: z.string(),
  body: z.string(),
  created_at: timestamptz,
  updated_at: timestamptz,
  deleted_at: timestamptz.nullable(),
});
export type NoteVersion = z.infer<typeof NoteVersionSchema>;

// History listings never fetch bodies (they can be large and there can be
// many versions): the list shows metadata, and a body is loaded only when a
// version is opened for diffing.
export const NoteVersionMetaSchema = NoteVersionSchema.omit({ body: true });
export type NoteVersionMeta = z.infer<typeof NoteVersionMetaSchema>;

// Server history alone has attribution. Local SQLite and demo history rows
// remain typed by the schemas above and have no matching columns.
export const NoteVersionAttributionSchema = NoteVersionMetaSchema.extend({
  actor: z.string().nullable().default(null),
  api_key_id: z.string().nullable().default(null),
});
export type NoteVersionAttribution = z.infer<typeof NoteVersionAttributionSchema>;

// Join rows carry the full audit column set: the sync cursor pulls each table
// by (user_id, updated_at), and removals are soft-deletes like everywhere else.
export const NoteTagSchema = z.object({
  note_id: uuid,
  tag_id: uuid,
  user_id: uuid,
  sync_seq: syncSeq.nullable(),
  created_at: timestamptz,
  updated_at: timestamptz,
  deleted_at: timestamptz.nullable(),
});
export type NoteTag = z.infer<typeof NoteTagSchema>;

/**
 * The same four rows as they come back from Postgres, where the trigger has
 * always set `sync_seq`. Parse server responses with these: the local schemas
 * accept null, so they would wave through a response that lost the column —
 * a column-list select that forgot it, or a future RPC returning a projection
 * — and the pull would then advance its cursor off rows carrying no cursor
 * key at all. Requiring it here turns that into a parse error at the boundary.
 */
export const ServerNoteSchema = NoteSchema.extend({ sync_seq: syncSeq });
export const ServerFolderSchema = FolderSchema.extend({ sync_seq: syncSeq });
export const ServerTagSchema = TagSchema.extend({ sync_seq: syncSeq });
export const ServerNoteTagSchema = NoteTagSchema.extend({ sync_seq: syncSeq });

/**
 * `public.sync_status()`'s payload (20260920090000_sync_status.sql): the
 * snapshot watermark plus each synced table's highest `sync_seq` visible to
 * the caller, all from one snapshot.
 *
 * It mirrors a SQL contract, so it lives beside the server-row schemas and is
 * parsed at the boundary rather than trusted. A null max means the caller has
 * no rows in that table; the client reads that as "nothing to fetch", which is
 * exactly the answer a missing or misspelled key must NOT be allowed to
 * impersonate — hence required keys and a parse error rather than a default.
 *
 * Both the watermark and the maxes are `bigint` in Postgres. xid8-derived
 * values are far below `MAX_SAFE_INTEGER` (see the fence migration), so they
 * are safe as JS numbers, and a numeric string is coerced the way the client
 * has always coerced `sync_watermark()`'s scalar — one Postgres/PostgREST
 * bigint-serialization difference must not take the whole pull down. Anything
 * that is not a number or a numeric string still fails the parse.
 *
 * Plain `z.object`, never `.strict()`: like the server-row schemas it strips
 * unknown keys, so adding a table to a later `sync_status()` cannot break an
 * already-deployed client.
 */
const bigintNumber = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() !== '' ? Number(value) : value),
  syncSeq,
);
export const SyncStatusSchema = z.object({
  watermark: bigintNumber,
  folders: bigintNumber.nullable(),
  tags: bigintNumber.nullable(),
  notes: bigintNumber.nullable(),
  note_tags: bigintNumber.nullable(),
});
export type SyncStatus = z.infer<typeof SyncStatusSchema>;

/**
 * Image attachments (plans/image-attachments-2026-09-20.md §3.1–§3.2, §4.3).
 *
 * These mirror a SQL contract — `20260920115518_note_attachments_bucket.sql` —
 * exactly as the row schemas above mirror their tables, and they are pinned to
 * that file by `supabase/tests/attachments-contract.unit.test.ts`. They live in
 * core rather than in the SPA because the same constants describe the Supabase
 * backend and the later R2 one, and because a self-hosted operator's client and
 * their database must agree on them.
 *
 * There is deliberately no attachment *row* schema: the object key is minted at
 * upload time and the public URL lives in the note body, so nothing about an
 * attachment is synced, exported as a manifest row, or held in the outbox.
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
 * Kept as a source-of-truth constant so a client can refuse a malformed key
 * before a round trip — never as the authorization. The policy is.
 */
export const ATTACHMENT_KEY_PATTERN = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(webp|png|jpe?g)$/;

/**
 * Per-object ceiling, enforced server-side by `storage.buckets.file_size_limit`.
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
 * a credential boundary: on Supabase Storage the server's own client headers
 * carry the service-role key. The response's header names are pinned to this
 * list by `mcp-api-image-upload.unit.test.ts`, never projected from a client.
 * The reasoning and the measurement behind leaving `x-upsert` out are in
 * `supabase/functions/_shared/attachments.ts`,
 * whose copy `attachments-contract.unit.test.ts` pins equal to this one.
 */
export const ATTACHMENT_UPLOAD_HEADER_NAMES = ['content-type', 'cache-control'] as const;

/**
 * Per-user ceilings, checked before an upload against `attachment_usage()`.
 *
 * On the Supabase backend these are **advisory** (plan D9): the browser uploads
 * directly under RLS, so a session-JWT holder can PUT past them, and it is the
 * operator's own project and bill. On the hosted R2 backend the equivalent
 * check happens inside the grant function, where it is real.
 *
 * The count ceiling is not redundant with the byte ceiling: bytes alone permit
 * millions of tiny objects, which costs per-write charges and would make any
 * bounded listing of a prefix incomplete. `attachment_usage()` stops scanning
 * at `ATTACHMENT_OBJECT_COUNT_LIMIT + 1` rows for that reason and reports
 * `truncated`, which a caller must treat as over-quota rather than as a
 * prompt to scan further.
 */
export const ATTACHMENT_TOTAL_BYTES_LIMIT = 1024 * 1024 * 1024;
export const ATTACHMENT_OBJECT_COUNT_LIMIT = 2000;

/**
 * The **hosted** byte ceiling, which is deliberately a different number from
 * the one above rather than a raise of it.
 *
 * `ATTACHMENT_TOTAL_BYTES_LIMIT` is the Supabase-backend ceiling: advisory on
 * a BYO project (D9), in the operator's own bucket and on their own bill, and
 * pinned to the SQL contract by `attachments-contract.unit.test.ts`. Hosted's
 * bytes are in R2 instead, where `attachment-grant` is the only source of an
 * upload URL and the ceiling is therefore real and ours to set. Zain set it at
 * 2 GiB (`plans/image-management-2026-09-22.md` §1).
 *
 * Raising the shared constant instead would also raise what a BYO operator's
 * client advertises and pre-checks against, in a project this repository does
 * not pay for and whose `attachment_usage()` was never told.
 *
 * The **object** ceiling is not duplicated: it is 2,000 on both backends, and
 * the migration's scan bound (`limit 2001`) is written against that one number.
 */
export const ATTACHMENT_HOSTED_TOTAL_BYTES_LIMIT = 2 * 1024 * 1024 * 1024;

/** `public.attachment_usage()`'s payload. */
export const AttachmentUsageSchema = z.object({
  total_bytes: z.number().int().nonnegative(),
  object_count: z.number().int().nonnegative(),
  truncated: z.boolean(),
  // Hosted reports its enforced ceilings; optional because BYO's
  // public.attachment_usage() still returns only the three fields above.
  total_bytes_limit: z.number().int().positive().optional(),
  object_count_limit: z.number().int().positive().optional(),
});
export type AttachmentUsage = z.infer<typeof AttachmentUsageSchema>;

/**
 * What an upload returns: the permanent, absolute, public URL for the body.
 *
 * Constrained to `http(s)` on purpose. `z.string().url()` alone accepts a
 * `data:` URI, and a base64 image in a note body is the trap this design exists
 * to avoid: a 2 MB screenshot becomes ~2.7 MB of text travelling through the
 * outbox, a Postgres `text` column, PostgREST JSON, MiniSearch, the embedding
 * request, the `BroadcastChannel` clone and every export. A `blob:` URL is the
 * other near miss — it is session-scoped, so it would render for its author and
 * be broken for everyone and every agent. Neither can reach a body through this
 * boundary.
 */
export const UploadedAttachmentSchema = z.object({
  publicUrl: z
    .string()
    .url()
    .refine((value) => /^https?:\/\//.test(value), {
      message: 'An attachment URL must be absolute http(s) — never a data: or blob: URL',
    }),
});
export type UploadedAttachment = z.infer<typeof UploadedAttachmentSchema>;

/**
 * Byte-level image handling: the PNG chunk walker and keep-list, and the
 * metadata sanitizer for agent uploads (`plans/agent-image-upload-2026-09-25.md`
 * §4.2).
 *
 * Deliberately barrel-reachable, for both of its consumers: the SPA's PNG fast
 * path (`apps/web/src/lib/image-transcode.ts`) walks chunks with it, and the
 * vendoring generator copies it into `packages/mcp/src/core` for the
 * `upload_image` tool, which has no canvas and so strips metadata at the byte
 * level. Dependency-free, so it drags nothing into either consumer.
 */
export * from './image-bytes.js';

/**
 * The canonical SQLite schema for the local store, emitted into the desktop
 * crate's migrations (plans/desktop-app.md §4.4). Re-exported here so the
 * column map — the one source for what columns exist — is reachable from the
 * same import as the Zod row schemas it mirrors.
 */
export * from './sqlite-ddl.js';

/**
 * The shared save-note semantics (plans/desktop-app.md §6): pure planning
 * functions that turn "jot this, here, with these tags" into row inserts,
 * ported from `mcp_save_note` and pinned to it by a conformance suite.
 *
 * Deliberately barrel-reachable: the barrel's closure is exactly what the
 * vendoring generator (§4.5) copies into `packages/mcp/src/core`, and WP6's
 * local-library CLI is the reason this module exists. Dependency-free, so it
 * drags nothing into either consumer.
 */
export * from './save-note.js';

// The shared LocalStore fixture format lives in `./local-store-fixtures` and is
// deliberately NOT re-exported here. This barrel is imported by the SPA (via
// local-store.ts, for the column map), so anything exported from it can end up
// in the app bundle — and a test-only Zod schema has no business shipping to a
// browser. Test runners import that module by path.

/**
 * The `/admin` dashboard's response contract (`plans/admin-analytics.md` §5).
 *
 * Barrel-reachable because the SPA's admin route parses the Edge Function's
 * body with it, and every other wire schema the SPA validates lives here. The
 * cost of that placement is that the vendoring generator above copies it into
 * `packages/mcp/src/core` as well, where nothing uses it: the closure rule is
 * deliberately mechanical, and a second fence for one module would be a worse
 * trade than a few hundred unused lines in a package that already ships the
 * whole row model.
 */
export * from './admin-analytics.js';

export * from './reminders.js';
