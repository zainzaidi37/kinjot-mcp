// @generated — DO NOT EDIT.
//
// Vendored copy of packages/core/src/save-note.ts, emitted by
// `pnpm --filter @kinjot/core emit:mcp-core` (plans/desktop-app.md §4.5).
// Edit the source module and re-run; CI fails on any difference.

/**
 * Pure planning functions for the save-note operation
 * (`plans/desktop-app.md` §6, "Shared save-note semantics").
 *
 * `mcp_save_note` — the Postgres function the MCP server and CLI have always
 * written through — is the only place in the product where "jot this down,
 * into this folder, with these tags" is spelled out. Phase 8 gives the CLI a
 * *local* library to write to, with no Postgres behind it, so that logic has
 * to exist twice. Ported by hand it would drift, and the drift would be
 * silent: the same `jot` command producing a different tag row depending on
 * whether the user happened to be signed in.
 *
 * So the logic is ported **once, here, as a pure function**, and a conformance
 * suite (`supabase/tests/save-note-conformance.test.ts`) diffs the rows this
 * module plans against the rows `mcp_save_note` actually writes, on every CI
 * run that touches this package.
 *
 * ## Shape: a planner, not a store
 *
 * `(existing folders, existing tags, input) -> row insert ops`. This module
 * reads nothing and writes nothing; the caller queries its own store for the
 * two lookups the SQL performs, hands them in, and applies the returned ops.
 * §6 rejects an abstract store interface in `packages/core` explicitly — it
 * would grow a second `NotesRepo` beside the frozen one.
 *
 * ## Purity: no clock, no crypto
 *
 * New-row ids and the timestamp are **inputs** ({@link SaveNoteContext.newId},
 * {@link SaveNoteContext.now}), never read from the ambient environment. Two
 * reasons beyond testability. The vendored copy of this file runs inside the
 * `kinjot` CLI (§4.5), where a global `crypto` is not guaranteed across the
 * whole supported Node range; and a planner that reads the clock cannot be
 * replayed, which is what the conformance suite does to compare two engines.
 *
 * ## Timestamp and `sync_seq` ownership
 *
 * In Postgres every row this plans gets `created_at`, `updated_at` and
 * `sync_seq` from the `set_row_metadata()` trigger
 * (`20260725101057_sync_seq_xid_fence.sql`,
 * `20260726192954_honor_client_created_at_on_insert.sql`) — `mcp_save_note`
 * itself sets none of them. The local store has no triggers, so the planner
 * mirrors what the local row must hold instead:
 *
 * - `created_at` = `updated_at` = {@link SaveNoteContext.now}. The trigger's
 *   INSERT branch is `coalesce(new.created_at, now())` / `now()`, and the
 *   planner supplies both from one instant so a batch is internally
 *   consistent.
 * - `sync_seq` = `null`, meaning "no server revision yet" — the local
 *   schemas' documented reading (see `syncSeq` in `index.ts`). A locally
 *   planned row has never been through a Postgres transaction, so it has no
 *   xid to carry, and Phase 4's flusher reads null as "must not exist on the
 *   server". Writing a fabricated number here would make the row look synced.
 * - `deleted_at` = `null`, `pinned_at`/`pinned_in` = `null`: the SQL names
 *   none of these columns either, so they take their Postgres defaults, all
 *   of which are null.
 *
 * Rows are emitted **complete** — every column of the canonical SQLite schema
 * is present — because `assertRowIsComplete` in the batch contract refuses a
 * row that omits a non-nullable column, and "absent is not a state".
 *
 * ## Faithful ports of things that look like bugs
 *
 * Four behaviours below are quirks of the SQL that a hand-port naturally
 * "corrects". Each is live behaviour that user data already depends on, so
 * each is reproduced deliberately and named in the conformance matrix:
 *
 * 1. **Folders match case-insensitively; tags match case-sensitively.**
 *    `lower(name) = lower(trim(p_folder))` for folders, plain `name = v_tag`
 *    for tags. So `#Work` and `#work` are two tags, while `Work` and `work`
 *    are one folder. (The MCP client lowercases tags before sending — see
 *    `normalizeTags` — but nothing at this layer relies on that, and the
 *    web app does not go through this path at all.)
 * 2. **Postgres `trim()` strips U+0020 only.** `trim(x)` is `btrim(x, ' ')`;
 *    JavaScript's `String.prototype.trim` strips every Unicode whitespace
 *    character, tabs and newlines included. A folder sent as `"\tWork\t"` is
 *    stored by Postgres with its tabs intact, so {@link pgTrimSpaces} is what
 *    this module uses for the folder lookup, the stored folder name and tags.
 *    The one exception is the reserved-name refusal, which follows the web's
 *    JavaScript `trim()` (so `"Trash\t"` is refused, as the web would read it
 *    as Trash), as the SQL has since
 *    `20260927220000_mcp_save_note_trash_spelling.sql` (#679).
 * 3. **The folder lookup compares `lower(name)`, not `lower(trim(name))`.**
 *    An existing folder stored as `" Work "` is not found by the input
 *    `"Work"`, and a second folder is created.
 * 4. **There is no update path.** The note insert carries no `ON CONFLICT`, so
 *    a `p_id` that already exists raises a unique violation and rolls the
 *    whole call back — including any folder or tag it had already created.
 *    The planner therefore always emits an `insert` for the note and lets the
 *    store's primary key enforce it, exactly as Postgres does; it needs no
 *    "existing note ids" input to do so. (In practice the id is fresh: the
 *    MCP client mints a new UUID per save.)
 *
 * ## Two SQL inputs this module's types make unreachable
 *
 * Both are NULL-propagation accidents in the SQL rather than designed
 * behaviour, and both are already refused before the RPC by `mcp-api`'s
 * argument validation. They are recorded here, and asserted on the Postgres
 * side of the conformance suite, so nobody "discovers" them later and ports
 * them:
 *
 * - **A NULL element in `p_tags`.** `trim(NULL)` is NULL, `length(NULL)` is
 *   NULL, and `continue when NULL` does not continue — so the loop falls
 *   through to `insert into tags (name) values (NULL)` and the not-null
 *   constraint rolls the entire call back. `SaveNoteInput['tags']` is
 *   `readonly string[]`, so the element cannot exist.
 * - **A NULL `p_source`.** `NULL not in ('mcp','cli')` is NULL, so the guard
 *   does not fire, and the note insert fails on `notes.source not null`
 *   instead. {@link SaveNoteInput.source} is optional, and omitting it means
 *   `'mcp'` — the SQL argument default, not NULL.
 *
 * ## Locale and encoding, where the two engines cannot be made identical
 *
 * `lower()` in Postgres follows the database collation; `toLowerCase()`
 * follows Unicode's full case mapping. They agree on ASCII, which is what the
 * folder comparison sees in practice, and are documented here rather than
 * papered over. Likewise `char_length` counts code points where JS `.length`
 * counts UTF-16 code units, so {@link selectTagVocabulary} spreads the string
 * before measuring it.
 */

