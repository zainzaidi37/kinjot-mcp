import { createRequire } from 'node:module';
import {
  ApiError,
  KEY_INFO_DEADLINE_MS,
  NotesApi,
  type ApiErrorKind,
  type RecallMatch,
  type SearchHit,
  type SearchResult,
} from './api.js';
import { LocalUnavailableError, resolveBackend } from './backend.js';
import {
  API_KEY_PATTERN,
  DEFAULT_API_URL,
  normalizeDefaultApiUrl,
  resolveConfig,
} from './config.js';
import {
  configDir,
  loadStoredConfig,
  saveStoredAccount,
  saveStoredKey,
  saveStoredMode,
  type KinjotMode,
} from './configFile.js';
import { openLocalLibrary } from './local/library.js';
import { pointerExists, pointerPath } from './local/pointer.js';
import { resolveMode } from './mode.js';
import { readHiddenLine, type ReadHiddenLineOptions } from './prompt.js';
import { noteHandle } from './handle.js';
import { isUuidShapeAnyCase } from './uuid.js';
import { appendTextUsageError } from './append-text.js';
import { gitContext } from './git-context.js';
import { cachedMuteState, refreshMute } from './inbox-cache.js';
import { parseNoteLabel } from './core/note-label.js';

/**
 * The running version, read from package.json rather than restated here, so the
 * two cannot drift. They already had: npm shipped 0.4.0 while this constant
 * still said 0.3.0, and it is what every MCP client is told in the initialize
 * handshake (`serverInfo.version`), so the drift was invisible locally and
 * wrong everywhere else. `../package.json` resolves from both `src/cli.ts` and
 * the built `dist/cli.js` — each is one directory below the package root — and
 * npm always ships package.json, so this holds for a global install too.
 */
export const VERSION: string = (
  createRequire(import.meta.url)('../package.json') as { version: string }
).version;

export const HELP = `Kinjot — jot and find notes from the terminal

For terminal use anywhere: npm i -g kinjot, then kinjot key

Usage:
  kinjot add <title> [--body <text>] [--tags a,b] [--folder <name>] [--id <uuid>]
                                 (body is read from stdin when piped)
  kinjot search <query>
  kinjot recall <query>          semantic search by meaning (Pro plan)
  kinjot get <label|id-prefix|uuid> [--json]
  kinjot append <label|id-prefix|uuid> [--text <text>] [--no-snapshot]
                                 (text is read from stdin when piped)
  kinjot upload-image <path> [--alt <text>] [--json]
  kinjot recent [n]
  kinjot notify <title> --kind question|blocker|handoff|done|waiting
                [--detail <text>] [--pr <url>] [--note <label>] [--cwd <dir>]
                [--session <id>] [--agent <name>] [--id <uuid>]
                [--input-json] [--json] [--no-cache]
                (detail is read from stdin when piped; --input-json reads title and detail from stdin)
  kinjot inbox [--all] [--kind handoff|question|blocker|done|any] [--cwd <dir>] [--json]
  kinjot inbox resolve <id> [--note <text>]
  kinjot                         run the MCP server on stdio (for MCP configs)
  kinjot init --key kj_live_... [--api-url <url>]
                                 validate a key and print the MCP config block
  kinjot init-selfhost [--api-url <url>] [--key kj_live_...]
                                 connect to your own Supabase project
  kinjot key [--api-url <url>]
                                 store your API key for this machine (input hidden)
  kinjot use local|account       choose where jots are written on this machine
  kinjot where                   show which library jots go to, and why
  kinjot help                    print this help (also --help, -h)
  kinjot --version               print the installed version (also -v, version)

Search, recall and recent leave out notes tagged autosave; get reads one by label.

Environment:
  KINJOT_API_KEY   API key from the web app (Settings → API keys); overrides
                   any key stored by \`kinjot key\`
  KINJOT_API_URL   override the API endpoint (defaults to production)
  KINJOT_MODE      local|account for a single command; overrides \`kinjot use\`

A key stored by \`kinjot key\` lives in ~/.kinjot/config.json (or
KINJOT_CONFIG_DIR if set) and is used automatically when KINJOT_API_KEY is
unset.

Local mode writes to the Kinjot desktop app's local library instead of your
account. It needs the desktop app (which creates that library), and only
\`kinjot add\` and the MCP jot tool work there — search, recall, get, recent and Inbox
live in the app.

Exit codes: 0 done; 1 ambiguous request failure (network, timeout, 5xx, 401, 429);
2 usage or definite Inbox refusal; 3 note or Inbox item not found;
4 unavailable for this library, old backend, or key access; 5 append done but a history copy was
kept despite --no-snapshot.
`;

class UsageError extends Error {}

const VALUELESS_FLAGS = new Set(['--no-snapshot', '--json', '--all', '--no-cache', '--input-json']);
const DEFINITE_INBOX_REFUSALS: ReadonlySet<ApiErrorKind> = new Set([
  'invalid_id',
  'invalid_kind',
  'invalid_source',
  'invalid_context',
  'invalid_title',
  'invalid_session',
  'invalid_request',
  'inbox_access_off',
  'id_conflict',
  'inbox_ambiguous_id',
]);

