# Task 3 report: same-day Mountain Project tick suggestions and attachment

## Result

Added `MountainProjectTickRepository` for user-scoped exact displayed-day
suggestions and one-statement conditional tick attachment. Activity IDs are
resolved through `ActivityRepository`; the mutation stores an actual activity
member ID while accepting the canonical group ID from clients. It rechecks the
user, active target, climbing type, local date, Mountain Project source,
provider presence, and unattached state as part of the update. Missing or stale
records return actionable `NOT_FOUND`, `PRECONDITION_FAILED`, or `CONFLICT`
errors. The climbing router exposes the query and mutation and invalidates only
activity-entry and suggestion caches after attachment.

Added repository unit and PostgreSQL integration coverage, router unit and
PostgreSQL integration coverage, and updated existing climbing integration
fixtures to provide the required Task 1 owner and provider fields.

## Validation

- `pnpm exec vitest run --project unit packages/server/src/routers/climbing.test.ts packages/server/src/repositories/mountain-project-tick-repository.test.ts` — PASS, 19 tests.
- `pnpm test:integration -- packages/server/src/repositories/mountain-project-tick-repository.integration.test.ts packages/server/src/routers/climbing.integration.test.ts` — PASS, 9 tests against PostgreSQL.
- `pnpm typecheck` — PASS.
- `pnpm exec biome check` on the six changed TypeScript files — PASS.
- The requested broad `pnpm test -- packages/server/src/routers/climbing.test.ts` completed with 18,997 passing tests and one failure in `src/providers/provider-activity-sync-policy.test.ts`: it flags `src/providers/mountain-project.ts` after Task 2 changed Mountain Project sync away from activity upserts. This is outside Task 3; no production behavior was changed to work around that policy failure.

## Retrospective

The main investigation was preserving the canonical group ID API while
honoring the climbing-entry foreign key to a real member activity. PostgreSQL
coverage proved this resolution and the single conditional update end to end.
The Task 1 schema also required updating pre-existing climbing integration
fixtures. For future matching work, the design should continue to call out the
canonical-group-to-member association boundary and keep integration callers in
refresh mode when testing cache invalidation across retries.

No production incident occurred. Suggested documentation improvement: update
the provider activity sync static-policy test when the Task 2 Mountain Project
sync no longer uses activity upserts, so the full unit tier reflects the new
provider path. `superpowers:test-driven-development`,
`integration-tests-ready`, and `superpowers:verification-before-completion`
were useful for this task; reuse them for similar repository and router work.
