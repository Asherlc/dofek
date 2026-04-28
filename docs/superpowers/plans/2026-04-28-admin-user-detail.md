# Admin User Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a click-through admin user detail page with local-only flag and free-access controls plus Stripe Dashboard links.

**Architecture:** Extend the existing admin tRPC router with a richer user detail payload and two local mutation endpoints. Add a focused React page for `/admin/users/$userId` and keep the current admin users table as the entry point. No schema migration is required because the feature uses existing `user_profile`, `user_settings`, and `user_billing` fields.

**Tech Stack:** TypeScript, tRPC, Drizzle SQL templates, Zod, TanStack Router, React, TanStack Query, Vitest.

---

### Task 1: Server Admin Detail API

**Files:**
- Modify: `packages/server/src/routers/admin.test.ts`
- Modify: `packages/server/src/routers/admin.ts`

- [ ] **Step 1: Write failing router tests**

Add tests that expect `admin.userDetail` to return profile, flags, billing, derived access, Stripe links, accounts, providers, and sessions. Add mutation tests for `setProviderGuideDismissed` and `setPaidGrant`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/server/src/routers/admin.test.ts`

Expected: tests fail because `userDetail` does not return the new fields and the new mutations do not exist.

- [ ] **Step 3: Implement minimal server changes**

In `packages/server/src/routers/admin.ts`:

- import `PROVIDER_GUIDE_SETTINGS_KEY`;
- import `resolveAccessWindow`;
- add schemas for profile, settings flag, and billing rows;
- query profile, provider guide setting, billing row, accounts, providers, and sessions in `userDetail`;
- derive access with `resolveAccessWindow`;
- build Stripe Dashboard URLs from local Stripe IDs;
- add `setProviderGuideDismissed`;
- add `setPaidGrant`.

- [ ] **Step 4: Run server test to verify it passes**

Run: `pnpm vitest run packages/server/src/routers/admin.test.ts`

Expected: pass.

- [ ] **Step 5: Commit server API**

Run:

```bash
git add packages/server/src/routers/admin.ts packages/server/src/routers/admin.test.ts
git commit -m "feat: extend admin user detail api"
```

### Task 2: Web Admin User Detail Page

**Files:**
- Modify: `packages/web/src/pages/AdminPage.tsx`
- Create: `packages/web/src/pages/AdminUserDetailPage.tsx`
- Create: `packages/web/src/pages/AdminUserDetailPage.test.tsx`
- Create: `packages/web/src/routes/admin/users/$userId.tsx`
- Modify: `packages/web/src/routeTree.gen.ts`

- [ ] **Step 1: Write failing web tests**

Add tests that verify:

- `AdminPage` users table renders a link to `/admin/users/{id}`;
- `AdminUserDetailPage` renders profile, flags, billing state, and Stripe links;
- toggles call `setAdmin`, `setProviderGuideDismissed`, and `setPaidGrant`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/web/src/pages/AdminUserDetailPage.test.tsx`

Expected: fail because the page does not exist.

- [ ] **Step 3: Implement the page and route**

Create a dedicated detail page that:

- gates on `user?.isAdmin`;
- reads `userId` from route params;
- calls `trpc.admin.userDetail.useQuery({ userId })`;
- renders profile, flags, billing, Stripe links, auth accounts, providers, and recent sessions;
- uses mutations and invalidates the detail query on success.

Update `AdminPage` to link each user row to `/admin/users/{id}`.

- [ ] **Step 4: Regenerate route tree**

Run: `cd packages/web && pnpm exec tanstack-router generate`

Expected: `packages/web/src/routeTree.gen.ts` includes `/admin/users/$userId`.

- [ ] **Step 5: Run web tests to verify they pass**

Run: `pnpm vitest run packages/web/src/pages/AdminUserDetailPage.test.tsx`

Expected: pass.

- [ ] **Step 6: Commit web page**

Run:

```bash
git add packages/web/src/pages/AdminPage.tsx packages/web/src/pages/AdminUserDetailPage.tsx packages/web/src/pages/AdminUserDetailPage.test.tsx packages/web/src/routes/admin/users/\$userId.tsx packages/web/src/routeTree.gen.ts
git commit -m "feat: add admin user detail page"
```

### Task 3: Final Verification

**Files:**
- Verify full changed behavior.

- [ ] **Step 1: Run focused checks**

Run:

```bash
pnpm vitest run packages/server/src/routers/admin.test.ts packages/web/src/pages/AdminUserDetailPage.test.tsx
```

Expected: pass.

- [ ] **Step 2: Run repo-required pre-push checks**

Run:

```bash
pnpm lint
pnpm test:changed
pnpm tsc --noEmit
cd packages/server && pnpm tsc --noEmit
cd ../web && pnpm tsc --noEmit
```

Expected: all commands exit 0.

- [ ] **Step 3: Push**

Run:

```bash
git push
```

Expected: branch pushes to `origin/Asherlc/admin-user-detail`.

## Self-Review

Spec coverage:

- Dedicated detail page: Task 2.
- Users table click-through: Task 2.
- Local account flags: Tasks 1 and 2.
- Local billing free-access control: Tasks 1 and 2.
- Stripe Dashboard links: Tasks 1 and 2.
- No Stripe mutations or schema migration: Task 1 uses existing local fields only.

Placeholder scan: no TBD, TODO, or unspecified implementation slots remain.

Type consistency: route param is `userId`; API procedures are `userDetail`, `setAdmin`, `setProviderGuideDismissed`, and `setPaidGrant`; local grant reason is `admin_grant`.
