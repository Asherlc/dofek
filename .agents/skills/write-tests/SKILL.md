---
name: write-tests
description: Write tests for changed or untested behavior, choosing unit, mobile, or real-database integration tests to match the implementation.
---

# Write Tests

Read the [test policy](../../../docs/testing.md#test-policy) and nearby tests
before editing. Preserve its approved exceptions, test separation, and
production API boundaries.

## Scope and evidence

Use the requested file, function, or behavior. Otherwise inspect the current
branch's diff against `origin/main`:

```bash
rtk git branch --show-current
rtk git status --short
rtk git diff origin/main...HEAD --name-only
```

Identify changed behavior that lacks coverage, including previously untested
code being modified. For a feature or bug fix, write a regression test first
and observe it fail for the expected reason before implementation.
Do not add tests for deleted features or declarative configuration; use the
policy's schema, link, or diff checks instead. Preserve the standing
transitional-code testing exception.

## Choose the boundary

- Pure logic and public UI behavior: focused colocated unit/mobile tests.
- SQL execution, dbt semantics, and database-dependent API behavior: integration
  tests against the real engine with minimal fixtures.
- Third-party services in integration tests: network-level MSW mocks, not
  module mocks or injected fetch replacements. Keep the specifically approved
  PowerSync exception scoped to its named suite.

Match a nearby maintained test. Test through production public interfaces;
do not export helpers solely for tests or add test-only production branches.
For chart behavior, test an existing public builder only when it has a
production consumer; otherwise exercise the component's public behavior.

## Run and verify

Run from the repository root, replacing example paths with the changed tests:

```bash
# Focused unit test
rtk pnpm test:unit src/example.test.ts

# Focused mobile test
rtk pnpm test:mobile packages/mobile/example.test.tsx

# Real-database test; the wrapper starts dependencies and supplies URLs
rtk pnpm test:integration -- src/example.integration.test.ts
```

Use `rtk pnpm test run` for the full Docker-free unit/mobile tier and the
[explicit integration tiers](../../../docs/testing.md#integration-dependencies)
when database behavior is involved. Follow the repository's pre-push policy
for lint/typechecks and the broader regression scope. Do not use the unit/mobile
`pnpm test` command to run an integration file. For the direct unit/mobile
scripts, place file paths directly after the script name; an extra `--` before
the paths is not a reliable Vitest file filter.

Confirm boundary/formula expectations independently, inspect failures, and
report the commands and results. Commit tests separately when practical,
without leaving the branch in an unverified state.
