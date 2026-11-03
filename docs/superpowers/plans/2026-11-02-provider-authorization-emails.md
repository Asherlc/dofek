# Authorization-only provider emails

> **For agentic workers:** Use superpowers:executing-plans for this single-task change.

**Goal:** Email only for authorization problems requiring reconnection, as approved by the operator.

**Architecture:** Restrict the existing [notification query](../../../src/db/provider-issue-notification.ts) to a latest overall authorization failure. Confirm non-revocation failures with another authorization failure on an automatic sync; generic failures never count as confirmation. Keep immediate refresh-token-revocation alerts, per-connection deduplication, recovery reset, and application/monitoring reporting.

**Tech stack:** TypeScript, Drizzle SQL, PostgreSQL, Vitest, MSW.

**Scope:** Shared backend policy covers web and mobile. No schema, dependency, environment, retry, or timeout changes.

## Task and review checkpoints

- [x] Update real PostgreSQL/MSW cases: repeated timeouts/outages send nothing; mixed generic/auth failures do not confirm authorization; revoked-token delivery cannot be retried by a timeout. Retain auth confirmation, recovery, concurrent suppression and delivery retry coverage.
- [x] Run the changed cases against the original implementation and verify policy failures (RED).
- [x] Restrict eligibility and email content to authorization failures; update unit fixtures and current documentation.
- [x] Run PostgreSQL suite, relevant unit suites, root typecheck and lint for changed files (GREEN).
- [x] Review final diff against the approved policy, commit and push.

## Working notes

The existing query counts all scheduled errors and lets a later generic error confirm an earlier auth failure. The implementation will require the current failure to be an authorization error and count only authorization errors since the last successful overall sync. PostgreSQL-backed regressions verify query execution, consistent with [the testing guide](../../testing.md#integration-dependencies).

## Verification and review

RED: the original SQL failed 10 policy cases (including timeout/outage delivery and mixed authorization history). GREEN: all 36 PostgreSQL/MSW cases and 24,512 unit/mobile tests pass (19 existing skipped tests). Root typecheck, Biome for changed code, source spellcheck and diff whitespace checks pass. Independent review found no issues. An additional spellcheck of README files flags three unchanged terms already present at HEAD (`geospatial`, `sqlfluff`, `quiescing`); these files are outside the configured source spellcheck tier. No runtime or monitoring changes were needed beyond email eligibility and copy.
