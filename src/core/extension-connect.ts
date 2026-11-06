// @generated — DO NOT EDIT.
//
// Vendored copy of packages/core/src/extension-connect.ts, emitted by
// `pnpm --filter @kinjot/core emit:mcp-core` (plans/desktop-app.md §4.5).
// Edit the source module and re-run; CI fails on any difference.

import { API_KEY_ACCESS_LEVELS, API_KEY_PATTERN, type ApiKeyAccess } from './api-key.js';

/**
 * The browser extension's pairing envelope and redirect allow-list
 * (`plans/browser-extension-2026-11-03.md` §5.2; `docs/contracts/extension.md`
 * §Rules that bite on first contact).
 *
 * The extension opens `/extension/connect` with a one-flow P-256 public key
 * (`epk`). The page mints a key on the user's click and returns it in the
 * redirect fragment sealed to that key: ECDH P-256 (256 bits), then
 * HKDF-SHA-256 with `salt = UTF-8(state)` and
 * `info = UTF-8('kinjot-extension-connect/v1')`, then AES-256-GCM with a
 * random 12-byte IV and `AAD = UTF-8(state)`. A reader of the redirect URL
 * (another extension holding `webNavigation` or `tabs`, Firefox history or
 * Sync) sees only ciphertext bound to a private key that never leaves the
 * extension's connect tab.
 *
 * The envelope does not authenticate who chose `epk`: an extension holding
 * `tabs` can rewrite the auth window's connect URL with its own. So the connect
 * tab shows {@link connectCode} for its own `epk` and `state`, and the page
 * mints only after the user types the code the page derives from the URL it
 * received (plan §5.2; the page side is PR-B).
 *
 * The payload's `account` and `access` are display hints only: the extension
 * trusts `key_info`'s answer for the key, never the envelope's claim about it.
 *
 * WebCrypto only (`globalThis.crypto`, read at call time, never at import):
 * this module runs in browsers, in extension service workers and in Node 22+,
 * and the barrel's vendored copy loads in the `kinjot` CLI
 * (`packages/core/scripts/emit-mcp-vendor.mjs`), which never calls it.
 */

export const EXTENSION_CONNECT_VERSION = '1';
export const EXTENSION_CLIENTS = ['chrome', 'edge', 'firefox'] as const;
export type ExtensionClient = (typeof EXTENSION_CLIENTS)[number];
export const EXTENSION_GECKO_ID = 'extension@kinjot.com';

/**
 * Each store build's `identity.getRedirectURL()`, or null while it is not
 * live. Chrome and Edge wait for their store items (PR-15,
 * `https://<id>.chromiumapp.org/`).
 *
 * Firefox stays null until Zain reserves {@link EXTENSION_GECKO_ID} on AMO:
 * AMO assigns email-form add-on ids first come, first served, and anyone who
 * signs an add-on with that id gets the identical redirect URI. PR-15 fills the
 * entry with `firefoxRedirectUri(EXTENSION_GECKO_ID)` once it is reserved.
 */
export const EXTENSION_REDIRECT_URIS: Readonly<Record<ExtensionClient, string | null>> =
  /* @__PURE__ */ Object.freeze({
    chrome: null,
    edge: null,
    firefox: null,
  });

/**
 * Firefox's redirect URI for an add-on id:
 * `https://${hex(sha1(UTF-8(id)))}.${redirectDomain}/`. This is
 * `getRedirectURL` and `computeHash` in
 * `toolkit/components/extensions/child/ext-identity.js` (mozilla-firefox/firefox
 * 2b71df5bf2e0; lowercase hex via `CommonUtils.bytesAsHex`), with the pref
 * `extensions.webextensions.identity.redirectDomain` defaulting to
 * `extensions.allizom.org` in `modules/libpref/init/all.js`.
 */
export async function firefoxRedirectUri(geckoId: string): Promise<string> {
  const digest = new Uint8Array(await subtle().digest('SHA-1', encoder.encode(geckoId)));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `https://${hex}.extensions.allizom.org/`;
}

/**
 * The `extra` entries a caller may add: `https:` strings only, so an empty or
 * unset dev variable never admits `redirect_uri=` (#1805 review N8).
 */
