# Retained Health Record Recovery Implementation Plan

> **Execution procedure:** Complete the tasks in order, keep the checkbox state current, run each task's stated verification before its commit, and stop before any repository or production mutation that has not received explicit approval.

**Goal:** Restore the accidentally deleted breathwork-session and menstrual-period records while keeping their human-input UIs and mutation APIs retired and preserving both datasets through read-only exports.

**Architecture:** Merge the current default branch into the existing public feature branch, then add a forward-only PostgreSQL migration that recreates the two canonical raw-data tables after destructive migration `0089`. Restore the Drizzle models, account-erasure coverage, admin inventory, and user-filtered CSV exports without restoring any client or tRPC mutation surface. Recover only the two tables from the encrypted pre-drop backup in an isolated PostgreSQL database, then apply the exact reviewed migration and a single-transaction data-only import to production.

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL 18/TimescaleDB, Vitest integration tests, Databasus encrypted logical backups, Cloudflare R2, Docker.

**Confirmed deployed state:** Production evidence established that migration `0089_remove_cycle_tracking_and_breathwork.sql` was deployed and dropped both retained tables. This recovery plan and forward migration `0091_restore_retained_health_records.sql` are therefore required; the verified evidence and recovery result are recorded in [`production-incident-baseline.md`](../../production-incident-baseline.md).

## Global Constraints

- Keep every breathwork and cycle-tracking human-input UI removed on web and mobile.
- Keep every breathwork and menstrual-cycle tRPC router, repository mutation surface, and scoring module removed.
- Preserve provider-ingested canonical `breathwork` activity mappings.
- Restore `fitness.breathwork_session` and `fitness.menstrual_period` as raw canonical storage with their original columns, indexes, checks, and user-profile foreign keys.
- Expose both restored datasets only through user-filtered CSV entries in the existing authenticated data export.
- Include both restored tables in full-user erasure and operational table inventory paths.
- Do not edit or rewrite already-applied migration `0089_remove_cycle_tracking_and_breathwork.sql`; add a forward migration.
- Do not add a compatibility route, fallback, feature flag, seed generator, or test that merely asserts a removed feature is absent.
- Recover from R2 object `Health-20260814-060042-a8aa2672-187d-413c-aa1d-9075835a4459` and its matching `.metadata` object only.
- Never print the Databasus secret key, R2 credentials, decrypted records, user identifiers, or health-record contents.
- Restore into an isolated scratch database first; production receives only the two selected tables in one transaction after schema and row-count checks pass.
- Run the listed merge, commit, push, and production commands only after explicit approval. Approval for this execution was recorded on 2026-08-15.
- With that approval, merge `origin/main` into `remove-human-input-uis-breathwork` and push approved commits to that branch; do not rebase, force-push, switch branches, or stage the user-owned `paseo.json` file.

---

### Task 1: Integrate current main without reintroducing retired surfaces

**Files:**
- Modify through merge conflict resolution: `docs/roadmap.md`
- Modify through merge conflict resolution: `packages/mobile/app-tests/more.test.tsx`
- Modify through merge conflict resolution: `packages/mobile/app/more.tsx`
- Modify through merge conflict resolution: `packages/scoring/README.md`
- Modify through merge conflict resolution: `packages/scoring/package.json`
- Modify through merge conflict resolution: `packages/server/src/routers/router-logic.integration.test.ts`
- Modify through merge conflict resolution: `packages/web/src/pages/MorePage.stories.tsx`
- Modify through merge conflict resolution: `packages/web/src/pages/MorePage.test.tsx`
- Modify through merge conflict resolution: `packages/web/src/pages/MorePage.tsx`
- Modify through merge conflict resolution: `scripts/README.md`
- Modify through merge conflict resolution: `scripts/seed-dev-db.ts`
- Modify through merge conflict resolution: `scripts/seed/verification.integration.test.ts`
- Modify through merge conflict resolution: `scripts/seed/verification.ts`
- Modify through merge conflict resolution: `src/db/seed-dev-db.integration.test.ts`
- Modify through merge conflict resolution: `src/export.test.ts`
- Modify through merge conflict resolution: `src/export.ts`

**Interfaces:**
- Consumes: `origin/main` at or after `ddca13977f0925169addae6b91d27a74fd0dbb86` and the existing branch commits through `c27842616f842603d1fe6c6b467516f35beb9d91`.
- Produces: one public merge commit containing all current-main removals and the branch's breathwork retirement documentation, with both retained export entries carried forward for Task 3.

