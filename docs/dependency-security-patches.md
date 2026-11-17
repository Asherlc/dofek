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
Other audit findings retain their existing enforcement except for the explicit
picomatch risk acceptance below. The regression
command fails if the installed vulnerable behavior returns; patch application
failures also fail installation under [pnpm v11](https://pnpm.io/cli/patch#allowunusedpatches).

When adopting published upstream fixes, verify the regressions against those
releases and remove the corresponding patch and advisory exception together.

## Accepted picomatch advisory exception

On November 17, 2026, the user explicitly accepted
[GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)
without a dependency patch. Only this advisory is added to pnpm's
[`audit.ignore`](https://pnpm.io/11.x/cli/audit#auditignore) list; unrelated audit
findings and the existing dependency-security checks remain enforced.

The rationale is to unblock CI and the canonical production release while no
fixed release is published. The advisory lists picomatch through 4.0.7 as
affected and no patched release at the time of acceptance. The installed
production dependency inventory (`pnpm why picomatch --prod --recursive --depth 0
--json`) contains **2.3.2 and 4.0.7**. Both remain unpatched. The proposed
[v2 backport](https://github.com/micromatch/picomatch/pull/246) and
[v4 fix](https://github.com/micromatch/picomatch/pull/237) were rejected locally
because bounded probes still timed out on single-branch repeated-extglob
variants; the v4 proposal also changed matching and capture behavior.

**Remaining risk:** Attacker-controlled glob patterns and matching input can
cause catastrophic regular-expression backtracking, blocking the calling
process and causing denial of service. Local probes reproduced this behavior
in both production versions. This exception suppresses the advisory report;
it does not fix or mitigate the vulnerability. Reachability from externally
supplied application input has not been established, so this is not a claim
that production is unexposed. Passing audit with the exception is not proof
that picomatch is safe.

Revisit this exception when a fixed upstream release becomes available. Upgrade
every affected production dependency path, verify the reported exploit and
matching compatibility, and remove this advisory from `audit.ignore` together
with that upgrade. No local picomatch patch or security-regression gate is
retained for this accepted risk.

## Published node-forge security release

The workspace pins node-forge to 1.4.2. Its [upstream changelog](https://github.com/digitalbazaar/forge/blob/v1.4.2/CHANGELOG.md)
documents the RSA DigestAlgorithm correction previously backported here, plus
the PEM, TLS, PKCS#12 and certificate-validation security fixes. Version 1.4.2
also restores PEM Buffer-input compatibility after the 1.4.1 security correction.
The superseded 1.4.0 patch and signature-advisory exception are removed together;
`check-node-forge-security.ts` still exercises the installed Expo signing dependency.

## Expo schema compatibility and Zod security

The application pins Zod to 4.6.7. Earlier Expo CLI releases required a scoped
override for Zod 3's [collection validation advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).
Expo CLI 58.1.18 no longer declares that direct dependency
([upstream manifest](https://github.com/expo/expo/blob/main/packages/%40expo/cli/package.json)),
so the obsolete scoped override was removed.
The [upstream fix](https://github.com/colinhacks/zod/commit/a0ebf97)
rejects oversized constrained collections before parsing their elements.

`pnpm check:dependency-security` exercises that behavior with the application's
installed Zod and supplies it to Expo's [MCP command-schema constructor](https://github.com/expo/expo/blob/main/packages/%40expo/cli/src/start/server/mcp/createMCPDevToolsExtensionSchema.ts).
Plugin descriptors and command output use Expo's JSON schemas and its
`@expo/schema-utils` validator, matching the [native CLI consumer](https://github.com/expo/expo/blob/main/packages/%40expo/cli/src/start/server/devtools/DevToolsPlugin.ts).
The same valid/invalid fixtures still cover descriptors, command inputs,
output URLs and early rejection of oversized constrained arrays. No audit
exception is added. Review these checks when updating Expo's schema consumers.
