import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `server.json` is the MCP registry's manifest for this package, and it
 * restates facts that already live in package.json — the version, twice, and
 * the npm identifier.
 *
 * The registry rejects a `packages[].version` that does not match the
 * version on npm. Pinning the declarations here catches a mismatched bump
 * before publication.
 *
 * `mcpName` is the field npm exposes for the registry's ownership check, so it
 * has to equal the manifest's `name` or the listing cannot be verified at all.
 */
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const read = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(packageRoot, name), 'utf8')) as Record<string, unknown>;

describe('server.json agrees with package.json', () => {
  const pkg = read('package.json');
  const manifest = read('server.json');
  const packages = manifest.packages as { identifier: string; version: string }[];

  it('declares the package version in both places the registry reads', () => {
    expect(manifest.version).toBe(pkg.version);
    expect(packages).toHaveLength(1);
    expect(packages[0]?.version).toBe(pkg.version);
  });

  it('names the same npm package the registry will verify ownership of', () => {
    expect(packages[0]?.identifier).toBe(pkg.name);
    expect(manifest.mcpName ?? pkg.mcpName).toBe(manifest.name);
  });

  it('ships the manifest in the published tarball', () => {
    // Outside `files`, the manifest exists in git and is absent from the npm
    // package — which is the one copy the registry actually fetches.
    expect(pkg.files as string[]).toContain('server.json');
  });
});