- [ ] **Step 1: Refresh and verify merge inputs**

Run:

```bash
rtk git fetch origin main
rtk git status --short
rtk git merge-base HEAD origin/main
```

Expected: the only unrelated worktree entry is `?? paseo.json`; no merge or rebase is already active.

- [ ] **Step 2: Merge current main**

Run:

```bash
rtk git merge --no-ff origin/main
```

Expected: Git reports the known conflicts while leaving every non-conflicting current-main change staged.

- [ ] **Step 3: Resolve the removal conflicts to the approved steady state**

Use the current-main versions for shared web/mobile navigation, scoring manifests, router integration coverage, seed generation, and seed verification so both cycle and breathwork UI/API removals remain. Resolve `src/export.ts` and `src/export.test.ts` manually so the latest main export set also contains both positive, user-filtered entries:

```ts
{
  name: "breathwork-sessions.csv",
  query: (db, userId) =>
    executeWithSchema(
      db,
      exportRowSchema,
      sql`SELECT * FROM fitness.breathwork_session WHERE user_id = ${userId} ORDER BY started_at`,
    ),
},
{
  name: "menstrual-periods.csv",
  query: (db, userId) =>
    executeWithSchema(
      db,
      exportRowSchema,
      sql`SELECT * FROM fitness.menstrual_period WHERE user_id = ${userId} ORDER BY start_date`,
    ),
},
```

Keep the two retirement design/plan documents already committed on this branch. Do not restore deleted route, screen, tRPC, repository, or scoring files.

- [ ] **Step 4: Verify the resolved merge**

Run:

```bash
rtk git diff --check
rtk git diff --name-only --diff-filter=U
rtk rg -n '<<<<<<<|=======|>>>>>>>' --glob '!paseo.json'
rtk pnpm exec tsc --noEmit
```

Expected: no unresolved paths or conflict markers; root TypeScript compilation passes.

- [ ] **Step 5: Commit and push the merge**

Run:

```bash
rtk git add -u
rtk git add docs/superpowers/plans/2026-08-14-retire-breathwork-feature.md docs/superpowers/specs/2026-08-14-retire-breathwork-feature-design.md src/export.ts src/export.test.ts
rtk git commit
rtk git push origin remove-human-input-uis-breathwork
```

Expected: a merge commit is pushed without staging `paseo.json`.

### Task 2: Recreate the retained canonical tables with an executable migration test

**Files:**
- Modify: `src/db/migrate.integration.test.ts`
- Create: `drizzle/0091_restore_retained_health_records.sql`
- Modify: `drizzle/meta/_journal.json`
- Modify: `src/db/schema/events.ts`
- Regenerate: `docs/schema.dbml`
- Regenerate: `docs/schema.puml`

**Interfaces:**
- Consumes: migration `0089`, which has already dropped both production tables, and migration `0090`, which is the current journal tail.
- Produces: Drizzle exports `breathworkSession` and `menstrualPeriod`; migration journal entry `idx: 93`, `when: 1786805000000`, tag `0091_restore_retained_health_records`; executable PostgreSQL proof that both tables survive the full migration chain.

- [ ] **Step 1: Write the failing migration integration test**

Add a positive test under `describe("runMigrations")` that uses the database already created by `setupTestDatabase()`:

```ts
it("retains canonical breathwork and menstrual records after all migrations", async () => {
  const client = new Client({ connectionString: ctx.connectionString });
  await client.connect();
  const result = await client.query(`
    SELECT
      to_regclass('fitness.breathwork_session') IS NOT NULL AS breathwork_exists,
      to_regclass('fitness.menstrual_period') IS NOT NULL AS menstrual_period_exists
  `);
  expect(result.rows).toEqual([
    { breathwork_exists: true, menstrual_period_exists: true },
  ]);
  await client.end();
});
```

- [ ] **Step 2: Run the test and confirm the destructive migration is reproduced**

Run:

```bash
rtk pnpm test:integration -- src/db/migrate.integration.test.ts
```

Expected: the new test fails because both `to_regclass` checks are false after `0089`.

- [ ] **Step 3: Add the forward migration**

Create `0091_restore_retained_health_records.sql` with ordinary `CREATE TABLE`, `ALTER TABLE ... ADD CONSTRAINT`, and `CREATE INDEX` statements—no `IF NOT EXISTS` fallback. Recreate these exact columns:

