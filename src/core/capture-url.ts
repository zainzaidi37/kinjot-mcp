// @generated — DO NOT EDIT.
//
// Vendored copy of packages/core/src/capture-url.ts, emitted by
// `pnpm --filter @kinjot/core emit:mcp-core` (plans/desktop-app.md §4.5).
// Edit the source module and re-run; CI fails on any difference.

import { EXTENSION_API_URL } from './extension-wire.js';
import { isSecretNamePart } from './secret-scrub.js';

/**
 * URL checks for the browser extension (`plans/browser-extension-2026-11-03.md`
 * §3.5): which tabs it may clip, which endpoint may receive a BYO key, and the
 * secrets a clipped URL can carry.
 */

/** Whether a tab's URL may be clipped: `http:` or `https:`, with no user-info. */
export function isClippableUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    parsed.username === '' &&
    parsed.password === ''
  );
}

/**
 * A Supabase-hosted project's `mcp-api` endpoint, exactly: the canonical
 * project origin that `CANONICAL_ORIGIN` in `apps/web/src/data/byo-connect-link.ts`
 * admits, followed by `/functions/v1/mcp-api`. Compared as a string, never
 * parsed or repaired: no query, fragment, user-info, port, trailing slash or
 * other path.
 */
const BYO_MCP_API_URL = /^https:\/\/[a-z0-9]{8,63}\.supabase\.co\/functions\/v1\/mcp-api$/;

/** Kinjot's hosted project origin, from {@link EXTENSION_API_URL}. */
const HOSTED_ORIGIN = new URL(EXTENSION_API_URL).origin;

/**
 * Whether `url` has the shape of a BYO `mcp-api` endpoint: a canonical
 * Supabase-hosted project's `mcp-api` path, never Kinjot's hosted project
 * (`docs/contracts/extension.md`: a BYO key is never sent to the hosted
 * endpoint). A shape check cannot tell whose project it is: binding a key to
 * its project comes from where the pair was obtained.
 */
export function isByoMcpApiUrl(url: string): boolean {
  return BYO_MCP_API_URL.test(url) && !url.startsWith(`${HOSTED_ORIGIN}/`);
}

/**
 * Parameter names whose value is a secret, compared whole after decoding and
 * lowercasing, on top of the names with a secret part (`isSecretParameterName`).
 * The one-time codes (`oobcode`, Firebase Auth's action links; `ticket`, CAS;
 * `samlresponse`) are bearer credentials while they live.
 */
const SECRET_PARAMETER_NAMES: ReadonlySet<string> = new Set([
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'api_key',
  'apikey',
  'key',
  'secret',
  'password',
  'sig',
  'signature',
  'code',
  'auth',
  'oobcode',
  'otp',
  'authcode',
  'auth_code',
  'authorization_code',
  'ticket',
  'samlresponse',
]);

/**
 * Name parts that mark a secret beyond {@link isSecretNamePart}'s list: URL
 * signatures and credentials (`X-Amz-Signature`, `X-Goog-Credential`) and
 * session ids (`PHPSESSID`, `;jsessionid=`).
 */
const SECRET_NAME_PARTS: ReadonlySet<string> = new Set([
  'signature',
  'sig',
  'credential',
  'session',
  'sessionid',
  'sid',
  'phpsessid',
  'jsessionid',
]);

/**
 * Words that mark a secret anywhere inside a name part, for compounds written
 * as one word (`authtoken`, `ACCESSTOKEN`, `clientsecret`). `key` is not one:
 * `monkey` and `keyword` are ordinary.
 */
const SECRET_PART_WORDS = /token|secret|passw(?:or)?d|signature|credential/;

/** One `;name=value` path parameter, such as `;jsessionid=`. */
const PATH_PARAMETER = /;([^=;/]*)=([^;/]*)/g;

/** The scheme and authority at the start of an absolute URL. */
const SCHEME_AND_AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i;

/** A value that may be a URL: a scheme, raw or percent-encoded, or a path. */
const URL_LIKE = /^(?:[a-z][a-z0-9+.-]*(?::|%3A)|\/|%2F)/i;

