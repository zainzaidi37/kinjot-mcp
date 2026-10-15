// @generated — DO NOT EDIT.
//
// Vendored copy of packages/core/src/note-label.ts, emitted by
// `pnpm --filter @kinjot/core emit:mcp-core` (plans/desktop-app.md §4.5).
// Edit the source module and re-run; CI fails on any difference.

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

// A label is at most four characters (A10..Z999)
// (`plans/agent-edits-and-short-ids-2026-09-23.md` D17), and a note numbered past the
// cap has no label. With the prefix floor at 8, a 3- or 4-character id is a
// label or invalid, 5 to 7 characters are invalid, and 8 or more is a prefix or
// a UUID, so a label can never shadow a prefix.
export const NOTE_LABEL_MAX_CHARS = 4;
const MAX_SHORT_ID = Array.from(
  { length: NOTE_LABEL_MAX_CHARS - 2 },
  (_, index) => ALPHABET.length * 9 * 10 ** (index + 1),
).reduce((sum, block) => sum + block, 0);
export const NOTE_LABEL_PATTERN = new RegExp(
  `^([A-HJ-NP-Z])([1-9][0-9]{1,${NOTE_LABEL_MAX_CHARS - 2}})$`,
  'i',
);

export function noteLabel(shortId: number): string | null {
  if (!Number.isSafeInteger(shortId) || shortId < 1) {
    throw new RangeError('short_id must be a positive safe integer');
  }
  if (shortId > MAX_SHORT_ID) return null;
  let index = shortId - 1;
  for (let digits = 2; digits <= NOTE_LABEL_MAX_CHARS - 1; digits += 1) {
    const first = 10 ** (digits - 1);
    const perLetter = 9 * first;
    const block = ALPHABET.length * perLetter;
    if (index < block) {
      return `${ALPHABET[Math.floor(index / perLetter)]}${first + (index % perLetter)}`;
    }
    index -= block;
  }
  return null;
}

export function parseNoteLabel(value: string): number | null {
  const bare = value.startsWith('#') ? value.slice(1) : value;
  if (bare.length < 3 || bare.length > NOTE_LABEL_MAX_CHARS) return null;
  const match = NOTE_LABEL_PATTERN.exec(bare);
  if (!match) return null;
  const letter = ALPHABET.indexOf(match[1]!.toUpperCase());
  if (letter < 0) return null;
  const number = Number(match[2]);
  const digits = match[2]!.length;
  const first = 10 ** (digits - 1);
  let offset = 0;
  for (let d = 2; d < digits; d += 1) offset += ALPHABET.length * 9 * 10 ** (d - 1);
  const shortId = offset + letter * 9 * first + number - first + 1;
  return shortId <= MAX_SHORT_ID ? shortId : null;
}