```sql
fitness.breathwork_session (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES fitness.user_profile(id),
  technique_id text NOT NULL,
  rounds integer NOT NULL,
  duration_seconds integer NOT NULL,
  started_at timestamptz NOT NULL,
  notes text,
  stress_before bigint,
  stress_after bigint,
  dizziness_after boolean,
  perceived_effect text,
  created_at timestamptz DEFAULT now() NOT NULL
)
```

Add indexes `breathwork_session_user_idx` and descending `breathwork_session_started_at_idx`, plus checks `breathwork_session_stress_before_range`, `breathwork_session_stress_after_range`, and `breathwork_session_perceived_effect_valid` with the same predicates as migration `0065`.

```sql
fitness.menstrual_period (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES fitness.user_profile(id),
  start_date date NOT NULL,
  end_date date,
  notes text,
  created_at timestamptz DEFAULT now() NOT NULL
)
```

Add indexes `menstrual_period_user_idx` and unique `menstrual_period_user_start_idx (user_id, start_date)`.

- [ ] **Step 4: Restore the Drizzle models and journal entry**

Restore `breathworkSession` and `menstrualPeriod` in `src/db/schema/events.ts` with the exact field types, indexes, checks, defaults, and `userProfile.id` references represented by the SQL migration. Append journal entry:

```json
{
  "idx": 93,
  "version": "7",
  "when": 1786805000000,
  "tag": "0091_restore_retained_health_records",
  "breakpoints": true
}
```

- [ ] **Step 5: Run the migration test and schema tooling**

Run:

```bash
rtk pnpm test:integration -- src/db/migrate.integration.test.ts
rtk pnpm tsx scripts/generate-schema-diagram.ts
rtk pnpm lint:migrations
rtk pnpm exec tsc --noEmit
```

Expected: the integration test passes against real PostgreSQL; both diagrams contain the two tables; migration policy and TypeScript pass.

- [ ] **Step 6: Commit and push**

Run:

```bash
rtk git add drizzle/0091_restore_retained_health_records.sql drizzle/meta/_journal.json src/db/migrate.integration.test.ts src/db/schema/events.ts docs/schema.dbml docs/schema.puml
rtk git commit -m "fix: restore retained health record storage"
rtk git push origin remove-human-input-uis-breathwork
```

### Task 3: Restore read-only portability and lifecycle coverage

**Files:**
- Modify: `src/export.test.ts`
- Modify: `src/export.ts`
- Modify: `packages/server/src/repositories/settings-repository.test.ts`
- Modify: `packages/server/src/repositories/settings-repository.ts`
- Modify: `packages/server/src/routers/settings.integration.test.ts`
- Modify: `packages/server/src/routers/admin.ts`
- Modify: `scripts/seed/core.ts`

**Interfaces:**
- Consumes: Task 2's two restored tables.
- Produces: authenticated CSV portability for each table, full-user erasure coverage, admin inventory visibility, and deterministic review-user cleanup without generating new records.

- [ ] **Step 1: Write or restore positive export and erasure tests**

In `src/export.test.ts`, keep tests that verify `breathwork-sessions.csv` and `menstrual-periods.csv` serialize every returned column and that each SQL query is filtered by `user_id`. In `settings-repository.test.ts`, change the positive user-scoped deletion test to expect seven tables and both retained table names:

```ts
expect(queries.filter((query) => query.includes("DELETE FROM"))).toHaveLength(7);
expect(queries.some((query) => query.includes("fitness.breathwork_session"))).toBe(true);
expect(queries.some((query) => query.includes("fitness.menstrual_period"))).toBe(true);
```

Restore the settings integration fixture assertions that prove menstrual rows are deleted, and add a breathwork fixture and positive post-deletion count in the same transaction-backed integration scenario.

- [ ] **Step 2: Run the focused tests and confirm the lifecycle gap**

Run:

```bash
rtk pnpm test -- src/export.test.ts packages/server/src/repositories/settings-repository.test.ts
rtk pnpm test:integration -- packages/server/src/routers/settings.integration.test.ts
```

Expected: export coverage passes if carried correctly through Task 1; deletion coverage fails until both tables are restored to the user-scoped deletion list.

- [ ] **Step 3: Implement the retained-data lifecycle paths**

Ensure `EXPORT_TABLES` contains both queries from Task 1. Add these entries to `USER_SCOPED_DELETE_TABLES`:

```ts
"fitness.breathwork_session",
"fitness.menstrual_period",
```

Add `breathwork_session` and `menstrual_period` to the admin overview's `target_tables`. Keep the review-user cleanup deletes for both tables in `scripts/seed/core.ts`, but do not restore any breathwork or cycle seed generation or verification requirement.