/**
 * `p_source`. The SQL raises `invalid_source` for anything else; the type
 * makes that unreachable from TypeScript, and the runtime check below still
 * exists because the vendored copy is consumed from JavaScript too.
 */
export const SAVE_NOTE_SOURCES = ['mcp', 'cli'] as const;
export type SaveNoteSource = (typeof SAVE_NOTE_SOURCES)[number];

/**
 * The reserved folder name, refused in any case and with any padding
 * JavaScript's `trim()` strips: the web's rule for what Trash is, and the
 * SQL's. The folder lookup and the stored name still trim spaces only.
 */
export const RESERVED_FOLDER_NAME = 'trash';

/** The `tag_vocab` projection's row cap. */
export const TAG_VOCABULARY_LIMIT = 50;

/** The `tag_vocab` projection's per-name character bound (`char_length`). */
export const TAG_VOCABULARY_MAX_NAME_LENGTH = 40;

/**
 * Postgres `trim(x)` = `btrim(x, ' ')`: **spaces only**.
 *
 * Exported because the divergence it prevents is invisible at a call site —
 * anyone reaching for `.trim()` while porting more of this schema wants this
 * instead. See the module header, quirk 2.
 */
export function pgTrimSpaces(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 0x20) start += 1;
  while (end > start && value.charCodeAt(end - 1) === 0x20) end -= 1;
  return value.slice(start, end);
}

