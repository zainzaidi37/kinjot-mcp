import { noteLabel } from './core/note-label.js';

/**
 * The note's label (`A10`), or `null` when it has none: a backend one release
 * behind sends no `short_id`, a local or not-yet-flushed note has `null`, and a
 * note numbered past `Z999` has no label (D17). The wire schemas already refuse
 * a non-integer; `noteLabel` also throws on zero or a negative number, which
 * this reads as "no label" rather than an error.
 */
export function noteLabelOf(note: { short_id?: number | null }): string | null {
  const shortId = note.short_id;
  if (typeof shortId !== 'number' || !Number.isSafeInteger(shortId) || shortId < 1) return null;
  return noteLabel(shortId);
}

/** The reference a listing leads with: the label, else the 8-character id prefix. */
export function noteHandle(note: { id: string; short_id?: number | null }): string {
  return noteLabelOf(note) ?? note.id.slice(0, 8);
}
