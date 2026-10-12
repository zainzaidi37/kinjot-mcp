<!-- @generated — DO NOT EDIT. -->

# Vendored `@kinjot/core`

Every file in this directory is a generated copy of a module from
`packages/core/src` in the private kinjot repository, emitted by
`pnpm --filter @kinjot/core emit:mcp-core` and checked in so that
`packages/mcp` stays a self-contained, publishable package with no workspace
dependency. CI re-runs the generator and fails on any difference, so editing
anything here is always the wrong fix: change the source module instead.

The emitted set is the transitive closure of relative imports from core's public
barrel (`index.ts`) — tests and test-only modules are reached by nothing and so
are never vendored. This set, including the `fixtures/local-pointer/` copy, is
allow-listed in `packages/core/scripts/mcp-vendor-allowlist.json`. The generator
refuses unlisted files and stale entries before writing. Listing a file publishes
it as MIT-licensed, readable source in the public repo `zainzaidi37/kinjot-mcp`,
so additions require a reviewed decision. The synthesized README is excluded
from the list. See `plans/desktop-app.md` §4.5 for the decision.
