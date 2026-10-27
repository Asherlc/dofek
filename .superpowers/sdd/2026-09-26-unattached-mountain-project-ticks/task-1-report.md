# Task 1 report: standalone climbing entries

## Result

Added standalone climbing-entry ownership and provider identity, an optional activity association and unattached date, provider absence state, same-owner relationship enforcement, unattached lookup and source identity indexes, and the association/date invariant. Migration `0125` backfills identity from parent activities, detaches Mountain Project ticks with their UTC export day, carries forward provider absence state, and retires the Mountain Project wrapper activities without deleting tick rows. Existing Kaya and Mountain Project writers now set the required owner/provider values for linked rows.

The historical integration fixture applies migrations through `0124`, seeds Mountain Project and Kaya rows, then applies `0125` and verifies retention, detachment, attribution, dates, absence state, and wrapper visibility.

## Validation

- `pnpm test:integration -- src/db/unattached-climbing-entry.integration.test.ts src/db/mountain-project-tick-migration.integration.test.ts` — PASS; 2 files, 4 tests.
- `pnpm exec vitest run --project unit src/db/drizzle-schema.test.ts` — PASS; 8 tests.
- `pnpm typecheck` — PASS.
- `pnpm exec biome check src/db/schema/activity.ts src/db/drizzle-schema.test.ts src/db/unattached-climbing-entry.integration.test.ts src/db/mountain-project-tick-migration.integration.test.ts src/providers/kaya-sync.ts src/providers/kaya/import.ts src/providers/mountain-project.ts` — PASS.

During initial integration runs, migration execution first failed with `constraint "climbing_entry_activity_id_activity_id_fk" ... does not exist`; the deployed constraint was PostgreSQL's `climbing_entry_activity_id_fkey`. After correcting that name, the backfill failed with `null value in column "activity_id" ... violates not-null constraint`; migration `0125` now drops `activity_id` nullability before detaching entries. The final database suites pass.

## Retrospective

The deployed FK name and nullability ordering were clarified by executing the migration against PostgreSQL, and the full historical fixture confirmed migration compatibility through `0124`. The schema change also surfaced three linked-entry writers that needed the new required fields; typecheck found all three. For similar work, the migration test should keep applying the real historical chain before inserting fixtures. No production incident occurred.

Suggested process improvement: retain the task brief's explicit historical-chain requirement in future schema migration plans; it made the migration test representative. No additional documentation change is needed for this task. Use `integration-tests-ready` again for database changes; `write-tests` is also useful when test coverage extends beyond a narrowly specified migration contract.
