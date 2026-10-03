import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HELP } from './cli.js';

describe('the installed command names', () => {
  it('installs the CLI as kinjot and as the short alias kj, one entry point', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      bin: Record<string, string>;
    };
    expect(pkg.bin).toEqual({ kinjot: 'dist/main.js', kj: 'dist/main.js' });
  });

  it('tells a terminal user the short name exists', () => {
    expect(HELP).toContain('also answers to the short name kj (kj search <query>)');
  });
});
