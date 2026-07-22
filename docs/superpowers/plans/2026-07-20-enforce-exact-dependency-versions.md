# Enforce Exact Dependency Versions TDD Plan

**Goal:** Make every workspace dependency declaration follow the repository's exact-version policy and enforce it in local lint and CI.

**Behavior:** Any caret or tilde dependency range in a tracked workspace `package.json` causes the required policy gate to fail.

**Scope:** Repair and wire the existing exact-version checker and pin the five current violations. Do not alter `workspace:` protocol references or update unrelated dependencies.

**Docs:** [`AGENTS.md`](../../../AGENTS.md), [`scripts/README.md`](../../../scripts/README.md)

---

## Current Evidence

- `scripts/exact-versions.sh` says it runs as part of `pnpm lint`, but the root `lint` script and `.github/workflows/test.yml` do not invoke it.
- `rtk bash scripts/exact-versions.sh` exits 1 for three Expo dependencies in `packages/mobile/package.json` and two Zepp dependencies in `packages/zepp/package.json`.
- A normal `rtk pnpm lint` passes despite those violations, so the documented policy is not enforced.

## Test Strategy

- Unit: test a TypeScript checker with exact, caret, tilde, and `workspace:` dependency fixtures across `dependencies`, `devDependencies`, `peerDependencies`, and `optionalDependencies`.
- Integration: run the checker against the repository and prove a temporary ranged dependency produces a non-zero status.
- UI/mobile/web parity: not applicable; all workspace package manifests are in scope.

## File Structure

- Replace: `scripts/exact-versions.sh` with a TypeScript script - make the repository policy deterministic and testable through fixture-backed unit tests.
- Create/modify: colocated script tests - cover accepted and rejected version forms.
- Modify: `packages/mobile/package.json` and `packages/zepp/package.json` - pin current ranged declarations to their existing resolved versions.
- Modify: `package.json` and `.github/workflows/test.yml` - wire one canonical check into local lint and CI.

## Tasks

### Task 1: Add Failing Tests

- [ ] Write failing caret/tilde and passing exact/`workspace:` fixtures for each of `dependencies`, `devDependencies`, `peerDependencies`, and `optionalDependencies`.
- [ ] Run `rtk pnpm vitest run --project unit <test-path>`.
- [ ] Confirm the tests fail against the current checker behavior or missing integration.

### Task 2: Implement the Minimal Fix

- [ ] Implement one testable exact-version checker for every workspace manifest.
- [ ] Pin the five current range declarations to their lockfile-resolved versions.
- [ ] Wire the checker into `pnpm lint` and the required CI lint job.
- [ ] Run the focused tests and `rtk pnpm lint`.

### Task 3: Final Verification

- [ ] Run the canonical checker with `rtk pnpm tsx scripts/exact-versions.ts` and confirm exit 0.
- [ ] Run `rtk pnpm install --frozen-lockfile`, `rtk pnpm typecheck`, and affected package tests/builds.
- [ ] Verify the required CI gate cannot pass when the checker fails.
- [ ] Record a short retrospective covering root cause, direct fix, validation evidence, and a concrete `AGENTS.md`, `scripts/README.md`, or skill improvement for future policy-check work.