/** How deep a percent-encoded parameter value that is itself a URL is scanned. */
const NESTED_URL_DEPTH = 2;

/**
 * Webhooks whose path carries the credential: a URL on `host` whose
 * normalised path matches `path` keeps its first group, then `[redacted]`,
 * then its second group (empty for all but Telegram's method).
 */
const PATH_TOKEN_WEBHOOKS: readonly { host: RegExp; path: RegExp }[] = [
  { host: /^hooks\.slack(?:-gov)?\.com$/, path: /^(\/(?:services|workflows|triggers)\/).+()$/ },
  {
    host: /^(?:ptb\.|canary\.)?discord(?:app)?\.com$/,
    path: /^(\/api(?:\/v\d+)?\/webhooks\/).+()$/,
  },
  { host: /^api\.telegram\.org$/, path: /^(\/(?:file\/)?bot)[^/]+(.*)$/ },
  { host: /(?:^|\.)webhook\.office\.com$/, path: /^(\/webhookb2\/).+()$/ },
  { host: /^hooks\.zapier\.com$/, path: /^(\/hooks\/catch\/).+()$/ },
  { host: /^maker\.ifttt\.com$/, path: /^(\/trigger\/[^/]+\/with\/key\/).+()$/ },
  { host: /^maker\.ifttt\.com$/, path: /^(\/use\/).+()$/ },
];

const MARKER = '[redacted]';

function decodeOnce(value: string): string {
  try {
    return decodeURIComponent(value.replaceAll('+', ' '));
  } catch {
    return value;
  }
}

/**
 * Whether a parameter name marks a secret: the whole name is one of
 * `SECRET_PARAMETER_NAMES`, or a part of it passes {@link isSecretNamePart},
 * is one of `SECRET_NAME_PARTS` or contains one of `SECRET_PART_WORDS`. Parts
 * split at acronym and camelCase humps and at every character that is not a
 * letter or digit: `APIToken`, `accessToken`, `X-Amz-Signature`,
 * `auth[token]`, `api.key`.
 */
function isSecretParameterName(raw: string): boolean {
  const name = decodeOnce(raw);
  if (SECRET_PARAMETER_NAMES.has(name.toLowerCase())) return true;
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some(
      (part) =>
        isSecretNamePart(part) || SECRET_NAME_PARTS.has(part) || SECRET_PART_WORDS.test(part),
    );
}

/** `pathname` with every escape decoded (only unreserved ones if that fails) and `/` runs collapsed. */
function normalisedPath(pathname: string): string {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    // Unreserved characters may be percent-encoded (RFC 3986 §2.3): `%73ervices`.
    path = pathname.replace(/%([0-9A-Fa-f]{2})/g, (escape, hex: string) => {
      const char = String.fromCharCode(parseInt(hex, 16));
      return /[A-Za-z0-9._~-]/.test(char) ? char : escape;
    });
  }
  return path.replace(/\/{2,}/g, '/');
}

/** The URL rebuilt with its credential redacted, when `head` is a path-token webhook. */
function webhookHead(head: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(head);
  } catch {
    return undefined;
  }
  const host = parsed.hostname.replace(/\.$/, '');
  const path = normalisedPath(parsed.pathname);
  for (const webhook of PATH_TOKEN_WEBHOOKS) {
    if (!webhook.host.test(host)) continue;
    const match = webhook.path.exec(path);
    if (!match) continue;
    const port = parsed.port ? `:${parsed.port}` : '';
    return `${parsed.protocol}//${host}${port}${match[1]}${MARKER}${match[2]}`;
  }
  return undefined;
}

/**
 * The query and fragment `rest` with secret values redacted. It is cut at
 * `&` and `#`, and each cut at `?` and `;` to find names (`;` also splits the
 * HTML-escaped `&amp;`, and `?` a nested URL's own query). A secret-named
 * value runs to the next `&` or `#`, `;` included.
 */
