import { readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The package ships from src/ alone, to npm and to the public mirror, and the
// mirror has no packages/core or any other workspace path to resolve against.
// So no module or test may reach outside packages/mcp. The vendored copy in
// src/core is the only sanctioned route to core. #741's tests once imported
// core's fixtures directly: CI stayed green, and the mirror's typecheck would
// have failed.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Literal paths (including import/URL specifiers), plus join/resolve calls
// whose arguments are all literal segments. This deliberately stays a static
// scan: computed values, aliases and dynamic template expressions need review.
const STRING_LITERAL = /(['"`])((?:\\.|(?!\1)[^\\])*?)\1/g;
const LITERAL_JOIN = /\b(?:join|resolve)\(\s*((?:['"][^'"]*['"]\s*,?\s*)+)\)/g;
// Every match contains a path separator, so a bare word such as "supabase" or
// "scripts" (a provider name, a CLI argument) is not a path.
const WORKSPACE_PATH =
  /(?:^|\/)(?:(?:packages\/(?!mcp(?:\/|$))|apps\/)[^/]+|(?:scripts|supabase|workers)\/)/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:[cm]?ts|[cm]?js)$/.test(entry.name) ? [path] : [];
  });
}

export function escapingReferences(files: { path: string; source: string }[]): string[] {
  const escapes = new Set<string>();
  for (const { path, source } of files) {
    // Preserve quoted strings while removing comments, whose documentation
    // often cites private source paths without reading them.
    const code = source.replace(
      /(['"`])(?:\\.|(?!\1)[^\\])*?\1|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
      (match) => (match.startsWith('/') ? ' ' : match),
    );
    const literals = [...code.matchAll(STRING_LITERAL)].map((match) => match[2] ?? '');
    const joins = [...code.matchAll(LITERAL_JOIN)].map((match) =>
      [...(match[1] ?? '').matchAll(STRING_LITERAL)].map((part) => part[2] ?? '').join('/'),
    );
    for (const specifier of [...literals, ...joins]) {
      const normalized = specifier.replace(/\\\\/g, '/');
      const target = resolve(dirname(path), normalized);
      const rel = relative(packageRoot, target);
      const escapesRelative =
        /^(?:\.\.?\/)/.test(normalized) &&
        (rel === '..' ||
          rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
          isAbsolute(rel));
      if (WORKSPACE_PATH.test(normalized) || escapesRelative) {
        escapes.add(`${relative(packageRoot, path)}: ${specifier}`);
      }
    }
  }
  return [...escapes];
}

describe('package boundary', () => {
  it('no source or test file references a path outside packages/mcp', () => {
    // This file is skipped: its detector cases below are escaping specifiers
    // written as data.
    const self = fileURLToPath(import.meta.url);
    const files = sourceFiles(join(packageRoot, 'src'))
      .filter((path) => path !== self)
      .map((path) => ({ path, source: readFileSync(path, 'utf8') }));
    expect(files.length).toBeGreaterThan(20);
    expect(escapingReferences(files)).toEqual([]);
  });

  // The detector itself, so a regex that silently matches nothing cannot pass.
  it.each([
    [`import { png } from '../../core/src/image-bytes-fixtures.js';`],
    [`export * from '../../core/src/index.js';`],
    [`const m = await import('../../../scripts/x.mjs');`],
    [`vi.mock('../../core/src/index.js', () => ({}));`],
    [`readFileSync(new URL('../../../docs/x.md', import.meta.url));`],
    [`import '../../core/src/side-effect.js';`],
    [`readFileSync('packages/core/fixtures/local-pointer/v1.json');`],
    [`readFileSync('../../../docs/x.md');`],
    [`readFileSync(join('..', '..', 'packages', 'core', 'x.json'));`],
    [`const fixture = join('packages', 'core', 'fixtures', 'x.json');`],
    [`readFileSync(resolve('..', '..', '..', 'apps', 'web', 'x.json'));`],
    [`readFileSync('packages/core/x.json');`],
  ])('flags %s', (source) => {
    expect(escapingReferences([{ path: join(packageRoot, 'src', 'x.ts'), source }])).toHaveLength(
      1,
    );
  });

  it.each([
    [`import { x } from './core/index.js';`],
    [`import { y } from '../local/pointer.js';`],
    [`readFileSync(new URL('../README.md', import.meta.url));`],
    [`const provider = 'supabase';`],
    [`run(['scripts', "workers", 'apps', 'packages']);`],
  ])('allows %s', (source) => {
    const path = join(packageRoot, 'src', 'local', 'x.ts');
    expect(escapingReferences([{ path, source }])).toEqual([]);
  });
});