function usableExtras(extra: readonly string[]): string[] {
  return extra.filter((entry) => typeof entry === 'string' && entry.startsWith('https://'));
}

/**
 * Exact string equality against the non-null entries plus `extra` (dev builds
 * only pass extra; empty and non-`https:` extras are ignored). No URL parsing
 * or normalising: a parsed comparison would accept spellings (case, default
 * port, userinfo, a trailing `?` or `#`) that the browser's own redirect
 * matcher may treat differently.
 */
export function isExtensionRedirectUri(uri: string, extra: readonly string[] = []): boolean {
  if (typeof uri !== 'string') return false;
  for (const allowed of [...Object.values(EXTENSION_REDIRECT_URIS), ...usableExtras(extra)]) {
    if (typeof allowed === 'string' && allowed === uri) return true;
  }
  return false;
}

/**
 * The browsers whose `identity.getRedirectURL()` has this form: Chromium's
 * `https://<32 letters a-p>.chromiumapp.org/` in Chrome and Edge alike, and
 * Firefox's `https://<40 hex>.extensions.allizom.org/` ({@link firefoxRedirectUri}).
 */
function clientsOfForm(uri: string): readonly ExtensionClient[] {
  if (/^https:\/\/[a-p]{32}\.chromiumapp\.org\/$/.test(uri)) return ['chrome', 'edge'];
  if (/^https:\/\/[0-9a-f]{40}\.extensions\.allizom\.org\/$/.test(uri)) return ['firefox'];
  return [];
}

/**
 * `uri` is on the allow-list as `client`'s redirect (plan §5.2: `client` names
 * that member's browser). A listed entry binds by its key: Chrome and Edge share
 * the `chromiumapp.org` form, but each store assigns its own extension id, so
 * their entries are different strings. A dev `extra` names no browser, so it
 * binds by its form, and there a Chromium dev build may say either `chrome` or
 * `edge`; the client only names the key (`Kinjot · <Browser>`).
 */
function isRedirectUriOf(
  client: ExtensionClient,
  uri: string,
  extra: readonly string[] = [],
): boolean {
  if (typeof uri !== 'string') return false;
  const listedFor = EXTENSION_CLIENTS.filter((entry) => EXTENSION_REDIRECT_URIS[entry] === uri);
  if (listedFor.length > 0) return listedFor.includes(client);
  return usableExtras(extra).includes(uri) && clientsOfForm(uri).includes(client);
}

/** The refusal reasons, one per check; a closed union. */
export const CONNECT_REFUSALS = [
  'version',
  'client',
  'redirect_uri',
  'state',
  'epk',
  'fragment',
  'replay',
  'pk',
  'iv',
  'ct',
  'decrypt',
  'payload',
] as const;
export type ConnectRefusal = (typeof CONNECT_REFUSALS)[number];

export interface ConnectRequest {
  v: '1';
  client: ExtensionClient;
  redirectUri: string;
  state: string;
  epk: string;
}

/**
 * The sealed payload. `account` and `access` are display hints for the connect
 * tab only: the extension takes the key's level and account from `key_info`,
 * never from this envelope.
 */
export interface ConnectPayload {
  key: string;
  key_id: string;
  access: ApiKeyAccess;
  name: string;
  account: string;
}

const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;
const HKDF_INFO = 'kinjot-extension-connect/v1';
const P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;
const RAW_P256_POINT_BYTES = 65;
const IV_BYTES = 12;
/** The AES-GCM tag is 16 bytes, so a shorter `ct` cannot be a ciphertext. */
const CT_MIN_BYTES = 16;
const CT_MAX_BYTES = 4096;
/** The seal's and the opener's bound on `key_id`, `name` and `account`. */
export const PAYLOAD_FIELD_MAX_CHARS = 200;
const encoder = /* @__PURE__ */ new TextEncoder();

