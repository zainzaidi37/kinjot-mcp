// @generated — DO NOT EDIT.
//
// Vendored copy of packages/core/src/ai-exclusion.ts, emitted by
// `pnpm --filter @kinjot/core emit:mcp-core` (plans/desktop-app.md §4.5).
// Edit the source module and re-run; CI fails on any difference.

import type { Folder, Note } from './index.js';
import { RESERVED_FOLDER_NAME } from './save-note.js';

type AiFolder = Pick<Folder, 'id' | 'parent_id' | 'name' | 'deleted_at' | 'ai_excluded_at'> &
  Partial<Pick<Folder, 'created_at'>>;
type AiNote = Pick<Note, 'deleted_at' | 'folder_id' | 'trashed_from_folder_id'>;

// A row pulled from a backend one release behind lacks `ai_excluded_at` and
// `trashed_from_folder_id`; a missing key reads as null (not excluded), never
// as a mark, or every note on that backend would read as excluded.

/**
 * The exclusion set over whatever folders are given, live or dead. The server
 * also seeds from dead No AI folders. Client callers (listFolders/app.folders)
 * pass live folders and rely on P1b's server cascade: a dead No AI folder's
 * notes go to Trash marked, and its children keep the flag. Move callers pass
 * tombstones deliberately to predict writes targeting a dead excluded folder.
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

/** The Trash identity used by the exclusion and write rules. */
export function isAiTrashFolder(folder: AiFolder): boolean {
  return (
    folder.deleted_at === null &&
    folder.parent_id === null &&
    folder.name.trim().toLowerCase() === RESERVED_FOLDER_NAME
  );
}

/** Predict the server's mark and redirect over a cached folder snapshot. */
export function noteAiMove(
  note: AiNote,
  folderId: string | null,
  folders: readonly AiFolder[],
  excludedIds: ReadonlySet<string> = aiExcludedFolderIds(folders),
): Pick<Note, 'folder_id' | 'trashed_from_folder_id'> {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const target = folderId === null ? undefined : byId.get(folderId);
  const toTrash = target !== undefined && isAiTrashFolder(target);
  let mark = note.trashed_from_folder_id ?? null;
  if (folderId !== note.folder_id && mark !== null && !toTrash) {
    const home = byId.get(mark);
    if (home && home.deleted_at === null && excludedIds.has(home.id)) folderId = home.id;
    mark = null;
  }
  const landing = folderId === null ? undefined : byId.get(folderId);
  if (landing?.deleted_at != null) {
    if (excludedIds.has(landing.id)) {
      folderId = folders.find(isAiTrashFolder)?.id ?? null;
      mark = landing.id;
    } else folderId = null;
  }
  const source = note.folder_id === null ? undefined : byId.get(note.folder_id);
  if (
    folderId !== note.folder_id &&
    toTrash &&
    source &&
    !isAiTrashFolder(source) &&
    excludedIds.has(source.id)
  )
    mark = source.id;
  return { folder_id: folderId, trashed_from_folder_id: mark };
}

export type AiEligibilityMove =
  | { kind: 'notes'; noteIds: readonly string[]; folderId: string | null }
  | { kind: 'folder'; folderId: string; parentId: string | null }
  | { kind: 'merge'; sourceId: string; targetId: string };

/** Notes a proposed gesture would release to agents/providers (D6). Pure and bounded by input size. */
export function notesBecomingAiEligible<T extends AiNote & { id: string }>(
  folders: readonly AiFolder[],
  notes: readonly T[],
  move: AiEligibilityMove,
): T[] {
  const before = aiExcludedFolderIds(folders);
  const afterFolders = folders.map((folder) => ({ ...folder }));
  const destinations = new Map<string, string>();
  if (move.kind === 'folder') {
    const folder = afterFolders.find((folder) => folder.id === move.folderId);
    if (folder) folder.parent_id = move.parentId;
  } else if (move.kind === 'merge') {
    // Match the repo merge: roots adopt unmatched children; a nested target flattens.
    const byId = new Map(
      afterFolders
        .filter((folder) => folder.deleted_at === null)
        .map((folder) => [folder.id, folder]),
    );
    const pending = [[move.sourceId, move.targetId]];
    for (let i = 0; i < pending.length; i += 1) {
      const [sourceId, targetId] = pending[i]!;
      const source = byId.get(sourceId!);
      const target = byId.get(targetId!);
      if (!source || !target || destinations.has(source.id) || source.id === target.id) continue;
      destinations.set(source.id, target.id);
      const children = afterFolders.filter(
        (folder) => folder.parent_id === source.id && folder.deleted_at === null,
      );
      for (const child of children) {
        if (target.parent_id !== null) pending.push([child.id, target.id]);
        else {
          const match = [...afterFolders]
            .sort(
              (a, b) =>
                (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.id.localeCompare(b.id),
            )
            .find(
              (folder) =>
                folder.parent_id === target.id &&
                folder.deleted_at === null &&
                folder.name.trim().toLowerCase() === child.name.trim().toLowerCase(),
            );
          if (match) pending.push([child.id, match.id]);
          else child.parent_id = target.id;
        }
      }
      // Removed folders cannot continue seeding exclusion in this prediction.
      source.ai_excluded_at = null;
      source.parent_id = null;
      source.deleted_at = 'deleted';
    }
  }
  const after = aiExcludedFolderIds(afterFolders);
  const selected = move.kind === 'notes' ? new Set(move.noteIds) : null;
  return notes.filter((note) => {
    if (!isNoteAiExcluded(note, before)) return false;
    let predicted: AiNote = note;
    if (move.kind === 'notes' && selected!.has(note.id))
      predicted = { ...note, ...noteAiMove(note, move.folderId, folders, before) };
    else if (move.kind === 'merge' && note.folder_id !== null && destinations.has(note.folder_id)) {
      predicted = {
        ...note,
        ...noteAiMove(note, destinations.get(note.folder_id)!, folders, before),
      };
    }
    if (
      move.kind === 'merge' &&
      predicted.folder_id !== null &&
      destinations.has(predicted.folder_id)
    ) {
      // A redirect can put a marked note back into a doomed excluded home.
      // The subsequent folder delete trashes and marks it; it never becomes readable.
      predicted = { ...predicted, trashed_from_folder_id: predicted.folder_id };
    }
    return !isNoteAiExcluded(predicted, after);
  });
}
