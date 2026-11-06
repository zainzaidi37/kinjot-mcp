// @generated — DO NOT EDIT.
//
// Vendored copy of packages/core/src/capture-text.ts, emitted by
// `pnpm --filter @kinjot/core emit:mcp-core` (plans/desktop-app.md §4.5).
// Edit the source module and re-run; CI fails on any difference.

/**
 * Text helpers for a capture that becomes one or more notes: the browser
 * extension's finish step (`plans/browser-extension-2026-11-03.md` §5.5).
 *
 * The piece limit and the `(continued)` title follow `saveWholeSession` in
 * `integrations/shared/capture-support.mjs`: 100,000 characters (its
 * `NOTE_LIMIT`), pieces packed greedily, the boundary separator dropped at a
 * cut, and every piece after the first titled `<title> (continued)`. Their
 * pieces agree only where each plugin entry is one paragraph and none is
 * over the limit: the plugins cut at entries, and hard-cut an oversize one.
 */

/** The plugins' `NOTE_LIMIT`, in UTF-16 code units (`String.length`). */
export const CAPTURE_PIECE_LIMIT = 100_000;

/**
 * The longest title {@link cleanTitle} and {@link continuedTitle} return.
 * `mcp-api`'s `save_note` takes any length, but `public.note_search_index`
 * cuts a title over 1,000 characters, Kin chat's `ChatRewritePayloadSchema`
 * caps a title at 500, and the bounded note reads
 * (`supabase/migrations/20261029033047_bounded_note_reads.sql`) take its first
 * 500 for embeddings and Related.
 */
export const CAPTURE_TITLE_MAX_CHARS = 500;

/**
 * A fence line, by the plugins' `proseLines` rule. The plugins split on
 * `/\r?\n/`; this module splits on `\n` so a piece keeps the text's bytes, and
 * allows the line's own `\r` here instead. The lookahead and backreference
 * make the marker run atomic, so no shorter run is retried: matching stays
 * linear in the line, however a page shapes it. Read it through
 * `fenceMarker`, never directly.
 */