/** The columns of an existing `folders` row the folder lookup reads. */
export interface ExistingFolder {
  readonly id: string;
  readonly name: string;
  /** ISO-8601. Orders the `limit 1` when several live folders match. */
  readonly created_at: string;
  readonly deleted_at: string | null;
}

/** The columns of an existing `tags` row the tag lookup reads. */
export interface ExistingTag {
  readonly id: string;
  readonly name: string;
  readonly deleted_at: string | null;
}

/**
 * Everything the planner needs beyond the input: whose library this is, the
 * two lookups the SQL performs, and the id/timestamp sources it would
 * otherwise reach for ambiently.
 */
export interface SaveNoteContext {
  readonly userId: string;
  /**
   * The user's `folders` rows. Soft-deleted rows may be included — the
   * planner filters them, because the SQL's `deleted_at is null` predicate is
   * part of what is being ported.
   */
  readonly folders: readonly ExistingFolder[];
  /** The user's `tags` rows, soft-deleted ones included for the same reason. */
  readonly tags: readonly ExistingTag[];
  /** ISO-8601 timestamp for every row this call creates. */
  readonly now: string;
  /** Mints an id for each new folder/tag row, in emission order. */
  readonly newId: () => string;
}

export interface SaveNoteInput {
  /** Client-side UUID for the note. Never generated here. */
  readonly id: string;
  readonly title: string | null;
  readonly body: string | null;
  readonly tags?: readonly string[] | null;
  readonly folder?: string | null;
  /** Defaults to `'mcp'`, matching the SQL argument default. */
  readonly source?: SaveNoteSource;
}

export interface PlannedNoteRow {
  readonly id: string;
  readonly user_id: string;
  readonly title: string;
  readonly body: string;
  readonly folder_id: string | null;
  readonly source: SaveNoteSource;
  readonly pinned_at: null;
  readonly pinned_in: null;
  readonly sync_seq: null;
  readonly short_id: null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: null;
}

export interface PlannedFolderRow {
  readonly id: string;
  readonly user_id: string;
  readonly name: string;
  readonly parent_id: null;
  readonly sync_seq: null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: null;
}

export interface PlannedTagRow {
  readonly id: string;
  readonly user_id: string;
  readonly name: string;
  readonly sync_seq: null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: null;
}

export interface PlannedNoteTagRow {
  readonly note_id: string;
  readonly tag_id: string;
  readonly user_id: string;
  readonly sync_seq: null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: null;
}

/**
 * One row insert, in the order the SQL performs it.
 *
 * `ifExists: 'ignore'` marks the SQL's `on conflict do nothing`, which only
 * the `note_tags` insert carries. Every other op must fail on conflict —
 * that is how the no-update-path rule (quirk 4) is enforced.
 */
export type SaveNoteOp =
  | { readonly table: 'folders'; readonly op: 'insert'; readonly row: PlannedFolderRow }
  | { readonly table: 'tags'; readonly op: 'insert'; readonly row: PlannedTagRow }
  | { readonly table: 'notes'; readonly op: 'insert'; readonly row: PlannedNoteRow }
  | {
      readonly table: 'note_tags';
      readonly op: 'insert';
      readonly row: PlannedNoteTagRow;
      readonly ifExists: 'ignore';
    };

export interface SaveNotePlan {
  /**
   * The inserts, in SQL execution order: the folder (if one is created), the
   * note, then per accepted tag the tag row (if created) followed by its
   * link. Applying them in order, in one transaction, reproduces the RPC.
   */
  readonly ops: readonly SaveNoteOp[];
  /** The subset of the note the RPC returns to its caller. */
  readonly note: { readonly id: string; readonly title: string; readonly created_at: string };
  /** The resolved folder, existing or newly planned; null when none. */
  readonly folderId: string | null;
  /** Resolved tag ids, deduplicated, in first-appearance order. */
  readonly tagIds: readonly string[];
}

