# Retire the Breathwork Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every first-party Breathwork UI and tRPC API while preserving all existing `fitness.breathwork_session` rows as historical read-only data.

**Architecture:** Delete the web/mobile product surface and its dedicated server/domain stack, then stop generating new development seed sessions. Keep the canonical table, migrations, export reads, admin accounting, seed-user cleanup, and provider activity classification so historical data remains intact and portable without leaving an active Breathwork feature.

**Tech Stack:** TypeScript, React, React Native/Expo Router, TanStack Router, tRPC, Drizzle ORM, Vitest, Biome.

## Global Constraints

- Do not drop, truncate, rename, rewrite, or migrate `fitness.breathwork_session`.
- Do not remove the table from `src/db/schema/events.ts`, `drizzle/0000_baseline.sql`, `drizzle/0065_breathwork_outcome_reports.sql`, `docs/schema.dbml`, or `docs/schema.puml`.
- Keep generic export reads and operator/admin accounting for the retained table.
- Keep disposable review-user cleanup in `scripts/seed/core.ts`; remove only active seed generation and verification requirements.
- Keep provider-ingested `breathwork` activity mappings in Garmin, WHOOP, Oura, and `@dofek/training`.
- Do not add a redirect, compatibility API, deprecation screen, disabled UI, archive table, or replacement feature.
- Do not add tests that merely assert the removed route, API, or implementation is absent.
- Preserve unrelated user changes, including the untracked workspace-owned `paseo.json`.
- Push every new commit to `origin/remove-human-input-uis-breathwork`.

---

### Task 1: Remove the Web and Mobile Product Surfaces

**Files:**

- Delete: `packages/web/src/routes/breathwork.tsx`
- Delete: `packages/web/src/routes/breathwork.test.tsx`
- Modify: `packages/web/src/pages/MorePage.tsx`
- Modify: `packages/web/src/pages/MorePage.test.tsx`
- Modify: `packages/web/src/pages/MorePage.stories.tsx`
- Regenerate: `packages/web/src/routeTree.gen.ts`
- Delete: `packages/mobile/app/breathwork.tsx`
- Delete: `packages/mobile/app-tests/breathwork.test.tsx`
- Delete: `packages/mobile/app-stories/breathwork.stories.tsx`
- Modify: `packages/mobile/app/more.tsx`
- Modify: `packages/mobile/app-tests/more.test.tsx`
- Modify: `packages/mobile/app/(tabs)/recovery.tsx`
- Modify: `packages/mobile/app-tests/(tabs)/recovery.test.tsx`
- Modify: `packages/mobile/app/_layout.tsx`

**Interfaces:**

- Consumes: Existing TanStack and Expo route/navigation conventions.
- Produces: Web and mobile route trees with no active Breathwork destination or screen.

- [ ] **Step 1: Remove the web route and its focused test**

Delete both route files as one production/test pair:

```text
packages/web/src/routes/breathwork.tsx
packages/web/src/routes/breathwork.test.tsx
```

- [ ] **Step 2: Remove Breathwork from the web More destination fixtures**

Delete only this destination object from `MorePage.tsx`:

```ts
{
  to: "/breathwork",
  title: "Breathwork",
  description: "Start a guided breathing session and review recent practice.",
},
```

Remove the matching `/breathwork` link assertion from `MorePage.test.tsx` and
the `{ path: "/breathwork", title: "Breathwork" }` entry from
`MorePage.stories.tsx`. Do not add a negative assertion.

- [ ] **Step 3: Regenerate the TanStack route tree and type-check web**

Run:

```bash
pnpm --dir packages/web typecheck
```

Expected: `tsr generate` removes every generated `/breathwork` entry and the
web TypeScript check passes.

- [ ] **Step 4: Remove the mobile route, route test, and route story**

Delete these files together:

```text
packages/mobile/app/breathwork.tsx
packages/mobile/app-tests/breathwork.test.tsx
packages/mobile/app-stories/breathwork.stories.tsx
```

Delete the `Stack.Screen` whose `name` is `"breathwork"` from
`packages/mobile/app/_layout.tsx`.

- [ ] **Step 5: Remove mobile navigation entry points and adapt existing tests**

Delete the `/breathwork` destination object from `packages/mobile/app/more.tsx`
and its existing tuple from `packages/mobile/app-tests/more.test.tsx`:

```ts
["Breathwork. Start a guided breathing session and review recent practice.", "/breathwork"]
```

Delete the Recovery `TouchableOpacity` labeled `Breathwork` and delete the
existing `opens breathwork from recovery tools` test. Do not add a new test for
absence.

- [ ] **Step 6: Run focused client tests and type checks**

Run:

```bash
pnpm vitest run --project unit packages/web/src/pages/MorePage.test.tsx
pnpm vitest run --project mobile packages/mobile/app-tests/more.test.tsx 'packages/mobile/app-tests/(tabs)/recovery.test.tsx'
pnpm --dir packages/mobile typecheck
```

Expected: all selected tests and the mobile type check pass.