function subtle(): SubtleCrypto {
  return globalThis.crypto.subtle;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Strict base64url without padding: the alphabet, a length bound checked
 * before any decode, and the canonical spelling only (a re-encode must give
 * back the input, so no second spelling of the same bytes exists).
 */
function fromBase64url(value: string, maxBytes: number): Uint8Array<ArrayBuffer> | null {
  if (!BASE64URL_PATTERN.test(value) || value.length > Math.ceil((maxBytes * 4) / 3)) return null;
  if (value.length % 4 === 1) return null;
  let binary: string;
  try {
    binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return base64url(bytes) === value ? bytes : null;
}

/** An uncompressed P-256 point, exactly 65 bytes, that imports (so lies on the curve). */
async function importPoint(value: string): Promise<CryptoKey | null> {
  const bytes = fromBase64url(value, RAW_P256_POINT_BYTES);
  if (bytes === null || bytes.length !== RAW_P256_POINT_BYTES || bytes[0] !== 0x04) return null;
  try {
    return await subtle().importKey('raw', bytes, P256, true, []);
  } catch {
    return null;
  }
}

async function envelopeKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  state: string,
  usage: 'encrypt' | 'decrypt',
): Promise<CryptoKey> {
  const shared = await subtle().deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const hkdf = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return await subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(state), info: encoder.encode(HKDF_INFO) },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

/** One value per name: a repeated parameter is refused, never first-wins. */
function single(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 ? (values[0] as string) : null;
}

function boundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length <= PAYLOAD_FIELD_MAX_CHARS;
}

/** The five fields, rebuilt explicitly, or null. */
function checkedPayload(value: unknown): ConnectPayload | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { key, key_id, access, name, account } = value as Record<string, unknown>;
  if (typeof key !== 'string' || !API_KEY_PATTERN.test(key)) return null;
  if (typeof access !== 'string' || !(API_KEY_ACCESS_LEVELS as readonly string[]).includes(access))
    return null;
  if (!boundedString(key_id) || !boundedString(name) || !boundedString(account)) return null;
  return { key, key_id, access: access as ApiKeyAccess, name, account };
}

/**
 * The connect page's check on the fields it chooses, before it mints: when this
 * holds, {@link sealConnectPayload} accepts them with the minted `key` and
 * `key_id`, so a seal never fails after a key exists (plan §3.4; #1805 review N8).
 */
export function connectPayloadFieldsFit(
  fields: Pick<ConnectPayload, 'access' | 'name' | 'account'>,
): boolean {
  const { access, name, account } = fields as Record<string, unknown>;
  return (
    typeof access === 'string' &&
    (API_KEY_ACCESS_LEVELS as readonly string[]).includes(access) &&
    boundedString(name) &&
    boundedString(account)
  );
}

/** 32 random bytes, base64url without padding (43 characters). */
export function newConnectState(): string {
  return base64url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

// The hosted bundle-scan (`.github/workflows/ci.yml`, "Assert the hosted bundle
// carries no BYO connect link") refuses BYO's connect-link marker in any string
// that reaches `apps/web/dist`, as this one does, so it must not contain it.
const CONNECT_CODE_SALT = 'kinjot-pairing-code/v2';
const CONNECT_CODE_ITERATIONS = 200_000;
const CONNECT_CODE_BITS = 60;
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * The pairing code both sides show (plan §5.2): the first 60 bits of
 * PBKDF2-HMAC-SHA-256 with `password = raw epk bytes || UTF-8(state)`,
 * `salt = UTF-8('kinjot-pairing-code/v2')` and 200,000 iterations, as 12
 * Crockford base32 characters, most significant bits first, formatted
 * `XXXX-XXXX-XXXX`. Throws unless `epk` is a 65-byte uncompressed point encoding.
 *
 * Sized as an offline-grindable check, not an interactive one: an extension
 * that substitutes its own `epk` also chooses `state` freely (it reads the
 * sealed fragment itself, so `openConnectFragment`'s state check never binds
 * it), and can grind `state` until its code matches the one the genuine tab
 * shows. 60 bits behind 200,000 iterations puts that at about 2^77 SHA-256
 * compressions (#1805 final security review PAIRING-1).
 */
export async function connectCode(epk: string, state: string): Promise<string> {
  const raw = fromBase64url(epk, RAW_P256_POINT_BYTES);
  if (raw === null || raw.length !== RAW_P256_POINT_BYTES || raw[0] !== 0x04)
    throw new Error('connectCode: epk is not a 65-byte uncompressed point');
  const stateBytes = encoder.encode(state);
  const password = new Uint8Array(raw.length + stateBytes.length);
  password.set(raw, 0);
  password.set(stateBytes, raw.length);
  const pbkdf2 = await subtle().importKey('raw', password, 'PBKDF2', false, ['deriveBits']);
  const derived = new Uint8Array(
    await subtle().deriveBits(
      {
        name: 'PBKDF2',
        hash: 'SHA-256',
        salt: encoder.encode(CONNECT_CODE_SALT),
        iterations: CONNECT_CODE_ITERATIONS,
      },
      pbkdf2,
      64,
    ),
  );
  let bits = 0n;
  for (const byte of derived) bits = (bits << 8n) | BigInt(byte);
  bits >>= BigInt(64 - CONNECT_CODE_BITS);
  let code = '';
  for (let shift = BigInt(CONNECT_CODE_BITS - 5); shift >= 0n; shift -= 5n) {
    code += CROCKFORD_ALPHABET[Number((bits >> shift) & 31n)];
  }
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}

/**
 * A typed code in the compact form `connectCode` compares in: upper case,
 * whitespace and dashes removed, and Crockford's look-alikes decoded (I and L
 * to 1, O to 0). Equal outputs mean the same code; the display form
 * `XXXX-XXXX-XXXX` normalizes to its twelve characters without the dashes.
 */
export function normalizeConnectCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
}

/** P-256 ECDH pair; the private key is non-extractable; epk = raw public key (65 bytes) base64url. */
export async function generateConnectKeyPair(): Promise<{ privateKey: CryptoKey; epk: string }> {
  const pair = await subtle().generateKey(P256, false, ['deriveBits']);
  const raw = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, epk: base64url(raw) };
}