function parseFlags(argv: string[]): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      if (VALUELESS_FLAGS.has(arg)) {
        flags.set(arg.slice(2), 'true');
        continue;
      }
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError(`flag ${arg} needs a value`);
      }
      flags.set(arg.slice(2), value);
      i++;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

/**
 * Quote an environment value for the copy-pasteable POSIX shell commands
 * below. Keep identical to ApiKeysSection.tsx's commandArgument.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function selectedApiUrl(flags: ReadonlyMap<string, string>, env: NodeJS.ProcessEnv): string {
  const apiUrlFlag = flags.get('api-url');
  const apiUrl =
    apiUrlFlag === undefined ? env.KINJOT_API_URL?.trim() || DEFAULT_API_URL : apiUrlFlag.trim();
  if (apiUrl === '') throw new Error('--api-url needs a non-empty URL');
  return normalizeDefaultApiUrl(apiUrl);
}

const MCP_API_PATH = '/functions/v1/mcp-api';

export function selfHostApiUrl(project: string): string {
  const value = project.trim();
  if (/^[a-z0-9]{20}$/.test(value)) {
    return `https://${value}.supabase.co${MCP_API_PATH}`;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('enter a Supabase project ref or an http(s) project URL');
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    throw new Error('enter an http(s) project URL without embedded credentials');
  }
  if (url.pathname === '' || url.pathname === '/') url.pathname = MCP_API_PATH;
  return url.toString();
}

function rejectUnknownFlags(flags: ReadonlyMap<string, string>, allowed: readonly string[]): void {
  for (const flag of flags.keys()) {
    if (!allowed.includes(flag)) throw new UsageError(`unknown flag --${flag}`);
  }
}

/** Escape characters that terminals can interpret, without changing JSON.parse's result. */
export function terminalSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Sanitize one-line fields (titles, tags, ids, handles and errors). Strip
 * controls except tab so untrusted text can't inject output lines or terminal
 * commands (cursor games, fake output, OSC sequences).
 */
export function terminalSafe(text: string): string {
  // C0 controls except \t, plus DEL and C1 controls (covers ESC/CSI/OSC).
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g, '');
}

/** Sanitize multi-line bodies/details: keep LF and tab, fold CRLF, strip other controls. */
export function terminalSafeBody(text: string): string {
  return text.replace(/\r\n/g, '\n').split('\n').map(terminalSafe).join('\n');
}

function printHit(hit: SearchHit): void {
  const tags = hit.tags.map(terminalSafe).join(', ') || 'none';
  console.log(
    `${noteHandle(hit)}  ${hit.updated_at.slice(0, 10)}  ${terminalSafe(hit.title) || '(untitled)'}  [${tags}]  (${hit.id})`,
  );
}

function printSearch({ notes, total }: SearchResult, query: string): void {
  if (total === 0) {
    console.log(`No jots matched "${query}".`);
    return;
  }
  notes.forEach(printHit);
  if (total > notes.length) {
    console.log(`Showing ${notes.length} of ${total} matches — refine the query for others.`);
  }
  console.log(`Read one with: kinjot get <label|id-prefix|uuid>`);
}

// Recall candidates lead with the same handle as other listings and keep the
// full UUID. Title/gist are untrusted and go through terminalSafe.
export function formatRecallHit(match: RecallMatch): string {
  const gist = match.gist ? ` — ${terminalSafe(match.gist)}` : '';
  return `${noteHandle(match)}  [${match.similarity.toFixed(2)}]  ${terminalSafe(match.title) || '(untitled)'}  (${match.id})${gist}`;
}

function printRecall(matches: RecallMatch[], query: string): void {
  if (matches.length === 0) {
    console.log(`No jots matched "${query}" by meaning.`);
    return;
  }
  matches.forEach((match) => console.log(formatRecallHit(match)));
  console.log(`Read one with: kinjot get <label|id-prefix|uuid>`);
}

const ACCESS_LINES = {
  read: 'API key access: Read only — can read notes; cannot create or edit.',
  read_create:
    'API key access: Read and create — can read and create notes; edits, appends and session autosave need a full-access key.',
  full: 'API key access: Full access — can read, create, edit and append notes.',
} as const;

async function printKeyAccess(api: NotesApi, write: (line: string) => void): Promise<void> {
  try {
    write(`${ACCESS_LINES[await api.keyInfo(KEY_INFO_DEADLINE_MS)]}\n`);
  } catch {
    // The key was already validated; the level hint must not interrupt setup.
  }
}