- [ ] **Step 7: Commit and push the client removal**

```bash
git add packages/web/src/routes/breathwork.tsx packages/web/src/routes/breathwork.test.tsx packages/web/src/pages/MorePage.tsx packages/web/src/pages/MorePage.test.tsx packages/web/src/pages/MorePage.stories.tsx packages/web/src/routeTree.gen.ts packages/mobile/app/breathwork.tsx packages/mobile/app-tests/breathwork.test.tsx packages/mobile/app-stories/breathwork.stories.tsx packages/mobile/app/more.tsx packages/mobile/app-tests/more.test.tsx 'packages/mobile/app/(tabs)/recovery.tsx' 'packages/mobile/app-tests/(tabs)/recovery.test.tsx' packages/mobile/app/_layout.tsx
git commit -m "refactor: retire breathwork clients"
git push
```

Expected: only the listed client files are committed; `paseo.json` remains
untracked.

---

### Task 2: Remove the Dedicated API, Repository, and Shared Domain Module

**Files:**

- Delete: `packages/server/src/routers/breathwork.ts`
- Delete: `packages/server/src/routers/breathwork.test.ts`
- Delete: `packages/server/src/repositories/breathwork-repository.ts`
- Delete: `packages/server/src/repositories/breathwork-repository.test.ts`
- Delete: `packages/server/src/repositories/breathwork-repository.integration.test.ts`
- Modify: `packages/server/src/router.ts`
- Modify: `packages/server/src/router.test.ts`
- Modify: `packages/server/src/routers/router-logic.integration.test.ts`
- Delete: `packages/scoring/src/breathwork.ts`
- Delete: `packages/scoring/src/breathwork.test.ts`
- Modify: `packages/scoring/package.json`
- Modify: `packages/scoring/README.md`
- Modify: `src/lib/cache.ts`

**Interfaces:**

- Consumes: The client removal from Task 1, which eliminates all consumers of the tRPC namespace and shared module.
- Produces: An `AppRouter` without a `breathwork` namespace and no dedicated application read/write path for manual sessions.

- [ ] **Step 1: Delete the dedicated router and repository source/test pairs**

Delete exactly these files:

```text
packages/server/src/routers/breathwork.ts
packages/server/src/routers/breathwork.test.ts
packages/server/src/repositories/breathwork-repository.ts
packages/server/src/repositories/breathwork-repository.test.ts
packages/server/src/repositories/breathwork-repository.integration.test.ts
```

This removes technique, history, outcome, and logging procedures together, so
no partial API remains.

- [ ] **Step 2: Unregister the tRPC namespace and adapt router tests**

Remove both registration lines from `packages/server/src/router.ts`:

```ts
import { breathworkRouter } from "./routers/breathwork.ts";
breathwork: breathworkRouter,
```

Remove the matching module mock and `"breathwork"` expected key from
`packages/server/src/router.test.ts`. Delete the complete
`refreshes breathwork history after logging a session` integration case from
`router-logic.integration.test.ts`; do not replace it with an absence test.

- [ ] **Step 3: Delete the now-unused shared Breathwork domain module**

Delete:

```text
packages/scoring/src/breathwork.ts
packages/scoring/src/breathwork.test.ts
```

Remove the `"./breathwork"` entries from both `exports` and `publishConfig.exports`
in `packages/scoring/package.json`. Remove Breathwork from the package overview
and export table in `packages/scoring/README.md`.

- [ ] **Step 4: Remove the obsolete cache invalidation domain**

Delete this entry from `USER_QUERY_PREFIXES` in `src/lib/cache.ts`:

```ts
breathwork: ["breathwork.history"],
```

Do not change generic cache behavior.

- [ ] **Step 5: Verify the server/domain removal**

Run:

```bash
pnpm vitest run --project unit packages/server/src/router.test.ts packages/scoring/src
pnpm --dir packages/server typecheck
pnpm typecheck
```

Expected: unit tests and both type checks pass without a `breathwork` tRPC
namespace or `@dofek/scoring/breathwork` export.

- [ ] **Step 6: Commit and push the API/domain removal**

```bash
git add packages/server/src/routers/breathwork.ts packages/server/src/routers/breathwork.test.ts packages/server/src/repositories/breathwork-repository.ts packages/server/src/repositories/breathwork-repository.test.ts packages/server/src/repositories/breathwork-repository.integration.test.ts packages/server/src/router.ts packages/server/src/router.test.ts packages/server/src/routers/router-logic.integration.test.ts packages/scoring/src/breathwork.ts packages/scoring/src/breathwork.test.ts packages/scoring/package.json packages/scoring/README.md src/lib/cache.ts
git commit -m "refactor: remove breathwork api"
git push
```

Expected: the removed API and domain files are committed without touching the
schema, exports, admin accounting, or provider mappings.

---

### Task 3: Stop Seed Writes and Align Active Documentation

**Files:**