- [ ] **Step 4: Run focused verification**

Run:

```bash
rtk pnpm test -- src/export.test.ts packages/server/src/repositories/settings-repository.test.ts
rtk pnpm test:integration -- packages/server/src/routers/settings.integration.test.ts
rtk pnpm exec tsc --noEmit
rtk pnpm --filter dofek-server exec tsc --noEmit
```

Expected: all focused tests and typechecks pass.

- [ ] **Step 5: Commit and push**

Run:

```bash
rtk git add src/export.ts src/export.test.ts packages/server/src/repositories/settings-repository.ts packages/server/src/repositories/settings-repository.test.ts packages/server/src/routers/settings.integration.test.ts packages/server/src/routers/admin.ts scripts/seed/core.ts
rtk git commit -m "fix: preserve retained health record lifecycle"
rtk git push origin remove-human-input-uis-breathwork
```

### Task 4: Verify and recover the two tables from the pre-drop backup

**Files:**
- Modify after recovery evidence is known: `docs/production-incident-baseline.md`
- Temporary only, outside Git: a mode-`0700` directory returned by `mktemp -d /tmp/dofek-retained-health-recovery.XXXXXX`

**Interfaces:**
- Consumes: encrypted R2 backup `Health-20260814-060042-a8aa2672-187d-413c-aa1d-9075835a4459`, its `.metadata`, `/mnt/dofek-data/databasus/secret.key`, and Task 2's reviewed migration hash.
- Produces: verified scratch-table row counts, exact production row-count parity for both restored tables, no retained decrypted artifact, and an incident record containing counts but no user IDs or health data.

- [ ] **Step 1: Create and verify an isolated recovery directory**

Run:

```bash
recovery_dir="$(mktemp -d /tmp/dofek-retained-health-recovery.XXXXXX)"
chmod 700 "$recovery_dir"
test -d "$recovery_dir"
```

Record the resolved path privately for cleanup; never use a broad or unresolved cleanup target.

- [ ] **Step 2: Download exactly the selected encrypted object pair and copy the key without printing it**

Use the existing Infisical-wrapped R2 client to issue `GetObject` for the exact backup key and its `.metadata` key into `recovery_dir`. Copy `/mnt/dofek-data/databasus/secret.key` from `dofek-server` to that directory, set mode `0600`, and verify only file sizes and SHA-256 digests. Do not log file contents or environment values.

- [ ] **Step 3: Decrypt with a pinned, fail-closed AES-256-GCM verifier**

