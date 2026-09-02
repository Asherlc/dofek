# Enforce the Suppression Ban TDD Plan

**Goal:** Make CI enforce the repository-wide ban on lint, type-check, coverage, and mutation-test suppression comments.

**Behavior:** A tracked TypeScript suppression causes the normal lint/CI gate to fail, while generated files and the suppression-removal utility remain explicitly excluded.

**Scope:** Repair and wire the existing suppression checker, remove or replace current suppressions, and cover all tracked TypeScript source locations. Do not weaken the policy or add blanket exclusions.

**Docs:** [`AGENTS.md`](../../../AGENTS.md), [`scripts/README.md`](../../../scripts/README.md)

---

## Current Evidence

- `scripts/no-suppressions.sh` says it runs as a policy check, but neither the root `lint` script nor `.github/workflows/test.yml` invokes it.
- `rtk bash scripts/no-suppressions.sh` exits 1 on tracked `biome-ignore` and `Stryker disable` comments.
- Its file discovery omits TypeScript outside `src/` trees, including `packages/mobile/app/`, `packages/mobile/components/`, and Zepp application files.

## Test Strategy

- Unit: extract the tracked-file matching logic into a TypeScript repository script. Add forbidden fixtures for TypeScript (`@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`), Biome/ESLint (`biome-ignore`, `eslint-disable`), coverage (`c8 ignore`, `istanbul ignore`), and Stryker (`Stryker disable`) categories. Add allowed fixtures only for generated files and the suppression-removal utility itself.
- Integration: run the checker against the repository and prove a temporary forbidden suppression produces a non-zero status before fixing the tracked findings.
- UI/mobile/web parity: not applicable; the checker must cover both web and mobile source trees.

## File Structure

- Replace: `scripts/no-suppressions.sh` with a TypeScript script - make file discovery complete and testable through fixture-backed unit tests.
- Create/modify: colocated script tests - cover included and excluded paths.
- Modify: `package.json` and `.github/workflows/test.yml` - wire one canonical check into local lint and CI.
- Modify: tracked files reported by the checker - remove the suppressions without weakening lint or mutation coverage.

## Tasks

### Task 1: Add Failing Tests

- [ ] Write failing tests proving app-, component-, package-root-, and server-level TypeScript files are scanned, with one rejected fixture per suppression category and explicit accepted fixtures for generated files and the removal utility.
- [ ] Run `rtk pnpm vitest run --project unit <test-path>`.
- [ ] Confirm the tests fail because the current discovery omits those paths.

### Task 2: Implement the Minimal Fix

- [ ] Replace the incomplete discovery logic with one canonical tracked-file scan.
- [ ] Remove or structurally replace every currently reported suppression.
- [ ] Wire the checker into `pnpm lint` and the required CI lint job.
- [ ] Run the focused tests and `rtk pnpm lint`.

### Task 3: Final Verification

- [ ] Run the canonical checker with `rtk pnpm tsx scripts/no-suppressions.ts` and confirm exit 0.
- [ ] Run `rtk pnpm typecheck` and the affected unit/mutation tests.
- [ ] Verify the required CI gate cannot pass when the checker fails.
- [ ] Record a short retrospective covering root cause, direct fix, validation evidence, and a concrete `AGENTS.md`, `scripts/README.md`, or skill improvement for future policy-check work.