/** The SQL's `raise exception` messages, verbatim. */
export type SaveNotePlanErrorCode = 'invalid_source' | 'invalid_folder';

export class SaveNotePlanError extends Error {
  constructor(readonly code: SaveNotePlanErrorCode) {
    super(code);
    this.name = 'SaveNotePlanError';
  }
}

/**
 * Plans the row inserts `mcp_save_note` would perform, for a local store.
 *
 * Throws {@link SaveNotePlanError} where the SQL raises, with the same code.
 * Emits nothing and mutates nothing.
 */
export function planSaveNote(context: SaveNoteContext, input: SaveNoteInput): SaveNotePlan {
  const source = input.source ?? 'mcp';
  if (!(SAVE_NOTE_SOURCES as readonly string[]).includes(source)) {
    throw new SaveNotePlanError('invalid_source');
  }

  const folder = input.folder ?? null;
  if (folder !== null && folder.trim().toLowerCase() === RESERVED_FOLDER_NAME) {
    throw new SaveNotePlanError('invalid_folder');
  }

  const ops: SaveNoteOp[] = [];
  const { userId, now } = context;
  const stamps = { sync_seq: null, created_at: now, updated_at: now, deleted_at: null } as const;

  // --- Folder: get-or-create, case-insensitively, live rows only. ----------
  let folderId: string | null = null;
  if (folder !== null) {
    const wanted = pgTrimSpaces(folder);
    if (wanted.length > 0) {
      const existing = oldestLiveFolderMatching(context.folders, wanted);
      if (existing) {
        folderId = existing.id;
      } else {
        const row: PlannedFolderRow = {
          id: context.newId(),
          user_id: userId,
          name: wanted,
          parent_id: null,
          ...stamps,
        };
        folderId = row.id;
        ops.push({ table: 'folders', op: 'insert', row });
      }
    }
  }

  // --- Note: always an insert; title/body coalesced, never trimmed. --------
  const noteRow: PlannedNoteRow = {
    id: input.id,
    user_id: userId,
    title: input.title ?? '',
    body: input.body ?? '',
    folder_id: folderId,
    source,
    pinned_at: null,
    pinned_in: null,
    short_id: null,
    ...stamps,
  };
  ops.push({ table: 'notes', op: 'insert', row: noteRow });

  // --- Tags: in array order, each get-or-create then link. -----------------
  //
  // `live` starts as the caller's live tags and grows as the loop plans new
  // ones, because the SQL re-reads the table each iteration and therefore
  // sees rows the earlier iterations inserted. Without that, the same tag
  // named twice in one call would plan two rows and violate the partial
  // unique index on (user_id, name) where deleted_at is null.
  const live = new Map<string, string>();
  for (const tag of context.tags) {
    if (tag.deleted_at !== null) continue;
    if (!live.has(tag.name)) live.set(tag.name, tag.id);
  }

  const tagIds: string[] = [];
  const linked = new Set<string>();
  for (const raw of input.tags ?? []) {
    const name = pgTrimSpaces(raw);
    if (name.length === 0) continue; // `continue when length(v_tag) = 0`

    let tagId = live.get(name);
    if (tagId === undefined) {
      const row: PlannedTagRow = { id: context.newId(), user_id: userId, name, ...stamps };
      tagId = row.id;
      live.set(name, tagId);
      ops.push({ table: 'tags', op: 'insert', row });
    }
    if (!linked.has(tagId)) {
      linked.add(tagId);
      tagIds.push(tagId);
    }
    // Emitted even when the pair is already planned: `on conflict do nothing`
    // is what makes the duplicate harmless in Postgres, and the applier owes
    // the same. Keeping the op means the two op streams stay comparable.
    ops.push({
      table: 'note_tags',
      op: 'insert',
      row: { note_id: input.id, tag_id: tagId, user_id: userId, ...stamps },
      ifExists: 'ignore',
    });
  }

  return {
    ops,
    note: { id: noteRow.id, title: noteRow.title, created_at: noteRow.created_at },
    folderId,
    tagIds,
  };
}