Use the [Databasus manual recovery guide](https://databasus.com/how-to-recover-without-databasus) only as protocol documentation; do not execute mutable webpage content directly. Place the exact reviewed verifier bytes in the mode-`0700` recovery directory and record their SHA-256 digest in protected operator notes before execution. The verifier must accept the backup and matching metadata paths as file inputs and read the key from standard input or a mode-`0600` file descriptor, never a command-line argument.

Before emitting a completed archive, the verifier must validate the required files, metadata and encryption header, every declared chunk length, the absence of truncated or trailing bytes, successful AES-GCM authentication for every chunk, and clean end-of-file. Missing files, an unencrypted backup, malformed metadata, truncated chunks, MAC failures, decryption errors, unexpected trailing data, or any other validation failure must remove any partial output and exit nonzero. Only after the verifier exits zero, run:

```bash
pg_restore --list "$recovery_dir/decrypted_Health-20260814-060042-a8aa2672-187d-413c-aa1d-9075835a4459"
```

Expected: `pg_restore` recognizes a PostgreSQL archive and lists both target tables.

- [ ] **Step 4: Restore into an isolated PostgreSQL 18 scratch database**

Start a temporary PostgreSQL 18 container with no published port and a dedicated temporary volume. Restore the full archive with `--no-owner --no-privileges --single-transaction`, then query only aggregate evidence:

```sql
SELECT 'breathwork_session', count(*) FROM fitness.breathwork_session
UNION ALL
SELECT 'menstrual_period', count(*) FROM fitness.menstrual_period;
```

Require both tables to exist, all foreign keys and checks to validate, and both counts to be recorded without outputting row contents.

- [ ] **Step 5: Create a two-table data-only archive and validate it in a second empty scratch database**

Run `pg_dump --format=custom --data-only --table=fitness.breathwork_session --table=fitness.menstrual_period` against the restored scratch database. Apply Task 2's migration chain to a second empty PostgreSQL 18 scratch database. If either retained table contains rows, privately extract the distinct referenced `user_id` values from the first scratch database and insert minimal placeholder `fitness.user_profile` parent rows into the second scratch database before importing the selected tables; use only the required identifier plus a constant non-health name, and never print identifiers. If both source counts are zero, explicitly verify that no parent fixtures are required.

Restore the two-table archive with `pg_restore --data-only --single-transaction`, then require exact row-count parity with Step 4, zero orphan counts for each table, and validated foreign-key and check constraints. Validation output may contain aggregate counts and constraint names only, never user identifiers or health-record contents.

- [ ] **Step 6: Apply the exact reviewed forward migration to production**

Acquire advisory lock `728370291`, run the exact SQL bytes from `drizzle/0091_restore_retained_health_records.sql` inside one production transaction, insert its SHA-256 hash as both `hash` and `content_hash` with journal timestamp `1786805000000` into `drizzle.__drizzle_migrations`, refresh the account-erasure write fences, and release the lock. Verify both production tables are empty and their columns, indexes, checks, foreign keys, and migration hash match the reviewed branch before importing data.

- [ ] **Step 7: Restore only the two selected tables to production**

Pipe the validated data-only archive to production `pg_restore --data-only --single-transaction`. Require a zero exit status, exact row-count parity with the isolated restore, zero orphaned `user_id` values, valid constraints, `pg_is_in_recovery() = false`, and a healthy application `/healthz` response.

- [ ] **Step 8: Remove sensitive temporary artifacts**

Stop and remove only the two named scratch containers and their dedicated temporary volumes. Validate that `recovery_dir` begins with `/tmp/dofek-retained-health-recovery.` and is mode `0700`, then remove that exact directory. Verify no decrypted archive, secret-key copy, data-only archive, or scratch volume remains.

- [ ] **Step 9: Record the incident and commit**

Append a dated section to `docs/production-incident-baseline.md` containing the symptom, user impact, exact destructive migration hash, first confirmed fatal effect, pre-drop backup timestamp, root cause, restored aggregate counts, validation, the unrecoverable-at-most-eight-hour window between backup and drop, and follow-up prevention. Cite the PostgreSQL migration/transaction documentation and Databasus manual recovery documentation. Do not include user IDs, row contents, secrets, or local temporary paths.

Run:

```bash
rtk git add docs/production-incident-baseline.md
rtk git commit -m "docs: record retained health data recovery"
rtk git push origin remove-human-input-uis-breathwork
```

### Task 5: Run final verification and finish PR #2530

**Files:**
- Modify through GitHub API only: PR #2530 title/body if necessary

**Interfaces:**
- Consumes: Tasks 1–4 and their pushed commits.
- Produces: clean local verification, a current non-conflicting PR, and completed required GitHub checks with no unresolved actionable review comments.

- [ ] **Step 1: Run the repository verification tiers**

Run:

```bash
rtk pnpm lint
rtk pnpm exec tsc --noEmit
rtk pnpm --filter dofek-server exec tsc --noEmit
rtk pnpm --filter dofek-web exec tsc --noEmit
rtk pnpm test:changed
rtk pnpm test:changed:all
rtk git diff --check origin/main...HEAD
```

Expected: all commands exit zero without retries, ad-hoc waits, ignored failures, or changed thresholds.

- [ ] **Step 2: Run retained-surface scans**

Run a broad `breathwork` and `menstrual` scan. Confirm every remaining occurrence is one of: canonical activity mappings, historical migrations, restored raw storage schema, user-filtered export, account erasure, admin inventory, seed-user cleanup, generated schema documentation, tests for active retained behavior, or incident/design documentation. Any client route, mutation API, active seed generation, or scoring implementation is a blocker.

- [ ] **Step 3: Push and update the PR**

Run:

```bash
rtk git push origin remove-human-input-uis-breathwork
rtk gh pr edit 2530 --title "Retire health input surfaces and recover retained records" --body-file .superpowers/sdd/2026-08-15-recover-retained-health-records/pr-body.md
```

The PR body must state the root cause, forward migration, isolated backup verification, aggregate restore counts, read-only exports, UI/API removals, validation commands, and residual eight-hour recovery-window risk.

- [ ] **Step 4: Monitor checks and actionable comments**

Use `gh pr checks 2530 --watch` and inspect both review comments and issue comments. Address only actionable findings through the subagent fix/re-review loop; push every fix commit automatically. Do not merge the PR automatically.