- Modify: `scripts/seed/review-surfaces.ts`
- Modify: `scripts/seed/verification.ts`
- Modify: `scripts/seed/verification.integration.test.ts`
- Modify: `src/db/seed-dev-db.integration.test.ts`
- Modify: `scripts/seed-dev-db.ts`
- Modify: `scripts/README.md`
- Modify: `docs/roadmap.md`
- Preserve unchanged: `scripts/seed/core.ts`

**Interfaces:**

- Consumes: The retired client/API surface from Tasks 1 and 2.
- Produces: Development fixtures that no longer create Breathwork sessions while retaining cleanup of disposable historical seed rows.

- [ ] **Step 1: Remove active Breathwork seed generation**

In `scripts/seed/review-surfaces.ts`, remove the `seedBreathwork` call and the
entire `seedBreathwork` function. Remove `timestampAt` from the import, and
change the completion message to:

```ts
console.log("Seeded: journal entries and life events");
```

Keep the journal and life-event seed behavior unchanged.

- [ ] **Step 2: Remove Breathwork from seed verification fixtures**

Remove the `breathwork sessions` tuple from `scripts/seed/verification.ts`.
Remove the corresponding `INSERT INTO fitness.breathwork_session` fixture from
`scripts/seed/verification.integration.test.ts` and remove the
`breathworkSessions` field, query, and minimum assertion from
`src/db/seed-dev-db.integration.test.ts`.

Do not edit this preserved cleanup statement in `scripts/seed/core.ts`:

```ts
await sql`DELETE FROM fitness.breathwork_session WHERE user_id = ${userId}`;
```

It applies only to the disposable review user and prevents legacy seed rows
from accumulating; it is not a production application write path.

- [ ] **Step 3: Update active seed and roadmap documentation**

Remove Breathwork from the seed inventory comments in `scripts/seed-dev-db.ts`
and `scripts/README.md`. Remove Breathwork from the low-discoverability and
mobile-parity backlog lists in `docs/roadmap.md`, because this plan intentionally
retires that surface. Preserve historical specs, plans, and incident records.

- [ ] **Step 4: Run focused seed verification**

Run:

```bash
pnpm test:changed:all
```

Expected: the changed-files unit/mobile and integration tiers pass without
requiring or creating Breathwork sessions. Do not create a static-config or
absence test.

- [ ] **Step 5: Commit and push seed/documentation changes**

```bash
git add scripts/seed/review-surfaces.ts scripts/seed/verification.ts scripts/seed/verification.integration.test.ts src/db/seed-dev-db.integration.test.ts scripts/seed-dev-db.ts scripts/README.md docs/roadmap.md
git commit -m "chore: stop seeding breathwork sessions"
git push
```

Expected: active seed writes and documentation are removed while
`scripts/seed/core.ts` and every database artifact remain unchanged.

---

### Task 4: Verify the Read-Only Preservation Boundary

**Files:**

- Inspect: all changed files and retained Breathwork references
- Do not modify unless a verification failure identifies a direct regression

**Interfaces:**

- Consumes: Completed Tasks 1-3.
- Produces: Evidence that the active feature is gone and historical/provider data paths remain intact.

- [ ] **Step 1: Confirm active UI/API references are gone**

Run:

```bash
rg -n "breathworkRouter|BreathworkRepository|@dofek/scoring/breathwork|/breathwork|breathwork\." packages src scripts --glob '!src/db/schema/events.ts' --glob '!src/export.ts' --glob '!src/export.test.ts' --glob '!packages/server/src/routers/admin.ts' --glob '!scripts/seed/core.ts'
```

Expected: no active UI, API, repository, shared-domain, or seed-generation
matches. Investigate every result rather than broadening the exclusions.

- [ ] **Step 2: Confirm required retained references and rows have no deletion migration**

Run:

```bash
rg -n "breathwork_session" src/db/schema/events.ts drizzle/0000_baseline.sql drizzle/0065_breathwork_outcome_reports.sql src/export.ts src/export.test.ts packages/server/src/routers/admin.ts scripts/seed/core.ts docs/schema.dbml docs/schema.puml
git diff bfc6935 -- drizzle src/db/schema/events.ts src/export.ts src/export.test.ts packages/server/src/routers/admin.ts scripts/seed/core.ts docs/schema.dbml docs/schema.puml
```

Expected: the first command shows retained schema, migration, export, admin,
and cleanup references; the second command is empty.

- [ ] **Step 3: Confirm provider activity classification remains intact**

Run:

```bash
rg -n "breathwork" packages/garmin-connect packages/whoop-whoop packages/training src/providers/oura
```

Expected: canonical/provider mappings and their tests remain present and
unchanged.

- [ ] **Step 4: Run repository verification**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:changed:all
git diff --check
git status --short --branch
```

Expected: lint, type checking, Docker-free unit/mobile tests, and changed-file
integration tests all pass. The worktree contains only the user's untracked
`paseo.json` after committed changes. Correct any direct in-scope failure in
the task that introduced it, rerun that task's checks, commit the exact task
files with its specified commit command, and push; create no empty commit.