/**
 * `select id from folders where user_id = ? and lower(name) = lower(trim(?))
 * and deleted_at is null order by created_at limit 1`.
 *
 * Note what is *not* here: no `trim` on the stored side (quirk 3), and no
 * `parent_id` predicate — a folder nested anywhere, including under Trash,
 * is eligible.
 *
 * The SQL's ordering is `created_at` alone, so two folders sharing an instant
 * make its choice arbitrary. Rather than inherit that, ties break on `id`;
 * the conformance fixtures never construct one, and its harness asserts as
 * much using {@link compareTimestamps} — the same granularity compared here,
 * so a fixture that started tying would fail loudly instead of coin-flipping.
 */
function oldestLiveFolderMatching(
  folders: readonly ExistingFolder[],
  wanted: string,
): ExistingFolder | null {
  const target = wanted.toLowerCase();
  let best: ExistingFolder | null = null;
  for (const folder of folders) {
    if (folder.deleted_at !== null) continue;
    if (folder.name.toLowerCase() !== target) continue;
    if (best === null || isOlder(folder, best)) best = folder;
  }
  return best;
}

function isOlder(candidate: ExistingFolder, incumbent: ExistingFolder): boolean {
  const order = compareTimestamps(candidate.created_at, incumbent.created_at);
  return order !== 0 ? order < 0 : candidate.id < incumbent.id;
}

/**
 * `-1 | 0 | 1` for two ISO-8601 timestamps, **exact to the nanosecond and
 * independent of how either one is spelled**.
 *
 * Neither of the obvious shortcuts is correct on the rows this compares.
 * `Date.parse` truncates to milliseconds, and Postgres timestamps carry
 * microseconds — two folders written 40µs apart would tie here, order fine on
 * the server, and get decided locally by a UUID comparison, which is a coin
 * flip that picks the wrong folder for the user's note. String comparison
 * fails differently: a local library legitimately holds **both** spellings of
 * the same instant, because rows the planner writes carry
 * `new Date().toISOString()` (`…T03:31:30.547Z`, always three fractional
 * digits) while rows the sync pull mirrors carry PostgREST's rendering
 * (`…T03:31:30.547365+00:00`, an offset and a variable number of digits). `'4'
 * < 'Z'` would make the *later* of those sort first.
 *
 * So the comparison is on a parsed `(epoch milliseconds, nanoseconds)` pair.
 * Exported because the conformance harness has to assert its fixtures at
 * exactly this granularity, and re-deriving the parse there would be a second
 * hand-port of the thing this module exists to have only one of.
 *
 * **Throws on an unparseable value** rather than ordering it arbitrarily. A
 * `created_at` that is not a timestamp cannot have come from either writer, so
 * it is a corrupted row or a caller passing the wrong column; the previous
 * `Date.parse` behaviour turned that into `NaN`, where every comparison is
 * false and the incumbent silently won. A wrong folder chosen in silence is
 * worse than a failed save that says why.
 */
export function compareTimestamps(a: string, b: string): number {
  const [aMillis, aNanos] = instant(a);
  const [bMillis, bNanos] = instant(b);
  if (aMillis !== bMillis) return aMillis < bMillis ? -1 : 1;
  if (aNanos !== bNanos) return aNanos < bNanos ? -1 : 1;
  return 0;
}

/**
 * Both spellings, plus Postgres' space-separated form: an optional fractional
 * part of any length and an offset of `Z`, `+HH:MM` or `+HHMM`. An offset is
 * required — a bare local timestamp has no instant to compare.
 */
const ISO_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|z|[+-]\d{2}:?\d{2})$/;

