// @generated — DO NOT EDIT.
//
// Vendored copy of packages/core/src/ai-exclusion.ts, emitted by
// `pnpm --filter @kinjot/core emit:mcp-core` (plans/desktop-app.md §4.5).
// Edit the source module and re-run; CI fails on any difference.

import type { Folder, Note } from './index.js';
import { RESERVED_FOLDER_NAME } from './save-note.js';

type AiFolder = Pick<Folder, 'id' | 'parent_id' | 'name' | 'deleted_at' | 'ai_excluded_at'>;
type AiNote = Pick<Note, 'deleted_at' | 'folder_id' | 'trashed_from_folder_id'>;

// A row pulled from a backend one release behind lacks `ai_excluded_at` and
// `trashed_from_folder_id`; a missing key reads as null (not excluded), never
// as a mark, or every note on that backend would read as excluded.

/**
 * The exclusion set over whatever folders are given, live or dead. The server
 * also seeds from dead No AI folders. Client callers (listFolders/app.folders)
 * pass live folders and rely on P1b's server cascade: a dead No AI folder's
 * notes go to Trash marked, and its children keep the flag.
 */
export function aiExcludedFolderIds(folders: readonly AiFolder[]): Set<string> {
  const children = new Map<string, string[]>();
  const pending: string[] = [];
  for (const folder of folders) {
    if (folder.parent_id !== null) {
      const siblings = children.get(folder.parent_id) ?? [];
      siblings.push(folder.id);
      children.set(folder.parent_id, siblings);
    }
    if (
      (folder.ai_excluded_at ?? null) !== null ||
      (folder.deleted_at === null &&
        folder.parent_id === null &&
        folder.name.trim().toLowerCase() === RESERVED_FOLDER_NAME)
    ) {
      pending.push(folder.id);
    }
  }
  const excluded = new Set<string>();
  for (let index = 0; index < pending.length; index += 1) {
    const id = pending[index]!;
    if (excluded.has(id)) continue;
    excluded.add(id);
    for (const child of children.get(id) ?? []) pending.push(child);
  }
  return excluded;
}

export function isNoteAiExcluded(note: AiNote, excludedIds: ReadonlySet<string>): boolean {
  return (
    note.deleted_at !== null ||
    (note.folder_id !== null && excludedIds.has(note.folder_id)) ||
    (note.trashed_from_folder_id ?? null) !== null
  );
}

/** The nearest explicit mark; Trash alone is not a No AI ancestor. */
export function noAiAncestor<T extends AiFolder>(
  folderId: string | null,
  folders: readonly T[],
): T | null {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const visited = new Set<string>();
  let id = folderId;
  while (id !== null && !visited.has(id)) {
    visited.add(id);
    const folder = byId.get(id);
    if (!folder) return null;
    if ((folder.ai_excluded_at ?? null) !== null) return folder;
    id = folder.parent_id;
  }
  return null;
}
