# Dependency security patches

The braces dependency currently requires a checked-in fix because its published
release remains affected. Its original package version is retained; pnpm
applies the source patch during installation using
[`patchedDependencies`](https://pnpm.io/cli/patch#patcheddependencies).

| Package | Advisory | Backported source |
| --- | --- | --- |
| `braces@3.0.3` | [Recursive traversal](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | [braces PR #72 at d0d575e](https://github.com/micromatch/braces/pull/72/commits/d0d575e55e74a4e0218e5248fafb79efc3e54ebb) |

The braces patch bounds parsed brace
and parenthesis nesting and directly supplied AST traversal to 100 levels.
The patch contains the upstream runtime changes from the commit above.

Run `pnpm check:dependency-security` to exercise the installed packages through
their Expo and Metro consumers. The forge regression checks malformed signed
DigestInfo structures and valid SHA-256 signatures with and without optional
NULL parameters. The braces regression checks excessive brace/parenthesis
nesting, direct AST inputs, limit overrides, and ordinary compile/expand behavior.
Both checks failed before patching and passed afterward; the forge check is now
retained against the published upstream fix described below.

The Dependency Audit CI job runs these regressions before `pnpm audit`;
the braces advisory above is excluded from its version-based report, with
explicit approval, because the patched package retains an affected version number.
All other audit findings retain their existing enforcement. The regression
command fails if the installed vulnerable behavior returns; patch application
failures also fail installation under [pnpm v11](https://pnpm.io/cli/patch#allowunusedpatches).

When adopting published upstream fixes, verify the regressions against those
releases and remove the corresponding patch and advisory exception together.

## Published node-forge security release

The workspace pins node-forge to 1.4.2. Its [upstream changelog](https://github.com/digitalbazaar/forge/blob/v1.4.2/CHANGELOG.md)
documents the RSA DigestAlgorithm correction previously backported here, plus
the PEM, TLS, PKCS#12 and certificate-validation security fixes. Version 1.4.2
also restores PEM Buffer-input compatibility after the 1.4.1 security correction.
The superseded 1.4.0 patch and signature-advisory exception are removed together;
`check-node-forge-security.ts` still exercises the installed Expo signing dependency.

## Expo CLI schema compatibility

Expo CLI 58.1.18 removes its Zod dependency, validates plugin descriptors and
output through `@expo/schema-utils`, and accepts the MCP caller's Zod instance
for command-input schemas ([upstream change](https://github.com/expo/expo/commit/31450487b140c8bee92b0aaf753c123b54fdec0c)).
The former CLI-specific override is removed. The application supplies its pinned
Zod 4.6.7 to the command-schema compatibility check. This version includes the
[upstream collection-validation fix](https://github.com/colinhacks/zod/commit/a0ebf97)
that rejects oversized constrained collections before parsing their elements.

`pnpm check:dependency-security` exercises that collection behavior and checks
the installed CLI's plugin descriptor, command-input, and command-output schemas
with valid and invalid inputs through their current validators. This correction
adds no audit exception. Review these checks when updating Expo CLI's schema
consumers.