async function runInit(flags: Map<string, string>, env: NodeJS.ProcessEnv): Promise<void> {
  rejectUnknownFlags(flags, ['key', 'api-url']);
  const key = flags.get('key') ?? env.KINJOT_API_KEY ?? '';
  if (!API_KEY_PATTERN.test(key)) {
    throw new Error(
      key === ''
        ? 'pass your API key: npx kinjot init --key kj_live_... (create one in Settings → API keys)'
        : 'that key does not look like a Kinjot key (expected kj_live_ + 43 characters)',
    );
  }
  const apiUrl = selectedApiUrl(flags, env);
  const api = new NotesApi({ apiUrl, apiKey: key });

  process.stdout.write('Checking the key against the API… ');
  await api.listRecentNotes(1);
  console.log('ok ✔\n');
  await printKeyAccess(api, (line) => console.log(line.trimEnd()));

  const envBlock: Record<string, string> = { KINJOT_API_KEY: key };
  if (apiUrl !== DEFAULT_API_URL) envBlock.KINJOT_API_URL = apiUrl;
  const mcpConfig = {
    mcpServers: {
      kinjot: { command: 'npx', args: ['-y', 'kinjot'], env: envBlock },
    },
  };

  const claudeApiUrl = apiUrl === DEFAULT_API_URL ? '' : ` -e KINJOT_API_URL=${shellQuote(apiUrl)}`;
  const codexApiUrl =
    apiUrl === DEFAULT_API_URL ? '' : ` --env KINJOT_API_URL=${shellQuote(apiUrl)}`;
  console.log('With the Claude Code CLI:\n');
  console.log(`claude mcp add kinjot -e KINJOT_API_KEY=${key}${claudeApiUrl} -- npx -y kinjot`);
  console.log('\nWith the Codex CLI:\n');
  console.log(`codex mcp add kinjot --env KINJOT_API_KEY=${key}${codexApiUrl} -- npx -y kinjot`);
  console.log("\nOr add this to any other MCP client's JSON config (such as .mcp.json):\n");
  console.log(JSON.stringify(mcpConfig, null, 2));
  console.log('\nThen tell your agent to "jot that down" — done.');
  console.log(
    apiUrl === DEFAULT_API_URL
      ? '\nTip: `kinjot key` stores the key once for all terminals and MCP configs — no env block needed.'
      : '\nTip: `kinjot key --api-url <url>` stores the validated key and custom endpoint together.',
  );
}

export interface RunSelfHostDeps extends RunKeyDeps {
  readProject?: () => Promise<string>;
}

async function readPipedLines(input: ReadHiddenLineOptions['input']): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let body = '';
    input.on('data', (chunk: Buffer | string) => {
      body += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    input.on('end', () => resolve(body.split(/\r?\n/)));
    input.on('error', reject);
  });
}

interface TtySetupAnswers {
  project?: string;
  key?: string;
}

function readTtySetup(
  input: ReadHiddenLineOptions['input'],
  output: ReadHiddenLineOptions['output'],
  needProject: boolean,
  needKey: boolean,
): Promise<TtySetupAnswers> {
  return new Promise((resolve, reject) => {
    const answers: TtySetupAnswers = {};
    let phase: 'project' | 'key' = needProject ? 'project' : 'key';
    let buffer = '';
    let settled = false;
    let previousWasCarriageReturn = false;

    const cleanup = () => {
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', onError);
      input.setRawMode?.(false);
      input.pause?.();
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      output.write('\n');
      resolve(answers);
    };
    const completeLine = () => {
      if (phase === 'project') {
        answers.project = buffer;
        buffer = '';
        output.write('\n');
        if (needKey) {
          phase = 'key';
          output.write('Paste your Kinjot API key (input hidden): ');
        } else {
          finish();
        }
      } else {
        answers.key = buffer.replace(/[^A-Za-z0-9_]/g, '');
        finish();
      }
    };
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const ch of text) {
        if (settled) return;
        if (ch === '\n' && previousWasCarriageReturn) {
          previousWasCarriageReturn = false;
          continue;
        }
        previousWasCarriageReturn = ch === '\r';
        if (ch === '\x03') {
          settled = true;
          cleanup();
          output.write('\n');
          reject(new Error('input cancelled'));
          return;
        }
        if (ch === '\r' || ch === '\n' || ch === '\x04') {
          completeLine();
          continue;
        }
        if (ch === '\x7f' || ch === '\x08') {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            if (phase === 'project') output.write('\b \b');
          }
          continue;
        }
        buffer += ch;
        if (phase === 'project') output.write(ch);
      }
    };
    const onEnd = () => {
      if (buffer !== '') completeLine();
      if (!settled) finish();
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      output.write('\n');
      reject(error);
    };

    output.write(
      needProject ? 'Supabase project ref or URL: ' : 'Paste your Kinjot API key (input hidden): ',
    );
    input.setRawMode?.(true);
    input.resume?.();
    input.on('data', onData);
    input.on('end', onEnd);
    input.on('error', onError);
  });
}