const FENCE = /^\s{0,3}(?=(`{3,}|~{3,}))\1(.*)\r?$/;

/**
 * `line`'s fence marker run and info string, or null when it is no fence line.
 * A backtick fence's info string cannot contain a backtick (CommonMark 0.31
 * §4.5), checked here rather than in `FENCE`, where a lookahead would
 * backtrack.
 */
function fenceMarker(line: string): RegExpExecArray | null {
  const marker = FENCE.exec(line);
  return marker && !(marker[1]![0] === '`' && marker[2]!.includes('`')) ? marker : null;
}

type Atom = {
  sep: string;
  text: string;
  /** Starts a new piece even when it would fit after the current one. */
  fresh?: boolean;
  refine?: () => Atom[];
};

/** Whether `line` closes a fence opened by the marker run `fence`. */
function closesFence(line: string, fence: string): boolean {
  const marker = fenceMarker(line);
  return (
    !!marker &&
    marker[1]![0] === fence[0] &&
    marker[1]!.length >= fence.length &&
    !marker[2]!.trim()
  );
}

/** Fence-aware: groups each fenced block's lines, opening to closing, into one entry. */
function lineGroups(lines: string[]): string[][] {
  const groups: string[][] = [];
  let fence: string | undefined;
  for (const line of lines) {
    if (fence !== undefined) {
      groups[groups.length - 1]!.push(line);
      if (closesFence(line, fence)) fence = undefined;
      continue;
    }
    groups.push([line]);
    fence = fenceMarker(line)?.[1];
  }
  return groups;
}

/** Cuts of at most `limit` (at least 2, so a surrogate pair always fits) code units. */
function hardCuts(text: string, limit: number): Atom[] {
  const atoms: Atom[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + limit, text.length);
    // Never split a surrogate pair: mcp-api refuses malformed Unicode.
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    atoms.push({ sep: '', text: text.slice(start, end) });
    start = end;
  }
  return atoms;
}

function lineAtoms(lines: string[], limit: number): Atom[] {
  return lines.map((line) => ({ sep: '\n', text: line, refine: () => hardCuts(line, limit) }));
}

/**
 * An oversize fenced block cut into pieces that each render as code: every
 * piece but the last ends with a closing fence (the opener's marker run), and
 * every piece but the first starts with the opener line, info string
 * included. Both lines count against `limit`; the code lines stay verbatim,
 * and a code line longer than a piece's room is hard-cut. Undefined, and the
 * block is then cut as plain lines, when the opener and a closing fence leave
 * less than half of `limit` for code: each piece repeats the opener, so this
 * keeps the output under three times the block (a piece's room can be half
 * unused when its next line does not fit), whatever info string a page gives.
 */
function fencePieces(group: string[], limit: number): Atom[] | undefined {
  const opener = group[0]!;
  const run = fenceMarker(opener)![1]!;
  const closed = group.length > 1 && closesFence(group.at(-1)!, run);
  const closer = closed ? group.at(-1)! : '';
  const body = group.slice(1, closed ? -1 : undefined);
  // Room for code lines in one piece: the opener and its newline before
  // them, a newline and the longer closing line after them.
  const room = limit - opener.length - 2 - Math.max(run.length, closer.length);
  if (room < Math.max(2, limit / 2)) return undefined;
  const codes: string[] = [];
  let current: string | null = null;
  for (const line of body) {
    const units = line.length <= room ? [line] : hardCuts(line, room).map((atom) => atom.text);
    for (const unit of units) {
      if (current !== null && current.length + 1 + unit.length <= room) {
        current += `\n${unit}`;
        continue;
      }
      if (current !== null) codes.push(current);
      current = unit;
    }
  }
  if (current !== null) codes.push(current);
  if (codes.length === 0) return undefined;
  return codes.map((code, index) => ({
    sep: '\n',
    text:
      index < codes.length - 1
        ? `${opener}\n${code}\n${run}`
        : `${opener}\n${code}${closed ? `\n${closer}` : ''}`,
    fresh: index > 0,
  }));
}

/** Within one paragraph: a fenced block stays whole, other lines stand alone. */
function groupAtoms(lines: string[], limit: number): Atom[] {
  return lineGroups(lines).map((group) => ({
    sep: '\n',
    text: group.join('\n'),
    refine:
      group.length > 1
        ? () => fencePieces(group, limit) ?? lineAtoms(group, limit)
        : () => hardCuts(group[0]!, limit),
  }));
}

/**
 * Paragraphs: runs of lines split by blank lines outside a fenced block. Blank
 * lines before the first paragraph or after the last stay in it.
 */
function paragraphAtoms(text: string, limit: number): Atom[] {
  const paragraphs: { sep: string; lines: string[] }[] = [];
  let blanks: string[] = [];
  for (const group of lineGroups(text.split('\n'))) {
    if (group.length === 1 && !group[0]!.trim()) {
      blanks.push(group[0]!);
      continue;
    }
    const last = paragraphs.at(-1);
    // Appended line by line: spreading a long group into `push` exceeds the
    // engine's argument limit (V8 at about 125,000).
    if (!last) paragraphs.push({ sep: '', lines: blanks.concat(group) });
    else if (blanks.length === 0) for (const line of group) last.lines.push(line);
    else paragraphs.push({ sep: `\n${blanks.map((line) => `${line}\n`).join('')}`, lines: group });
    blanks = [];
  }
  const last = paragraphs.at(-1);
  if (!last) return groupAtoms(blanks, limit);
  for (const line of blanks) last.lines.push(line);
  return paragraphs.map(({ sep, lines }) => ({
    sep,
    text: lines.join('\n'),
    refine: () => groupAtoms(lines, limit),
  }));
}

/**
 * Splits `text` into pieces of at most `limit` (2 or more) UTF-16 code units,
 * at paragraph boundaries first, then line boundaries, then hard cuts, never
 * splitting a surrogate pair.
 *
 * - Pieces are packed greedily, except that a block (a paragraph, or a line or
 *   fenced block inside one) too long for `limit` starts a new piece.
 * - A fenced code block is cut only when it alone exceeds `limit`. It is then
 *   re-fenced so each piece renders as code: see `fencePieces`.
 * - The separator at each cut is dropped. Joined with their cut separators,
 *   the pieces restore `text`, except where a fenced block was re-fenced or a
 *   piece dropped.
 * - A piece that is empty or only whitespace is dropped, so a whitespace-only
 *   `text` gives `[]`.
 * - `\r\n` line ends are kept; a fence line may end in `\r`.
 */
export function splitLongText(text: string, limit = CAPTURE_PIECE_LIMIT): string[] {
  if (!Number.isInteger(limit) || limit < 2)
    throw new RangeError('limit must be an integer of at least 2, to hold a surrogate pair');
  if (text.length <= limit) return text.trim() ? [text] : [];
  const pieces: string[] = [];
  let current: string | null = null;
  const place = (atom: Atom): void => {
    if (
      current !== null &&
      !atom.fresh &&
      current.length + atom.sep.length + atom.text.length <= limit
    ) {
      current += atom.sep + atom.text;
      return;
    }
    if (current !== null) pieces.push(current);
    current = null;
    if (atom.text.length <= limit || !atom.refine) {
      current = atom.text;
      return;
    }
    for (const part of atom.refine()) place(part);
  };
  for (const atom of paragraphAtoms(text, limit)) place(atom);
  if (current !== null) pieces.push(current);
  return pieces.filter((piece) => piece.trim());
}

const CONTINUED = ' (continued)';

/**
 * The title of piece `index` (0-based) of a split capture, as the plugins name
 * it: piece 0 keeps `title`, and every later piece is `<title> (continued)`,
 * or `(continued)` alone when `title` is blank. The result is at most
 * {@link CAPTURE_TITLE_MAX_CHARS}: `title` is cut, never between a surrogate
 * pair's halves, so that it and any suffix fit.
 */
export function continuedTitle(title: string, index: number): string {
  if (index <= 0) return capTitle(title, CAPTURE_TITLE_MAX_CHARS);
  const base = capTitle(title, CAPTURE_TITLE_MAX_CHARS - CONTINUED.length);
  return base.trim() ? `${base}${CONTINUED}` : CONTINUED.trimStart();
}

/** A lone surrogate half (with the `u` flag, a paired half is part of one code point). */
const LONE_SURROGATE = /[\u{D800}-\u{DFFF}]/gu;

/**
 * The characters `stripInvisibleText` removes, in one pass. The first
 * alternative keeps the three RGI subdivision flags (UTS #51: England,
 * Scotland, Wales, each U+1F3F4, five tag letters and U+E007F); any other
 * tag character goes, so no run of flags can spell text.
 *
 * - Tag characters (U+E0000–U+E007F): invisible, and able to spell out any
 *   ASCII text, so a hidden instruction rides in them.
 * - The bidi embeddings, overrides and isolates (U+202A–U+202E,
 *   U+2066–U+2069) that reorder how text displays (Trojan Source).
 * - The invisible operators (U+2061–U+2064) and the deprecated format
 *   characters (U+206A–U+206F), binary carriers.
 * - The Hangul fillers U+115F, U+1160, U+3164 and U+FFA0, which render blank.
 */
const HIDDEN_CHARACTERS =
  /(\u{1F3F4}\u{E0067}\u{E0062}(?:\u{E0065}\u{E006E}\u{E0067}|\u{E0073}\u{E0063}\u{E0074}|\u{E0077}\u{E006C}\u{E0073})\u{E007F})|[\u{E0000}-\u{E007F}\u{202A}-\u{202E}\u{2061}-\u{2064}\u{2066}-\u{206F}\u{115F}\u{1160}\u{3164}\u{FFA0}]/gu;

/**
 * A variation selector (U+FE00–U+FE0F, U+E0100–U+E01EF) and the selectors
 * right after it. Emoji presentation and CJK ideographic variation sequences
 * use one after a base character; a run is a hidden carrier.
 */
const VARIATION_SELECTOR_RUN =
  /([\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}])[\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]+/gu;

/** Zero-width space, word joiner, the invisible operators, and the BOM. */
const INVISIBLE_TITLE_FORMATS = /[\u{200B}\u{2060}-\u{2064}\u{FEFF}]/gu;

/**
 * A captured body with its hidden-text characters removed (`HIDDEN_CHARACTERS`),
 * and each run of variation selectors cut to its first.
 *
 * - Lone surrogate halves become U+FFFD first, so no removal can join two
 *   halves into a character, a tag character for one.
 * - Zero-width space, non-joiner and joiner (U+200B–U+200D) and the LRM and
 *   RLM marks stay: real text in many scripts, and emoji sequences, use them.
 */
export function stripInvisibleText(text: string): string {
  return text
    .replace(LONE_SURROGATE, '\u{FFFD}')
    .replace(HIDDEN_CHARACTERS, (_match, flag: string | undefined) => flag ?? '')
    .replace(VARIATION_SELECTOR_RUN, '$1');
}

/**
 * A page or chat title made safe to save and show. It removes what
 * {@link stripInvisibleText} removes, lone halves included (they become
 * U+FFFD), plus U+200B, U+2060–U+2064 and U+FEFF, C0/C1 controls, and the ALM,
 * LRM and RLM marks. U+200D stays, for emoji sequences. Whitespace collapses
 * to single spaces, and the result is trimmed and capped at
 * {@link CAPTURE_TITLE_MAX_CHARS} without splitting a surrogate pair.
 */
export function cleanTitle(raw: string): string {
  const collapsed = stripInvisibleText(raw)
    .replace(INVISIBLE_TITLE_FORMATS, '')
    .replace(/\s+/g, ' ');
  let kept = '';
  for (let index = 0; index < collapsed.length; index += 1) {
    if (!isStrippedTitleUnit(collapsed.charCodeAt(index))) kept += collapsed[index];
  }
  // The removals above can join variation selectors they separated.
  const cut = kept.replace(VARIATION_SELECTOR_RUN, '$1');
  return capTitle(cut.replace(/ {2,}/g, ' ').trim(), CAPTURE_TITLE_MAX_CHARS);
}

/** `title` cut to `max` code units, never between a surrogate pair's halves. */
function capTitle(title: string, max: number): string {
  if (title.length <= max) return title;
  let end = max;
  const last = title.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return title.slice(0, end).trimEnd();
}

/** C0 and C1 controls, DEL, and the bidi marks (ALM, LRM, RLM). */
function isStrippedTitleUnit(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f
  );
}