function scrubParameters(rest: string, depth: number): { text: string; redacted: number } {
  let redacted = 0;
  const out: string[] = [];
  for (const chunk of rest.split(/(?=[&#])/)) {
    let offset = 0;
    for (const piece of chunk.split(/(?=[?;])/)) {
      const start = offset;
      offset += piece.length;
      const lead = /^[?&#;]/.test(piece) ? piece[0]! : '';
      const equals = piece.indexOf('=');
      if (equals < 0) {
        out.push(piece);
        continue;
      }
      const name = piece.slice(lead.length, equals);
      if (isSecretParameterName(name)) {
        const value = chunk.slice(start + equals + 1);
        if (value === '' || value === MARKER) out.push(chunk.slice(start));
        else {
          redacted += 1;
          out.push(`${lead}${name}=${MARKER}`);
        }
        break;
      }
      const value = piece.slice(equals + 1);
      const nested =
        depth < NESTED_URL_DEPTH && URL_LIKE.test(value) ? scrubNested(value, depth) : undefined;
      if (nested) {
        redacted += nested.redacted;
        out.push(`${lead}${name}=${nested.url}`);
      } else out.push(piece);
    }
  }
  return { text: out.join(''), redacted };
}

/**
 * A URL-like value scanned as a URL, raw or else percent-decoded once.
 * Undefined when nothing in it is redacted, so its bytes stay as they were; a
 * value redacted after decoding is re-encoded whole.
 */
function scrubNested(value: string, depth: number): { url: string; redacted: number } | undefined {
  const raw = scrubAt(value, depth + 1);
  if (raw.redacted > 0) return raw;
  const decoded = decodeOnce(value);
  if (decoded === value) return undefined;
  const inner = scrubAt(decoded, depth + 1);
  return inner.redacted > 0
    ? { url: encodeURIComponent(inner.url), redacted: inner.redacted }
    : undefined;
}

function scrubAt(url: string, depth: number): { url: string; redacted: number } {
  let redacted = 0;
  const cut = url.search(/[?#]/);
  let head = cut < 0 ? url : url.slice(0, cut);
  const rest = url.slice(head.length);

  const authority = SCHEME_AND_AUTHORITY.exec(head)?.[0];
  const webhook = authority === undefined ? undefined : webhookHead(head);
  if (webhook !== undefined) {
    head = webhook;
    redacted += 1;
  } else {
    const path = head
      .slice(authority?.length ?? 0)
      .replace(PATH_PARAMETER, (match, name: string, value: string) => {
        if (value === '' || value === MARKER || !isSecretParameterName(name)) return match;
        redacted += 1;
        return `;${name}=${MARKER}`;
      });
    head = (authority ?? '') + path;
  }

  const parameters = scrubParameters(rest, depth);
  return { url: head + parameters.text, redacted: redacted + parameters.redacted };
}

/**
 * A URL with the secrets it carries replaced by `[redacted]`, and how many it
 * replaced:
 *
 * - the value of every query, fragment or `;` path parameter whose name is
 *   secret-like (`isSecretParameterName`), a hash route's or a nested URL's
 *   own query included (`scrubParameters`);
 * - inside the value of any other parameter that looks like a URL, the same,
 *   raw or percent-decoded once, to `NESTED_URL_DEPTH` levels;
 * - the credential in a path-token webhook's path (`PATH_TOKEN_WEBHOOKS`:
 *   Slack, GovSlack, Discord, Telegram bots, Teams, Zapier, IFTTT), matched on
 *   the parsed URL with its host's trailing dot dropped, its path decoded and
 *   its `/` runs collapsed, and rebuilt from its scheme, host and port.
 *
 * Lone surrogate halves become U+FFFD first. Every other byte is kept, except
 * that a nested value redacted after decoding is re-encoded whole (`+` comes
 * back as `%20`, `%28` as `(`). Names match generously, so an ordinary
 * parameter such as `sort_key` or `code` is redacted too: a broken source
 * link is the accepted cost, and missing a token is not. It runs beside,
 * never instead of, `scrubExactSecrets` (`secret-scrub.ts`), which knows token
 * formats only.
 */
export function scrubUrlSecrets(url: string): { url: string; redacted: number } {
  return scrubAt(url.replace(/[\u{D800}-\u{DFFF}]/gu, '\u{FFFD}'), 0);
}
