// @generated — DO NOT EDIT.
//
// Vendored copy of packages/core/src/secret-scrub.ts, emitted by
// `pnpm --filter @kinjot/core emit:mcp-core` (plans/desktop-app.md §4.5).
// Edit the source module and re-run; CI fails on any difference.

/**
 * Pass 1 of the capture plugins' autosave scrub: exact secret formats only,
 * with no prompt-text heuristics (Pass 2 stays in the plugins).
 *
 * This module is the source. Two generated copies and one hand-kept copy run
 * it:
 *
 * - `supabase/functions/_shared/core/secret-scrub.ts`, which
 *   `packages/core/scripts/emit-edge-core.mjs` generates and Inbox text goes
 *   through (`supabase/functions/_shared/inbox.ts`);
 * - `packages/mcp/src/core/secret-scrub.ts`, which
 *   `packages/core/scripts/emit-mcp-vendor.mjs` generates for the published
 *   MCP package;
 * - `scrub` in `integrations/shared/capture-support.mjs`, which the Claude Code
 *   and Codex plugins run and which cannot import core. Its `exactSecrets` list
 *   is pinned to {@link EXACT_SECRET_PATTERNS} by `secret-scrub.test.ts`.
 *
 * Dependency-free: the Edge emitter refuses any import here.
 */

/**
 * Exact-format secrets, each replaced whole with `[redacted]` (escaped where
 * it would complete Markdown: {@link markerAt}).
 */
const EXACT_SECRETS: readonly RegExp[] = [
  /\bkj_live_[A-Za-z0-9]{43}\b/g,
  /\bsk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  /\b(?:sb_secret_|sbp_)[A-Za-z0-9_-]{16,}\b/g,
  /\bwhsec_[A-Za-z0-9+/=_-]{16,}(?![A-Za-z0-9+/=_-])/g,
  /\bnpm_[A-Za-z0-9-]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\bBearer\s+(?![$<{])[A-Za-z0-9._~+/=-]{20,}\b/gi,
  /-----BEGIN (?:[A-Z ]* )?PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,10000}?-----END (?:[A-Z ]* )?PRIVATE KEY(?: BLOCK)?-----/g,
];

/**
 * {@link EXACT_SECRETS} as frozen `{source, flags}` pairs. A shared `/g`
 * regex keeps `lastIndex` between `test` calls, so none is exported: a
 * consumer builds its own with `new RegExp(source, flags)`.
 */
export const EXACT_SECRET_PATTERNS: readonly Readonly<{ source: string; flags: string }>[] =
  Object.freeze(EXACT_SECRETS.map(({ source, flags }) => Object.freeze({ source, flags })));

/**
 * Whether one `_`-separated part of a name marks its value as a secret, as in
 * `DB_PASSWORD` or `OPENAI_API_KEY`: the closed list the secret-named
 * assignment pass uses, which `scrubUrlSecrets` in `capture-url.ts` shares.
 */
export function isSecretNamePart(part: string): boolean {
  return /^(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD)$/i.test(part);
}

/** The marker every pass writes in place of a secret. */
const MARKER = '[redacted]';

/**
 * {@link MARKER} with its brackets backslash-escaped, which Markdown renders as
 * the text `[redacted]`. Its brackets open and close nothing only when an even
 * run of backslashes precedes it, which {@link markerAt} ensures.
 */
const ESCAPED_MARKER = '\\[redacted\\]';

/**
 * The marker for an exact-format secret spanning `start` to `end` in `text`
 * (#1829). Directly after `!` or `]`, or directly before `(`, `[` or `:`, the
 * literal marker would complete CommonMark structure the input did not have:
 * an image (`![redacted](url)`, `![redacted][x]`), an inline link
 * (`[redacted](url)`), a full or collapsed reference link (`[redacted][x]`,
 * `[x][redacted]`) or a link reference definition (`[redacted]: url`). There it
 * is {@link ESCAPED_MARKER}; everywhere else, plain {@link MARKER}. After an
 * odd run of backslashes, the last would escape the marker's first character
 * (leaving `[` live in the escaped form, or `]` live to close an earlier `[`
 * in the plain one), so one more backslash precedes either marker there.
 *
 * Not closed: a plain marker, from this pass or the URL and assignment passes,
 * is a shortcut reference link when the same text carries a `[redacted]: url`
 * definition. That makes a link, never an image, since a marker after `!` is
 * always escaped.
 */
