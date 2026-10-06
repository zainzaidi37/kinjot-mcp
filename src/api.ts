import type { z } from 'zod';
import { wireSchemas } from './wire.js';
import type { Config } from './config.js';
import { normalizeTags } from './tagging.js';
import { parseNoteLabel } from './core/note-label.js';
import { isUuidShapeAnyCase } from './uuid.js';
import type { ApiKeyAccess } from './core/index.js';
import { sanitizeImageForUpload } from './core/index.js';
import { cleanImageAlt, putGrantedImage, readImageFile } from './image-upload.js';

export const KEY_INFO_DEADLINE_MS = 1_500;

// Thin client for the mcp-api Edge Function. Note ids are generated here by
// default — UUIDs are client-generated throughout kinjot.

// Listings (search and recent) are deliberately compact: no bodies. A body
// only enters the caller's context when it explicitly fetches one note via
// getNote.
export interface SearchHit {
  id: string;
  short_id?: number | null;
  title: string;
  tags: string[];
  updated_at: string;
  // Populated for search_notes and list_recent_notes results, and only when
  // the caller is on the Pro plan (the mcp_* RPCs gate it server-side on the
  // current plan, not on embedding-row presence).
  gist?: string | null;
}

export interface SearchResult {
  notes: SearchHit[];
  total: number;
}

export interface FullNote {
  id: string;
  short_id?: number | null;
  title: string;
  body: string;
  folder_id: string | null;
  source: string;
  created_at: string;
  updated_at: string;
  tags: string[];
}

// Semantic retrieval candidates: compact like SearchHit, plus the one-line
// gist written at embed time and the cosine similarity for calibration.
export interface RecallMatch {
  id: string;
  short_id?: number | null;
  title: string;
  gist: string | null;
  similarity: number;
}

export interface SaveNoteInput {
  id?: string;
  title: string;
  body: string;
  tags?: string[];
  folder?: string;
  source?: 'mcp' | 'cli';
  vocabulary?: string[];
}

export interface SavedNote {
  aiExcluded?: boolean;
  id: string;
  title: string;
  created_at: string;
  tags: string[];
  existingTags?: string[];
}

export interface EditNoteInput {
  id: string;
  old_string?: string;
  new_string?: string;
  title?: string;
  add_tags?: string[];
  remove_tags?: string[];
  folder?: string;
  source?: 'mcp' | 'cli';
  vocabulary?: string[];
}

export interface AppendNoteInput {
  id: string;
  text: string;
  snapshot?: false;
  source?: 'mcp' | 'cli';
}

export interface EditedNote {
  aiExcluded?: boolean;
  id: string;
  short_id?: number | null;
  title: string;
  updated_at: string;
  snapshot_skipped?: boolean;
}

export interface UploadImageInput {
  path: string;
  alt?: string;
}

export interface UploadedImage {
  markdown: string;
  url: string;
  path: string;
  bytes: number;
  width: number;
  height: number;
}

export type InboxKind = 'question' | 'blocker' | 'handoff' | 'done' | 'waiting';
export interface InboxContext {
  agent?: string;
  repo?: string;
  branch?: string;
  prs?: string[];
  note?: string;
  session_id?: string;
}
export interface InboxNotifyInput {
  id?: string;
  kind: InboxKind;
  title: string;
  detail?: string;
  context?: InboxContext;
  source?: 'mcp' | 'cli';
}
export type InboxNotifyResult = z.infer<typeof wireSchemas.inbox_notify>;
export type InboxMuteState = z.infer<typeof wireSchemas.inbox_mute_state>;
export type InboxListResult = z.infer<typeof wireSchemas.inbox_list>;
export interface InboxListInput {
  repo?: string;
  kinds?: Exclude<InboxKind, 'waiting'>[];
  limit?: number;
}
export interface InboxResolveInput {
  ref: string;
  resolution?: string;
}
export type InboxResolveResult = z.infer<typeof wireSchemas.inbox_resolve>;

