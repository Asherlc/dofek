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

## Expo CLI Zod override

The workspace pins Expo CLI's Zod dependency to 4.6.7, the same release used by
the application. Expo CLI 58.1.14 still declares Zod 3
([upstream manifest](https://github.com/expo/expo/blob/main/packages/%40expo/cli/package.json)),
which is covered by the [collection validation advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).
The [upstream fix](https://github.com/colinhacks/zod/commit/a0ebf97)
rejects oversized constrained collections before parsing their elements.

`pnpm check:dependency-security` exercises that behavior through Expo CLI's
installed dependency and checks its plugin descriptor, command-input, and
command-output schemas with valid and invalid inputs. The security assertion
failed with Expo's original Zod 3 dependency and passes with the scoped override.
This correction adds no audit exception. Review the override and these checks
together when updating Expo CLI's schema consumers.