function markerAt(text: string, start: number, end: number): string {
  let backslashes = 0;
  while (text[start - 1 - backslashes] === '\\') backslashes += 1;
  const before = text[start - 1];
  const after = text[end];
  const marker =
    before === '!' || before === ']' || after === '(' || after === '[' || after === ':'
      ? ESCAPED_MARKER
      : MARKER;
  return backslashes % 2 === 1 ? `\\${marker}` : marker;
}

/** Whether `text` already holds a marker an earlier pass wrote. */
function holdsMarker(text: string): boolean {
  return text.includes(MARKER) || text.includes(ESCAPED_MARKER);
}

/** A password in URL user-info. A raw slash cannot occur there, so paths survive. */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]*:)[^\s/@]+(@[^\s/]+)/gi;

/** A shell or dotenv assignment, redacted only when its name has a secret-named part. */
const ENV_ASSIGNMENT =
  /^([ \t]*(?:(?:export|set)[ \t]+)?)([A-Za-z_][A-Za-z0-9_]*)([ \t]*=[ \t]*)(\S{8,})(.*)$/gim;

/**
 * {@link scrubExactSecrets}, plus how many secrets it redacted. A later pass
 * that re-redacts a span an earlier pass already holds a marker in (a known
 * format inside an assignment or URL user-info) is not counted again.
 */
export function scrubExactSecretsCounted(value: string): { text: string; redacted: number } {
  let redacted = 0;
  let result = value
    .replaceAll(String.fromCharCode(0), '\uFFFD')
    // A pair matches whole and is kept; a lone half matches alone. No
    // lookbehind: core ships to browsers (eslint `no-restricted-syntax`).
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (unit) =>
      unit.length === 2 ? unit : '\uFFFD',
    );
  for (const pattern of EXACT_SECRETS) {
    const text = result;
    result = result.replace(pattern, (match: string, ...rest: unknown[]) => {
      redacted += 1;
      // The offset is the first number after any capture groups.
      const offset = rest.find((argument) => typeof argument === 'number') as number;
      return markerAt(text, offset, offset + match.length);
    });
  }
  result = result.replace(URL_USERINFO, (match: string, head: string, tail: string) => {
    if (!holdsMarker(match.slice(head.length, match.length - tail.length))) redacted += 1;
    return `${head}${MARKER}${tail}`;
  });
  result = result.replace(
    ENV_ASSIGNMENT,
    (match, prefix: string, name: string, assignment: string, content: string, suffix: string) => {
      if (/^(?:PWD|OLDPWD)$/i.test(name)) return match;
      if (!name.split('_').some(isSecretNamePart)) return match;
      if (isCodeValue(content)) return match;
      if (!holdsMarker(content)) redacted += 1;
      return `${prefix}${name}${assignment}${MARKER}${suffix}`;
    },
  );
  return { text: result, redacted };
}

/**
 * Replaces NUL and lone surrogates with U+FFFD, then every exact-format secret,
 * URL user-info password and secret-named assignment with `[redacted]` (or
 * `\[redacted\]`, #1829: {@link markerAt}).
 */
export function scrubExactSecrets(value: string): string {
  return scrubExactSecretsCounted(value).text;
}

function isCodeValue(value: string): boolean {
  if (value.startsWith('$') || value.startsWith('"') || value.startsWith("'"))
    return value.startsWith('$');
  if (/^[_a-z][_a-z0-9]*(?:\(|\[)/.test(value)) return true;
  if (/^[_A-Za-z][_A-Za-z0-9]*(?:\.[_A-Za-z][_A-Za-z0-9]*)+(?:\(|\[)/.test(value)) return true;
  const identifier = '(?:[a-z][a-z0-9_]*|[A-Z][A-Z0-9_]*)';
  return new RegExp(`^${identifier}(?:\\.${identifier})+$`).test(value);
}