export async function runInitSelfHost(deps: RunSelfHostDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  const flags = deps.flags ?? new Map();
  const stdout = deps.stdout ?? process.stdout;
  rejectUnknownFlags(flags, ['key', 'api-url']);

  const input = deps.input ?? (process.stdin as unknown as ReadHiddenLineOptions['input']);
  const isTTY = deps.isTTY ?? Boolean((input as unknown as { isTTY?: boolean }).isTTY);
  const needsProjectInput =
    !flags.has('api-url') && !env.KINJOT_API_URL?.trim() && !deps.readProject;
  const suppliedKey = flags.get('key') ?? env.KINJOT_API_KEY?.trim();
  const needsKeyInput = !suppliedKey && !deps.readHidden;
  let piped: string[] | undefined;
  if (
    !isTTY &&
    ((!flags.has('api-url') && !env.KINJOT_API_URL?.trim() && !deps.readProject) ||
      (!flags.has('key') && !env.KINJOT_API_KEY?.trim() && !deps.readHidden))
  ) {
    piped = await readPipedLines(input);
  }
  const ttyAnswers =
    isTTY && (needsProjectInput || needsKeyInput)
      ? await readTtySetup(input, deps.output ?? stdout, needsProjectInput, needsKeyInput)
      : undefined;

  let apiUrl: string;
  if (flags.has('api-url') || env.KINJOT_API_URL?.trim()) {
    apiUrl = selectedApiUrl(flags, env);
  } else {
    const project = deps.readProject
      ? await deps.readProject()
      : isTTY
        ? (ttyAnswers?.project ?? '')
        : (piped?.shift() ?? '');
    if (project.trim() === '') throw new Error('a Supabase project ref or URL is required');
    apiUrl = selfHostApiUrl(project);
  }

  const key =
    suppliedKey ||
    (deps.readHidden
      ? await deps.readHidden()
      : isTTY
        ? (ttyAnswers?.key ?? '')
        : (stdout.write('Paste your Kinjot API key (input hidden): \n'), piped?.shift() ?? ''));
  if (!API_KEY_PATTERN.test(key)) {
    throw new Error(
      'that does not look like a Kinjot key (expected kj_live_ + 43 characters) — nothing was saved.',
    );
  }

  const api = new NotesApi({ apiUrl, apiKey: key });
  stdout.write('Checking the key against the API… ');
  await api.listRecentNotes(1);
  stdout.write('ok ✔\n');
  await printKeyAccess(api, (line) => stdout.write(line));
  saveStoredAccount(key, apiUrl, configDir(env));
  stdout.write('Saved — Kinjot will use this self-hosted project automatically.\n\n');
  if (env.KINJOT_API_KEY?.trim() || env.KINJOT_API_URL?.trim()) {
    (deps.stderr ?? process.stderr).write(
      'warning: KINJOT_API_KEY or KINJOT_API_URL is set in your environment; environment values override the saved self-host configuration.\n',
    );
  }
  stdout.write('With the Claude Code CLI:\n\n');
  stdout.write(
    `claude mcp add kinjot -e KINJOT_API_KEY=${key} -e KINJOT_API_URL=${shellQuote(apiUrl)} -- npx -y kinjot\n`,
  );
  stdout.write('\nWith the Codex CLI:\n\n');
  stdout.write(
    `codex mcp add kinjot --env KINJOT_API_KEY=${key} --env KINJOT_API_URL=${shellQuote(apiUrl)} -- npx -y kinjot\n`,
  );
  stdout.write("\nOr add this to any other MCP client's JSON config (such as .mcp.json):\n\n");
  const envBlock = { KINJOT_API_KEY: key, KINJOT_API_URL: apiUrl };
  stdout.write(
    `${JSON.stringify({ mcpServers: { kinjot: { command: 'npx', args: ['-y', 'kinjot'], env: envBlock } } }, null, 2)}\n`,
  );
}

/**
 * `kinjot use local|account` — §5.4's persisted rung.
 *
 * Writes `mode` into the existing config. Mode-only and hosted configs remain
 * v1; an existing fail-closed endpoint/key pair remains v2.
 */
function runUse(positional: string[], env: NodeJS.ProcessEnv): void {
  const wanted = positional[0];
  if (wanted !== 'local' && wanted !== 'account') {
    throw new UsageError('usage: kinjot use local|account');
  }
  const mode: KinjotMode = wanted;
  const dir = configDir(env);
  saveStoredMode(mode, dir);
  console.log(
    mode === 'local'
      ? "Saved — jots from this machine now go to the desktop app's local library. Run `kinjot where` to see which file."
      : 'Saved — jots from this machine now go to your Kinjot account.',
  );
  if (mode === 'local' && !pointerExists(dir)) {
    // The choice is recorded either way — the pointer appears on the next
    // desktop launch — but saying "Saved" alone would read as "working".
    console.log(
      'Note: no local library exists here yet — run the Kinjot desktop app once to create it.',
    );
  }
}

/**
 * `kinjot where` — required by §5.4, because mode selection that cannot be
 * inspected gets mis-diagnosed as data loss.
 *
 * It prints the resolved target *and* the rung that decided, and it reports
 * problems instead of raising them: this is the command someone runs when
 * something is already wrong, so an ambiguous machine and a dangling library
 * both have to print their explanation rather than a stack of one line.
 */
