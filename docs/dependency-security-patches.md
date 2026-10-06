# Dependency security patches

Two dependencies currently require checked-in fixes because their published
releases remain affected. The original package versions are retained; pnpm
applies the source patches during installation using
[`patchedDependencies`](https://pnpm.io/cli/patch#patcheddependencies).

| Package | Advisory | Backported source |
| --- | --- | --- |
| `node-forge@1.4.0` | [Signature verification](https://github.com/advisories/GHSA-86w9-cpqp-85rv) | [forge PR #1152 at ceba344](https://github.com/digitalbazaar/forge/pull/1152/commits/ceba34402e329f0365134f23fe19898756527d65) |
| `braces@3.0.3` | [Recursive traversal](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | [braces PR #72 at d0d575e](https://github.com/micromatch/braces/pull/72/commits/d0d575e55e74a4e0218e5248fafb79efc3e54ebb) |

The forge patch rejects extra elements inside the nested DigestAlgorithm
sequence during signature verification. The braces patch bounds parsed brace
and parenthesis nesting and directly supplied AST traversal to 100 levels.
Both patches contain the upstream runtime changes from the commits above.

Run `pnpm check:dependency-security` to exercise the installed packages through
their Expo and Metro consumers. The forge regression checks malformed signed
DigestInfo structures and valid SHA-256 signatures with and without optional
NULL parameters. The braces regression checks excessive brace/parenthesis
nesting, direct AST inputs, limit overrides, and ordinary compile/expand behavior.
Both checks failed before patching and passed afterward.

The Dependency Audit CI job runs these regressions before `pnpm audit`. Only
the two advisory IDs above are excluded from its version-based report, with
explicit approval, because the patched packages retain affected version numbers.
All other audit findings retain their existing enforcement. The regression
command fails if the installed vulnerable behavior returns; patch application
failures also fail installation under [pnpm v11](https://pnpm.io/cli/patch#allowunusedpatches).

When adopting published upstream fixes, verify the regressions against those
releases and remove the corresponding patch and advisory exception together.