/** `${origin}/extension/connect?v=1&client=…&redirect_uri=…&state=…&epk=…` */
export function buildConnectUrl(origin: string, request: ConnectRequest): string {
  if (new URL(origin).origin !== origin) throw new Error(`not an origin: ${origin}`);
  const query = new URLSearchParams({
    v: request.v,
    client: request.client,
    redirect_uri: request.redirectUri,
    state: request.state,
    epk: request.epk,
  });
  return `${origin}/extension/connect?${query.toString()}`;
}

/**
 * The connect page's check, before it offers Connect (and so before any mint).
 * Checks run in the order of {@link CONNECT_REFUSALS}; unknown parameters are
 * ignored and a repeated known one is refused. A `redirect_uri` that is listed,
 * but not as `client`'s, is refused as `redirect_uri`.
 */
export async function parseConnectRequest(
  search: string | URLSearchParams,
  opts: { extraRedirectUris?: readonly string[] } = {},
): Promise<{ ok: true; request: ConnectRequest } | { ok: false; reason: ConnectRefusal }> {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  if (single(params, 'v') !== EXTENSION_CONNECT_VERSION) return { ok: false, reason: 'version' };
  const client = single(params, 'client');
  if (client === null || !(EXTENSION_CLIENTS as readonly string[]).includes(client))
    return { ok: false, reason: 'client' };
  const redirectUri = single(params, 'redirect_uri');
  if (
    redirectUri === null ||
    !isRedirectUriOf(client as ExtensionClient, redirectUri, opts.extraRedirectUris)
  )
    return { ok: false, reason: 'redirect_uri' };
  const state = single(params, 'state');
  if (state === null || !STATE_PATTERN.test(state)) return { ok: false, reason: 'state' };
  const epk = single(params, 'epk');
  if (epk === null || (await importPoint(epk)) === null) return { ok: false, reason: 'epk' };
  return {
    ok: true,
    request: { v: '1', client: client as ExtensionClient, redirectUri, state, epk },
  };
}

/**
 * Page side. Returns the full redirect URL: `${redirectUri}#v=1&state=…&pk=…&iv=…&ct=…`.
 * Throws if payload.key fails API_KEY_PATTERN, or on any other payload or
 * request field {@link openConnectFragment} would refuse, so the page never
 * redirects with an envelope the extension cannot open. It re-checks
 * `redirectUri` against the allow-list as `client`'s, with the same
 * `extraRedirectUris` {@link parseConnectRequest} took, because the page hands
 * the result to `location.replace` and `ConnectRequest` is a plain interface
 * any caller can build (#1805 review N1).
 */