export function runWhere(env: NodeJS.ProcessEnv): void {
  let resolution;
  try {
    resolution = resolveMode(env);
  } catch (error) {
    console.log(`mode:   unresolved`);
    console.log(`why:    ${terminalSafe(error instanceof Error ? error.message : String(error))}`);
    process.exitCode = 1;
    return;
  }

  console.log(`mode:   ${resolution.mode}`);
  console.log(`why:    ${terminalSafe(resolution.why)}`);
  console.log(`config: ${configDir(env)}`);

  if (resolution.mode === 'account') {
    try {
      console.log(
        `target: ${terminalSafe(resolveConfig(env, () => loadStoredConfig(configDir(env))).apiUrl)}`,
      );
    } catch (error) {
      console.log(`target: unavailable`);
      console.log(
        `error:  ${terminalSafe(error instanceof Error ? error.message : String(error))}`,
      );
      process.exitCode = 1;
    }
    return;
  }

  console.log(`pointer: ${pointerPath(resolution.dir)}`);
  try {
    const library = openLocalLibrary(resolution.dir);
    try {
      // db_path and the workspace id come from the pointer file and the
      // library's own meta row — file-controlled strings, same posture as
      // note fields: strip on display, never on store.
      console.log(`target: ${terminalSafe(library.path)}`);
      console.log(
        `library: workspace ${terminalSafe(library.workspaceId)}, schema version ${library.schemaVersion}`,
      );
    } finally {
      library.close();
    }
  } catch (error) {
    console.log(`target: unavailable`);
    console.log(`error:  ${terminalSafe(error instanceof Error ? error.message : String(error))}`);
    process.exitCode = 1;
  }
}

export interface RunKeyDeps {
  env?: NodeJS.ProcessEnv;
  flags?: ReadonlyMap<string, string>;
  // Bypasses the real prompt entirely — used by orchestration tests that
  // don't want to drive stream mechanics (those live in prompt.test.ts).
  readHidden?: () => Promise<string>;
  input?: ReadHiddenLineOptions['input'];
  output?: ReadHiddenLineOptions['output'];
  isTTY?: boolean;
  stdout?: { write: (chunk: string) => unknown };
  stderr?: { write: (chunk: string) => unknown };
}