const API_ERROR_KINDS = [
  'unsupported_action',
  'key_access',
  'inbox_rate_limited',
  'inbox_access_off',
  'inbox_item_not_found',
  'inbox_ambiguous_id',
  'id_conflict',
  'invalid_id',
  'invalid_kind',
  'invalid_source',
  'invalid_context',
  'invalid_title',
  'invalid_session',
  'invalid_request',
  'invalid_key',
  'rate_limited',
] as const;
export type ApiErrorKind = (typeof API_ERROR_KINDS)[number];

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly kind?: ApiErrorKind,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class NotesApi {
  constructor(
    private readonly config: Config,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly options: { deadlineMs?: number } = {},
  ) {}

  async keyInfo(deadlineMs?: number): Promise<ApiKeyAccess> {
    const result = await this.call('key_info', wireSchemas.key_info, {}, deadlineMs);
    return result.access;
  }

  async uploadImage(input: UploadImageInput): Promise<UploadedImage> {
    const file = await readImageFile(input.path);
    const sanitized = sanitizeImageForUpload(file.bytes);
    if (!sanitized.ok) throw new Error(sanitized.message);
    let grant;
    try {
      grant = await this.call('image_upload', wireSchemas.image_upload, {
        ext: sanitized.ext,
        bytes: sanitized.bytes.byteLength,
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 400 && error.message === 'unknown action') {
        throw new ApiError(
          400,
          'this Kinjot server does not support image uploads yet; on a self-hosted deployment, run update',
          'unsupported_action',
        );
      }
      throw error;
    }
    await putGrantedImage(grant, sanitized.bytes, this.fetchImpl);
    const url = grant.publicUrl;
    return {
      markdown: `![${cleanImageAlt(input.alt)}](${url})`,
      url,
      path: file.path,
      bytes: sanitized.bytes.byteLength,
      width: sanitized.width,
      height: sanitized.height,
    };
  }

  async inboxNotify(input: InboxNotifyInput): Promise<InboxNotifyResult> {
    try {
      return await this.call('inbox_notify', wireSchemas.inbox_notify, {
        id: input.id ?? crypto.randomUUID(),
        kind: input.kind,
        title: input.title,
        detail: input.detail,
        context: input.context,
        source: input.source ?? 'mcp',
      });
    } catch (error) {
      throw this.inboxError(error);
    }
  }

  async inboxMuteState(): Promise<InboxMuteState> {
    try {
      return await this.call('inbox_mute_state', wireSchemas.inbox_mute_state, {});
    } catch (error) {
      throw this.inboxError(
        error,
        'This Kinjot deployment does not support this Inbox action yet; its operator needs to update it.',
      );
    }
  }

  async inboxList(input: InboxListInput): Promise<InboxListResult> {
    try {
      return await this.call('inbox_list', wireSchemas.inbox_list, { ...input });
    } catch (error) {
      throw this.inboxError(error);
    }
  }

  async inboxResolve(input: InboxResolveInput): Promise<InboxResolveResult> {
    try {
      return await this.call('inbox_resolve', wireSchemas.inbox_resolve, { ...input });
    } catch (error) {
      throw this.inboxError(error);
    }
  }

  private inboxError(
    error: unknown,
    unavailableMessage = 'This Kinjot deployment does not have the Inbox yet; its operator needs to update it.',
  ): unknown {
    return error instanceof ApiError && error.status === 400 && error.message === 'unknown action'
      ? new ApiError(400, unavailableMessage, 'unsupported_action')
      : error;
  }

  async saveNote(input: SaveNoteInput): Promise<SavedNote & { aiExcluded: boolean }> {
    if (input.id !== undefined && !isUuidShapeAnyCase(input.id)) {
      throw new Error('note id must be a UUID in 8-4-4-4-12 hexadecimal form');
    }
    const tags = input.tags ? normalizeTags(input.tags, input.vocabulary) : [];
    const response = await this.call('save_note', wireSchemas.save_note, {
      id: input.id?.toLowerCase() ?? crypto.randomUUID(),
      title: input.title,
      body: input.body,
      // Normalized here, the single choke point, so the CLI and the MCP
      // tool can't disagree on tag hygiene.
      tags: input.tags ? tags : undefined,
      folder: input.folder,
      source: input.source ?? 'mcp',
    });
    return {
      ...response.note,
      tags,
      existingTags: response.existing_tags,
      aiExcluded: response.ai_excluded === true,
    };
  }

  async listRecentNotes(limit = 10): Promise<SearchHit[]> {
    const result = await this.call('list_recent_notes', wireSchemas.list_recent_notes, { limit });
    return result.notes;
  }

  async searchNotes(query: string): Promise<SearchResult> {
    return await this.call('search_notes', wireSchemas.search_notes, { query });
  }

  async recallNotes(query: string): Promise<RecallMatch[]> {
    const result = await this.call('recall', wireSchemas.recall, { query });
    return result.matches;
  }

  async getNote(input: string): Promise<FullNote> {
    const shortId = parseNoteLabel(input.trim());
    try {
      const result = await this.call(
        'get_note',
        wireSchemas.get_note,
        shortId === null ? { id: input } : { short_id: shortId },
      );
      return result.note;
    } catch (error) {
      if (shortId !== null && error instanceof ApiError && error.status === 400) {
        throw new ApiError(
          400,
          'This Kinjot backend does not support short ids yet; use the 8-character id prefix instead.',
        );
      }
      throw error;
    }
  }

  async editNote(input: EditNoteInput): Promise<EditedNote & { aiExcluded: boolean }> {
    const shortId = parseNoteLabel(input.id.trim());
    const reference = shortId === null ? { id: input.id } : { short_id: shortId };
    try {
      const result = await this.call('edit_note', wireSchemas.edit_note, {
        ...reference,
        old_string: input.old_string,
        new_string: input.new_string,
        title: input.title,
        add_tags: input.add_tags ? normalizeTags(input.add_tags, input.vocabulary) : undefined,
        remove_tags: input.remove_tags?.map((tag) => tag.trim().replace(/^#+/, '').toLowerCase()),
        folder: input.folder,
        source: input.source ?? 'mcp',
      });
      return { ...result.note, aiExcluded: result.ai_excluded === true };
    } catch (error) {
      throw this.agentEditError(error);
    }
  }

  async appendNote(input: AppendNoteInput): Promise<EditedNote> {
    const shortId = parseNoteLabel(input.id.trim());
    try {
      const result = await this.call('append_note', wireSchemas.append_note, {
        ...(shortId === null ? { id: input.id } : { short_id: shortId }),
        text: input.text,
        snapshot: input.snapshot,
        source: input.source ?? 'mcp',
      });
      return result.snapshot_skipped === true
        ? { ...result.note, snapshot_skipped: true }
        : result.note;
    } catch (error) {
      throw this.agentEditError(error);
    }
  }

  private agentEditError(error: unknown): unknown {
    if (!(error instanceof ApiError)) return error;
    if (error.status === 400 && error.message === 'unknown action') {
      return new ApiError(
        400,
        'This Kinjot backend does not support agent edits yet; update the deployment.',
        'unsupported_action',
      );
    }
    if (error.status === 409 && error.message.includes('old_string must match exactly')) {
      return new ApiError(
        409,
        'Re-read the note with get_jot and choose an anchor that matches exactly, including whitespace and line endings, and occurs exactly once.',
      );
    }
    if (error.status === 409 && error.message.includes('old_string occurs more than once')) {
      return new ApiError(
        409,
        'Re-read the note with get_jot and choose a longer anchor that occurs exactly once.',
      );
    }
    return error;
  }

  private async call<T>(
    action: string,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    params: Record<string, unknown>,
    deadlineMs = this.options.deadlineMs ?? 30_000,
  ): Promise<T> {
    const controller = new AbortController();
    const signal = controller.signal;
    const timeoutError = () => new ApiError(0, `request to ${this.config.apiUrl} timed out`);
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    let onAbort: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(timeoutError());
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const operation = async (): Promise<T> => {
      let response: Response;
      try {
        response = await this.fetchImpl(this.config.apiUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify({ action, ...params }),
          signal,
        });
      } catch (cause) {
        if (signal.aborted) throw timeoutError();
        throw new ApiError(0, `could not reach ${this.config.apiUrl}: ${(cause as Error).message}`);
      }

      const body = (await response.json().catch(() => null)) as {
        error?: string;
        code?: string;
      } | null;
      if (signal.aborted) throw timeoutError();
      if (!response.ok) {
        const knownKind =
          typeof body?.code === 'string'
            ? API_ERROR_KINDS.find((kind) => kind === body.code)
            : undefined;
        if (response.status === 401) {
          throw new ApiError(
            401,
            'API key was rejected — it may have been revoked. Create a new one in Settings → API keys.',
            knownKind,
          );
        }
        if (typeof body?.code === 'string') {
          throw new ApiError(
            response.status,
            typeof body.error === 'string'
              ? body.error
              : response.status === 429
                ? 'rate limit hit (60 writes/min per key); wait a minute and retry.'
                : `request failed with ${response.status}`,
            knownKind,
          );
        }
        if (response.status === 429) {
          throw new ApiError(
            429,
            'rate limit hit (60 writes/min per key); wait a minute and retry.',
          );
        }
        throw new ApiError(
          response.status,
          body?.error ?? `request failed with ${response.status}`,
          response.status === 403 && body?.code === 'key_access' ? 'key_access' : undefined,
        );
      }
      const invalidReply = (detail: string) =>
        new ApiError(
          response.status,
          action === 'image_upload'
            ? 'The server offered an unsafe upload grant.'
            : `${this.config.apiUrl} answered ${action}: ${detail}. Please update the CLI (npm i -g kinjot) or, on a self-hosted deployment, update the backend.`,
        );
      if (body === null) throw invalidReply('no JSON response this version of Kinjot understands');
      const parsed = schema.safeParse(body);
      if (!parsed.success)
        throw invalidReply('a response this version of Kinjot does not understand');
      return parsed.data;
    };
    try {
      return await Promise.race([operation(), aborted]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort!);
    }
  }
}