export async function sealConnectPayload(
  request: ConnectRequest,
  payload: ConnectPayload,
  opts: { extraRedirectUris?: readonly string[] } = {},
): Promise<string> {
  if (
    !(EXTENSION_CLIENTS as readonly string[]).includes(request.client) ||
    !isRedirectUriOf(request.client, request.redirectUri, opts.extraRedirectUris)
  )
    throw new Error('sealConnectPayload: redirect_uri is not listed for the client');
  const checked = checkedPayload(payload);
  if (checked === null) throw new Error('sealConnectPayload: the payload fails its checks');
  if (!STATE_PATTERN.test(request.state)) throw new Error('sealConnectPayload: malformed state');
  const extensionKey = await importPoint(request.epk);
  if (extensionKey === null) throw new Error('sealConnectPayload: epk is not a P-256 point');
  // The page's pair lives for this call only; its private key is never exported.
  const pagePair = await subtle().generateKey(P256, false, ['deriveBits']);
  const aes = await envelopeKey(pagePair.privateKey, extensionKey, request.state, 'encrypt');
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await subtle().encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(request.state) },
      aes,
      encoder.encode(JSON.stringify(checked)),
    ),
  );
  if (ct.length > CT_MAX_BYTES) throw new Error('sealConnectPayload: the envelope is too large');
  const pk = new Uint8Array(await subtle().exportKey('raw', pagePair.publicKey));
  const fragment = [
    `v=${EXTENSION_CONNECT_VERSION}`,
    `state=${request.state}`,
    `pk=${base64url(pk)}`,
    `iv=${base64url(iv)}`,
    `ct=${base64url(ct)}`,
  ].join('&');
  return `${request.redirectUri}#${fragment}`;
}

/**
 * Private keys already opened with, per `CryptoKey` object. The plan makes the
 * flow's private key single-use whatever the outcome (§5.2), so a second call
 * with the same object is refused as `replay` before any parsing. A structured
 * clone (an IndexedDB round trip, a `postMessage`) is a new object this set
 * does not hold, so the guard holds only because the connect tab never persists
 * or posts the private key (#1805 review N2).
 */
const consumedKeys = /* @__PURE__ */ new WeakSet<CryptoKey>();

/** Extension side. Accepts the fragment with or without the leading '#'. */
export async function openConnectFragment(
  fragment: string,
  pending: { state: string; privateKey: CryptoKey },
): Promise<{ ok: true; payload: ConnectPayload } | { ok: false; reason: ConnectRefusal }> {
  if (consumedKeys.has(pending.privateKey)) return { ok: false, reason: 'replay' };
  consumedKeys.add(pending.privateKey);
  if (typeof fragment !== 'string') return { ok: false, reason: 'fragment' };
  const text = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  if (text === '') return { ok: false, reason: 'fragment' };
  const params = new URLSearchParams(text);
  if (single(params, 'v') !== EXTENSION_CONNECT_VERSION) return { ok: false, reason: 'version' };
  const state = single(params, 'state');
  if (state === null || !STATE_PATTERN.test(state) || state !== pending.state)
    return { ok: false, reason: 'state' };
  const pkText = single(params, 'pk');
  const pageKey = pkText === null ? null : await importPoint(pkText);
  if (pageKey === null) return { ok: false, reason: 'pk' };
  const ivText = single(params, 'iv');
  const iv = ivText === null ? null : fromBase64url(ivText, IV_BYTES);
  if (iv === null || iv.length !== IV_BYTES) return { ok: false, reason: 'iv' };
  const ctText = single(params, 'ct');
  const ct = ctText === null ? null : fromBase64url(ctText, CT_MAX_BYTES);
  if (ct === null || ct.length < CT_MIN_BYTES || ct.length > CT_MAX_BYTES)
    return { ok: false, reason: 'ct' };
  let plaintext: ArrayBuffer;
  try {
    const aes = await envelopeKey(pending.privateKey, pageKey, pending.state, 'decrypt');
    plaintext = await subtle().decrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(pending.state) },
      aes,
      ct,
    );
  } catch {
    return { ok: false, reason: 'decrypt' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
  } catch {
    return { ok: false, reason: 'payload' };
  }
  const payload = checkedPayload(parsed);
  return payload === null ? { ok: false, reason: 'payload' } : { ok: true, payload };
}