export async function runKey(deps: RunKeyDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;

  const readHidden =
    deps.readHidden ??
    (() => {
      const input = deps.input ?? (process.stdin as unknown as ReadHiddenLineOptions['input']);
      return readHiddenLine({
        input,
        output: deps.output ?? stdout,
        isTTY: deps.isTTY ?? Boolean((input as unknown as { isTTY?: boolean }).isTTY),
        prompt: 'Paste your Kinjot API key (input hidden): ',
      });
    });

  rejectUnknownFlags(deps.flags ?? new Map(), ['api-url']);
  const key = await readHidden();
  if (!API_KEY_PATTERN.test(key)) {
    throw new Error(
      'that does not look like a Kinjot key (expected kj_live_ + 43 characters) — nothing was saved.',
    );
  }

  const apiUrl = selectedApiUrl(deps.flags ?? new Map(), env);
  const api = new NotesApi({ apiUrl, apiKey: key });

  stdout.write('Checking the key against the API… ');
  await api.listRecentNotes(1);
  stdout.write('ok ✔\n\n');
  await printKeyAccess(api, (line) => stdout.write(line));

  if (apiUrl === DEFAULT_API_URL) saveStoredKey(key, configDir(env));
  else saveStoredAccount(key, apiUrl, configDir(env));

  if (env.KINJOT_API_KEY?.trim()) {
    stderr.write(
      'warning: KINJOT_API_KEY is set in your environment; it will override the stored key until you unset it.\n',
    );
  }

  stdout.write(
    apiUrl === DEFAULT_API_URL
      ? 'Saved — Kinjot will use this key automatically from now on, no env var needed.\n\n'
      : 'Saved — Kinjot will use this key and custom endpoint automatically.\n\n',
  );
  const claudeApiUrl = apiUrl === DEFAULT_API_URL ? '' : ` -e KINJOT_API_URL=${shellQuote(apiUrl)}`;
  const codexApiUrl =
    apiUrl === DEFAULT_API_URL ? '' : ` --env KINJOT_API_URL=${shellQuote(apiUrl)}`;
  stdout.write('With the Claude Code CLI:\n\n');
  stdout.write(`claude mcp add kinjot${claudeApiUrl} -- npx -y kinjot\n`);
  stdout.write('\nWith the Codex CLI:\n\n');
  stdout.write(`codex mcp add kinjot${codexApiUrl} -- npx -y kinjot\n`);
  stdout.write("\nOr add this to any other MCP client's JSON config (such as .mcp.json):\n\n");
  const envBlock = apiUrl === DEFAULT_API_URL ? undefined : { KINJOT_API_URL: apiUrl };
  stdout.write(
    `${JSON.stringify({ mcpServers: { kinjot: { command: 'npx', args: ['-y', 'kinjot'], ...(envBlock ? { env: envBlock } : {}) } } }, null, 2)}\n`,
  );
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv;

  try {
    // No subcommand: an MCP host launching us pipes stdio; a human at a
    // terminal gets help.
    if (command === undefined) {
      if (process.stdin.isTTY) {
        console.log(HELP);
        return;
      }
      const [{ serveBackend }, { serveStdio }] = await Promise.all([
        import('./backend.js'),
        import('./server.js'),
      ]);
      await serveStdio(serveBackend(process.env), VERSION);
      return;
    }

    // Capture plugins put the title first, and user text may begin with --.
    // A following non-flag value still forms a flag/value pair, so flag-first
    // typos are rejected rather than mistaken for titles; so is a lone
    // flag-shaped token (`add --foldr`), which reads as a valueless flag, not
    // a one-word title.
    const titleFirst =
      (command === 'add' || command === 'notify') &&
      rest[0]?.startsWith('--') &&
      (rest.length === 1 ? !/^--[^\s=]+$/.test(rest[0]) : rest[1]!.startsWith('--')) &&
      !(command === 'add'
        ? ['--body', '--tags', '--folder', '--id'].includes(rest[0])
        : [
            '--kind',
            '--detail',
            '--pr',
            '--note',
            '--cwd',
            '--session',
            '--agent',
            '--id',
            '--input-json',
            '--json',
            '--no-cache',
          ].includes(rest[0]));
    const { positional, flags } = parseFlags(titleFirst ? rest.slice(1) : rest);
    if (titleFirst) positional.unshift(rest[0]!);
    switch (command) {
      case 'init':
        if (positional.length)
          throw new UsageError('usage: kinjot init --key <key> [--api-url <url>]');
        await runInit(flags, process.env);
        return;
      case 'init-selfhost':
        if (positional.length)
          throw new UsageError('usage: kinjot init-selfhost [--api-url <url>] [--key <key>]');
        await runInitSelfHost({ flags });
        return;
      case 'key':
        if (positional.length) throw new UsageError('usage: kinjot key [--api-url <url>]');
        await runKey({ flags });
        return;
      case 'use':
        rejectUnknownFlags(flags, []);
        if (positional.length !== 1) throw new UsageError('usage: kinjot use local|account');
        runUse(positional, process.env);
        return;
      case 'where':
        rejectUnknownFlags(flags, []);
        if (positional.length) throw new UsageError('usage: kinjot where');
        runWhere(process.env);
        return;
      case 'add': {
        rejectUnknownFlags(flags, ['body', 'tags', 'folder', 'id']);
        const title = positional[0];
        if (!title || positional.length !== 1)
          throw new UsageError(
            'usage: kinjot add <title> [--body <text>] [--tags a,b] [--folder <name>] [--id <uuid>] (body is read from stdin when piped)',
          );
        const suppliedId = flags.get('id');
        if (suppliedId !== undefined && !isUuidShapeAnyCase(suppliedId)) {
          throw new UsageError('--id must be a UUID in 8-4-4-4-12 hexadecimal form');
        }
        const id = suppliedId?.toLowerCase();
        const body = flags.get('body') ?? (process.stdin.isTTY ? '' : await readStdin());
        const api = resolveBackend(process.env).backend;
        const note = await api.saveNote({
          ...(id === undefined ? {} : { id }),
          title,
          body,
          tags: flags
            .get('tags')
            ?.split(',')
            .map((tag) => tag.trim())
            .filter(Boolean),
          folder: flags.get('folder'),
          source: 'cli',
        });
        console.log(`Jotted "${terminalSafe(note.title)}" (id ${terminalSafe(note.id)}).`);
        return;
      }
      case 'notify': {
        rejectUnknownFlags(flags, [
          'kind',
          'detail',
          'pr',
          'note',
          'cwd',
          'session',
          'agent',
          'id',
          'input-json',
          'json',
          'no-cache',
        ]);
        const inputJson = flags.has('input-json');
        if ((inputJson && positional.length) || (!inputJson && positional.length !== 1))
          throw new UsageError('usage: kinjot notify <title> --kind <kind> [--input-json]');
        let title = positional[0];
        let detail = flags.get('detail');
        if (inputJson) {
          if (flags.has('detail'))
            throw new UsageError('--detail cannot be combined with --input-json');
          let value: unknown;
          try {
            value = JSON.parse(await readStdin());
          } catch {
            throw new UsageError('--input-json needs a JSON object');
          }
          if (
            !value ||
            typeof value !== 'object' ||
            Array.isArray(value) ||
            typeof (value as { title?: unknown }).title !== 'string' ||
            ((value as { detail?: unknown }).detail !== undefined &&
              typeof (value as { detail?: unknown }).detail !== 'string')
          )
            throw new UsageError('--input-json needs {"title":string,"detail"?:string}');
          title = (value as { title: string }).title;
          detail = (value as { detail?: string }).detail;
        } else if (detail === undefined && !process.stdin.isTTY) {
          detail = (await readStdin()) || undefined;
        }
        if (!title) throw new UsageError('notify title is required');
        const kind = flags.get('kind');
        if (!kind || !['question', 'blocker', 'handoff', 'done', 'waiting'].includes(kind))
          throw new UsageError('--kind must be question, blocker, handoff, done, or waiting');
        const session = flags.get('session');
        if (session !== undefined && !/^[A-Za-z0-9_-]{1,100}$/.test(session))
          throw new UsageError('--session is invalid');
        if (kind === 'waiting' && !session)
          throw new ApiError(400, 'invalid_session', 'invalid_session');
        const agent = flags.get('agent');
        if (agent !== undefined && !/^[a-z0-9._-]{1,40}$/.test(agent))
          throw new UsageError('--agent is invalid');
        const id = flags.get('id') ?? crypto.randomUUID();
        if (!isUuidShapeAnyCase(id)) throw new UsageError('--id must be a UUID');
        const note = flags.get('note');
        if (note !== undefined && parseNoteLabel(note) === null)
          throw new UsageError('--note must be a jot label');
        const prs = rest
          .flatMap((arg, index) => (arg === '--pr' ? [rest[index + 1]!] : []))
          .filter((pr) =>
            /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/pull\/[1-9][0-9]*$/.test(pr),
          )
          .slice(0, 3);
        const { backend, resolution } = resolveBackend(process.env);
        const config = resolution.mode === 'account' ? resolveConfig(process.env) : undefined;
        const cacheDir = configDir(process.env);
        const cacheState =
          config && !flags.has('no-cache') ? cachedMuteState(cacheDir, config, kind) : 'unknown';
        let answer:
          | {
              id: string;
              status: 'sent' | 'repeated' | 'duplicate' | 'muted';
              repeat_count: number;
            }
          | undefined;
        if (cacheState === 'muted') answer = { id, status: 'muted', repeat_count: 0 };
        if (kind === 'waiting' && cacheState === 'unknown') {
          const state = await backend.inboxMuteState();
          if (config) refreshMute(cacheDir, config, state);
          if (state.key_muted || !state.send_kinds.includes(kind))
            answer = { id, status: 'muted', repeat_count: 0 };
        }
        if (!answer) {
          const sent = await backend.inboxNotify({
            id: id.toLowerCase(),
            kind: kind as 'question' | 'blocker' | 'handoff' | 'done' | 'waiting',
            title,
            ...(detail ? { detail } : {}),
            source: 'cli',
            context: {
              ...(await gitContext(flags.get('cwd') ?? process.cwd())),
              ...(agent ? { agent } : {}),
              ...(prs.length ? { prs } : {}),
              ...(note ? { note: note.replace(/^#/, '').toUpperCase() } : {}),
              ...(session ? { session_id: session } : {}),
            },
          });
          answer = sent;
          if (config) refreshMute(cacheDir, config, sent);
        }
        if (flags.has('json'))
          console.log(
            JSON.stringify({
              id: answer.id,
              status: answer.status,
              repeat_count: answer.repeat_count,
            }),
          );
        else
          console.log(
            answer.status === 'muted'
              ? 'Not sent: muted.'
              : answer.status === 'sent'
                ? `Sent to Kinjot Inbox (${answer.id.slice(0, 8)}).`
                : answer.status === 'repeated'
                  ? `Already in the Inbox; marked as repeated (${answer.id.slice(0, 8)}, ${answer.repeat_count} times).`
                  : `Already in the Inbox (${answer.id.slice(0, 8)}).`,
          );
        return;
      }
      case 'inbox': {
        if (positional[0] === 'resolve') {
          rejectUnknownFlags(flags, ['note']);
          if (
            positional.length !== 2 ||
            !/^(?:[a-fA-F0-9]{8}|[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})$/.test(
              positional[1]!,
            )
          )
            throw new UsageError(
              'usage: kinjot inbox resolve <8-character-prefix|uuid> [--note <text>]',
            );
          const resolution = flags.get('note');
          if (resolution && (Array.from(resolution).length > 200 || /[\r\n]/.test(resolution)))
            throw new UsageError('--note must be one line of at most 200 characters');
          const result = await resolveBackend(process.env).backend.inboxResolve({
            ref: positional[1]!,
            resolution,
          });
          console.log(`Resolved ${terminalSafe(result.id.slice(0, 8))}.`);
          return;
        }
        rejectUnknownFlags(flags, ['all', 'kind', 'cwd', 'json']);
        if (positional.length)
          throw new UsageError(
            'usage: kinjot inbox [--all] [--kind <kind>] [--cwd <dir>] [--json]',
          );
        const kind = flags.get('kind') ?? 'handoff';
        if (!['handoff', 'question', 'blocker', 'done', 'any'].includes(kind))
          throw new UsageError('--kind is invalid');
        const repo = flags.has('all')
          ? undefined
          : (await gitContext(flags.get('cwd') ?? process.cwd())).repo;
        const kinds =
          kind === 'any'
            ? (['question', 'blocker', 'handoff', 'done'] as const)
            : [kind as 'handoff' | 'question' | 'blocker' | 'done'];
        const result = await resolveBackend(process.env).backend.inboxList({
          repo,
          kinds: [...kinds],
          limit: 10,
        });
        if (flags.has('json')) console.log(terminalSafeJson(result));
        else {
          if (!repo && !flags.has('all'))
            console.log('Repository could not be detected; showing all repositories.');
          for (const item of result.items.slice(0, 10)) {
            console.log(
              `${terminalSafe(item.id)}  ${terminalSafe(item.kind.toUpperCase())}  ${terminalSafe(item.title)}`,
            );
            // Every detail line is indented, so a multi-line detail cannot
            // print a line that reads as another Inbox item.
            if (item.detail)
              console.log(`  ${terminalSafeBody(item.detail).replace(/\n/g, '\n  ')}`);
          }
          if (result.other_open > 0)
            console.log(
              `${result.other_open} other open Inbox item${result.other_open === 1 ? '' : 's'}.`,
            );
        }
        return;
      }
      case 'append': {
        rejectUnknownFlags(flags, ['text', 'no-snapshot']);
        const id = positional[0];
        if (!id || positional.length !== 1)
          throw new UsageError(
            'usage: kinjot append <label|id-prefix|uuid> [--text <text>] [--no-snapshot]',
          );
        const text = flags.get('text') ?? (process.stdin.isTTY ? '' : await readStdin());
        const textError = appendTextUsageError(text);
        if (textError) throw new UsageError(textError);
        const note = await resolveBackend(process.env).backend.appendNote({
          id,
          text,
          ...(flags.has('no-snapshot') ? { snapshot: false } : {}),
          source: 'cli',
        });
        console.log(`Appended to ${terminalSafe(noteHandle(note))} "${terminalSafe(note.title)}".`);
        if (flags.has('no-snapshot') && note.snapshot_skipped !== true) process.exitCode = 5;
        return;
      }
      case 'upload-image': {
        rejectUnknownFlags(flags, ['alt', 'json']);
        const path = positional[0];
        if (!path || positional.length !== 1)
          throw new UsageError('usage: kinjot upload-image <path> [--alt <text>] [--json]');
        const image = await resolveBackend(process.env).backend.uploadImage({
          path,
          alt: flags.get('alt'),
        });
        if (flags.has('json')) {
          console.log(terminalSafeJson(image));
        } else {
          console.log(terminalSafe(image.markdown));
        }
        console.error(
          `uploaded ${terminalSafe(image.path)} (${image.bytes} bytes, ${image.width}×${image.height})`,
        );
        return;
      }
      case 'search': {
        rejectUnknownFlags(flags, []);
        const query = positional.join(' ').trim();
        if (!query) throw new UsageError('usage: kinjot search <query>');
        printSearch(await resolveBackend(process.env).backend.searchNotes(query), query);
        return;
      }
      case 'recall': {
        rejectUnknownFlags(flags, []);
        const query = positional.join(' ').trim();
        if (!query) throw new UsageError('usage: kinjot recall <query>');
        printRecall(await resolveBackend(process.env).backend.recallNotes(query), query);
        return;
      }
      case 'get': {
        rejectUnknownFlags(flags, ['json']);
        const id = positional[0];
        if (!id || positional.length !== 1)
          throw new UsageError('usage: kinjot get <label|id-prefix|uuid> [--json]');
        const note = await resolveBackend(process.env).backend.getNote(id);
        if (flags.has('json')) {
          console.log(terminalSafeJson(note));
          return;
        }
        const tags = note.tags.map(terminalSafe).join(', ') || 'none';
        console.log(
          `${noteHandle(note)}  ${terminalSafe(note.title) || '(untitled)'}  [${tags}]  (updated ${note.updated_at.slice(0, 10)})`,
        );
        console.log('');
        console.log(terminalSafeBody(note.body));
        return;
      }
      case 'recent': {
        rejectUnknownFlags(flags, []);
        if (positional.length > 1) throw new UsageError('usage: kinjot recent [n]');
        const limit = positional[0] ? Number.parseInt(positional[0], 10) : 10;
        if (Number.isNaN(limit)) throw new UsageError('usage: kinjot recent [n]');
        (await resolveBackend(process.env).backend.listRecentNotes(limit)).forEach(printHit);
        return;
      }
      case 'help':
      case '--help':
      case '-h':
        // `kinjot help add` and the like still print the help.
        console.log(HELP);
        return;
      // This is the same package version the MCP handshake reports.
      case 'version':
      case '--version':
      case '-v':
        rejectUnknownFlags(flags, []);
        if (positional.length) throw new UsageError('usage: kinjot --version');
        console.log(VERSION);
        return;
      default:
        throw new UsageError(`unknown command "${command}" — run kinjot help`);
    }
  } catch (error) {
    const message =
      error instanceof ApiError || error instanceof Error ? error.message : String(error);
    // Error messages interpolate pointer- and server-derived strings
    // (db_path, API error bodies) — the same smuggling surface as a title.
    console.error(`error: ${terminalSafe(message)}`);
    process.exitCode =
      error instanceof UsageError
        ? 2
        : error instanceof ApiError &&
            (error.status === 401 ||
              error.status === 429 ||
              (error.status >= 500 && error.status <= 599))
          ? 1
          : error instanceof LocalUnavailableError ||
              (error instanceof ApiError &&
                (error.kind === 'unsupported_action' || error.kind === 'key_access'))
            ? 4
            : error instanceof ApiError && error.kind === 'inbox_item_not_found'
              ? 3
              : error instanceof ApiError &&
                  error.kind !== undefined &&
                  DEFINITE_INBOX_REFUSALS.has(error.kind)
                ? 2
                : error instanceof ApiError &&
                    error.status === 404 &&
                    error.message === 'note not found'
                  ? 3
                  : 1;
  }
}
