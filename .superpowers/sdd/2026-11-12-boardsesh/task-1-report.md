# BoardSesh Task 1 implementation report

## Result

Implemented BoardSesh email/password logbook sync on branch `add-boardsesh-provider-list`.
The provider is a single self-contained module that composes the existing
`ClimbingBoardAccount`, reads complete inventories for all nine supported board
types, validates ownership and response integrity, and submits an authoritative
snapshot only after every read succeeds. It preserves raw source ticks,
timestamps, layout/upstream IDs, personal grade labels, mirror identity, source
status, and positive source-reported attempt counts. It does not infer board
identity or persist a cursor.

Registration, daily concurrency-one queueing, dataset capabilities, shared
credential metadata, web/mobile credential-form regressions, and
disconnect-before-erasure policy are wired. Documentation cites the pinned
BoardSesh upstream revision `af2f7adf95eac77990b91da8d254d97ead25b938`.

## Evidence

- Initial test-first unit/registration run: `/tmp/opencode/boardsesh/task-1-red.json`
  and `task-1-red.log`; 35 tests ran and 6 failed against the unimplemented
  provider/registration behavior.
- Final focused provider unit suite after the mutation correction batch:
  `/tmp/opencode/boardsesh/task-1-mutation-final-unit.json` and
  `task-1-mutation-final-unit.log`; 23 passed, 0 failed.
- Real Postgres + MSW BoardSesh integration and account-erasure suites:
  `/tmp/opencode/boardsesh/task-1-mutation-green-integration.json` and
  `task-1-mutation-green-integration.log`; 45 passed, 0 failed. Coverage includes
  complete and empty snapshots, edits, idempotence, restoration, failed/partial
  snapshots, ownership isolation, refresh ordering, and error cases.
- Root `pnpm typecheck`: `/tmp/opencode/boardsesh/task-1-mutation-final-typecheck.log`,
  exit 0.
- Targeted Biome check: `/tmp/opencode/boardsesh/task-1-mutation-final-biome.log`,
  exit 0.
- Lead-run full unit/mobile tier and web/mobile package typechecks were green
  before this correction batch: `/tmp/opencode/boardsesh/full-tests.json`,
  `web-typecheck.log`, and `mobile-typecheck.log`. The lead has started final
  reruns against this correction batch; current results are at
  `/tmp/opencode/boardsesh/full-final-tests.json` and `mutation-final.log` when
  those runs complete.

The initial scoped Stryker run did not meet the 75% threshold (159 killed, 72
survived, 17 uncovered, 64 ignored). The provider was simplified where a branch
was unreachable from the inspected resolver/schema, and public-sync tests were
added for meaningful token, HTTP, GraphQL, timestamp, grade, and raw-tick
boundaries. The lead is rerunning Stryker on this version. Do not treat the
initial failed score as final; report the final rerun outcome when available.

The first mutation-correction RED attempt also contained an incorrect expected
request count and a zero-attempt fixture that violated the upstream minimum of
one. Those assertions were corrected; the final focused unit report above is
green. The real-Postgres suite was not captured failing before provider
implementation, so the initial RED evidence is from the unit/registration tier.

## Live acceptance and limits

No BoardSesh account credentials were available. A read-only unauthenticated
live protocol probe confirmed the planned GraphQL tick query shape and returned
`Authentication required`; the live grade catalogue probe returned grades for
all nine board types. Populated-account authentication and sync acceptance remain
unverified. The current tick resolver does not supply a physical `boardId`, so
the provider leaves physical board identity unknown. BoardSesh's
account-wide revoke endpoint is intentionally not called.

## Review handoff

The lead is rerunning final Stryker and full unit/mobile tiers and will perform
independent Architect review of the committed diff. No deployment was performed.
