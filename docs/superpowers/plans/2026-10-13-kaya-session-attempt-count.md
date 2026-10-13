# Kaya session attempt count implementation plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` to implement and review this plan.

**Goal:** Import Kaya's reported per-climb attempt counts and repair affected records through the normal Kaya sync.

**Architecture:** Request `attempted_climbs { attempts: session_attempts }` in the existing session query. The permanent [GraphQL alias](https://graphql.org/learn/queries/#aliases) supplies the existing typed `attempts` response property directly from the correct provider field, preserving the current provider and storage interfaces. Ascent records continue to use their own nullable `attempts` field.

**Tech stack:** TypeScript, Zod, GraphQL, Vitest, existing Kaya provider and PostgreSQL writer.

**Spec:** User-approved direction in this session; observed authenticated [Kaya API](https://kaya-beta.kayaclimb.com/graphql) on 2026-10-13. The attempted-climb `attempts` field returned null while `session_attempts` supplied positive counts. No production identifiers belong in fixtures or documentation.

## Global constraints

- Use the single confirmed upstream field; preserve true unknown counts.
- Keep source identities, source attribution, and transaction behavior intact.
- Both clients receive the corrected server values through their existing API.
- Stay on the current worktree branch; push every new commit after required checks.
- Repair through the existing sync, with production verification of stored and served values.

## Review focus

- The alias applies only to session attempted climbs; ascent counts remain independent.
- Positive counts, nullable counts, and malformed counts retain boundary validation.
- The regression must fail if the outgoing request selects `attempts` again.
- Re-sync retains climbing-entry IDs and detailed attempts.
- Production repair must run the corrected request and must not overwrite true unknown ascent counts.

### Task 1: Correct the Kaya request and prove the import boundary

**Files:** `packages/kaya-client/src/client.ts`, `packages/kaya-client/src/client.test.ts`.

**Interfaces:** `KayaClient.listSessions(userId)` continues to return `KayaSession[]` with nullable `attempted_climbs[].attempts`.

- [x] Add a request-boundary regression using synthetic attempted climbs where the old upstream field is null and the session count is positive. Verify the outgoing alias and the parsed count, retaining the existing nullable-count cases.
- [x] Run `pnpm vitest run --project unit packages/kaya-client/src/client.test.ts`; expect the new regression to fail because the query selects the wrong field.
- [x] Change only the attempted-climb field selection to `attempts: session_attempts`.
- [x] Run the client and `src/providers/kaya-sync.test.ts` suites; expect all tests to pass.
- [x] Review spec compliance and code quality before release.

### Task 2: Document, validate, release, and repair

**Files:** `docs/kaya.md`, `docs/kaya-api.openapi.yaml`, `docs/production-incident-baseline.md`.

**Interfaces:** Existing Kaya sync request and production deployment runbooks.

- [x] Document the observed field distinction and response alias with primary-source links.
- [x] Run lint, relevant unit/mobile tests, and all package type checks; expect success.
- [ ] Review the complete diff, commit, and push; create a reviewable PR.
- [ ] Release the validated commit through the canonical production workflow, then request the normal Kaya sync for the affected user.
- [ ] Verify corrected source counts, stable entry identities, API output, and unknown ascent counts; record the operational outcome.