/** Whole milliseconds since the epoch, and the sub-second part in nanoseconds. */
function instant(value: string): [number, number] {
  const match = ISO_TIMESTAMP.exec(value);
  if (match === null) {
    throw new Error(`save-note: not an ISO-8601 timestamp: ${JSON.stringify(value)}`);
  }
  // Every group is non-optional in the pattern except the fraction, but
  // `noUncheckedIndexedAccess` cannot see that, and a default is cheaper than
  // asserting.
  const [, date = '', time = '', fraction = '', offset = ''] = match;
  // Parsed without the fraction, so the result is a whole number of seconds
  // and carries no float rounding; the fraction is compared separately at full
  // precision. The offset is normalized because `Date.parse` accepts
  // `+HH:MM` but not reliably `+HHMM`.
  const withColon = offset.length === 5 ? `${offset.slice(0, 3)}:${offset.slice(3)}` : offset;
  const millis = Date.parse(`${date}T${time}${withColon === 'z' ? 'Z' : withColon}`);
  if (!Number.isFinite(millis)) {
    throw new Error(`save-note: not a valid timestamp: ${JSON.stringify(value)}`);
  }
  return [millis, Number(`${fraction}000000000`.slice(0, 9))];
}

/**
 * A `note_tags` row, as {@link selectTagVocabulary} reads it.
 *
 * `user_id` is absent on purpose — see the scoping precondition on
 * {@link selectTagVocabulary}. It is the caller's to enforce, and a field here
 * would suggest this function checks it.
 */
export interface TagVocabularyLink {
  readonly tag_id: string;
  readonly deleted_at: string | null;
}

/**
 * The RPC's `tag_vocab` projection: the user's live tag names, most-linked
 * first, capped at {@link TAG_VOCABULARY_LIMIT}.
 *
 * A *read*, not a row op — kept beside the planner because it is part of the
 * same RPC's contract and the CLI reuses the answer to spell later tags in
 * one session consistently (`normalizeTags`' `vocabulary` argument).
 *
 * **Feed it post-apply state.** The SQL builds `tag_vocab` in its return
 * expression, after every insert above it has landed, so a tag the same call
 * created appears in the vocabulary with its new link already counted. A
 * caller that computes the vocabulary from the state it planned *against*
 * ships a stale answer.
 *
 * **Both collections must already be scoped to one user.** The SQL carries the
 * owner in its predicates — `t.user_id = v_user_id` on the tags, and
 * `nt.user_id = v_user_id` on the join, so a link belonging to someone else
 * cannot inflate a count. This function has no user to compare against and
 * counts whatever it is handed, exactly like {@link SaveNoteContext}'s
 * `folders` and `tags`. Passing an unfiltered table is a cross-tenant read,
 * not a wrong sort order.
 *
 * Faithful details: link counts include every live link, deliberately
 * unscoped by tidy eligibility; names longer than
 * {@link TAG_VOCABULARY_MAX_NAME_LENGTH} **code points** are excluded; a tag
 * with no live links counts 0 rather than dropping out (the SQL's LEFT JOIN).
 *
 * **Ordering caveat.** The SQL's tiebreak is `order by ... t.name, t.id`,
 * evaluated under the database collation; this compares by code point.
 * They agree on same-case ASCII and can disagree otherwise — the conformance
 * suite asserts the ordering only over fixtures where they cannot differ,
 * and asserts membership everywhere else.
 */
export function selectTagVocabulary(input: {
  readonly tags: readonly ExistingTag[];
  readonly noteTags: readonly TagVocabularyLink[];
}): string[] {
  const counts = new Map<string, number>();
  for (const link of input.noteTags) {
    if (link.deleted_at !== null) continue;
    counts.set(link.tag_id, (counts.get(link.tag_id) ?? 0) + 1);
  }

  return input.tags
    .filter(
      (tag) => tag.deleted_at === null && [...tag.name].length <= TAG_VOCABULARY_MAX_NAME_LENGTH,
    )
    .map((tag) => ({ tag, count: counts.get(tag.id) ?? 0 }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        (a.tag.name < b.tag.name ? -1 : a.tag.name > b.tag.name ? 1 : 0) ||
        (a.tag.id < b.tag.id ? -1 : a.tag.id > b.tag.id ? 1 : 0),
    )
    .slice(0, TAG_VOCABULARY_LIMIT)
    .map((entry) => entry.tag.name);
}
