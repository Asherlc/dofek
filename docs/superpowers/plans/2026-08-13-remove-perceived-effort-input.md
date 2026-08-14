# Remove Perceived-Effort Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the activity-level perceived-effort input from the web and iOS activity-detail screens without changing RPE data or APIs.

**Architecture:** The input is encapsulated in parallel web and mobile `ActivityPerceivedExertion` components. Delete those components and their direct page imports/render calls, then remove the tests and stories that solely exercise the deleted controls. The activity-detail data contract and separate strength RPE surfaces remain unchanged.

**Tech Stack:** React, React Native, TypeScript, Vitest, Storybook.

## Global Constraints

- Maintain web/mobile parity by removing the equivalent activity-detail input from both clients.
- Preserve `fitness.activity.perceived_exertion`, the session-RPE activity API, and non-input RPE UI.
- Do not add negative-assertion tests for the absence of the deleted UI.
- Do not modify unrelated `paseo.json`.

---

### Task 1: Delete the activity-level perceived-effort input

**Files:**
- Delete: `packages/web/src/components/ActivityPerceivedExertion.tsx`
- Delete: `packages/web/src/components/ActivityPerceivedExertion.test.tsx`
- Delete: `packages/web/src/components/ActivityPerceivedExertion.stories.tsx`
- Modify: `packages/web/src/pages/ActivityDetailPage.tsx:36,224`
- Delete: `packages/mobile/components/ActivityPerceivedExertion.tsx`
- Delete: `packages/mobile/components/ActivityPerceivedExertion.test.tsx`
- Delete: `packages/mobile/components/ActivityPerceivedExertion.stories.tsx`
- Modify: `packages/mobile/app/activity/[id].tsx:32,838`
- Modify: `packages/mobile/app-tests/activity/[id].test.tsx:504-516`

**Interfaces:**
- Consumes: Existing `ActivityDetailPage` and mobile activity-detail screen, which currently import and render `ActivityPerceivedExertion`.
- Produces: Activity-detail screens with no session-RPE input; all activity data and APIs retain their existing types and behavior.

- [x] **Step 1: Confirm the affected code is exclusively the deleted input**

Run: `rtk rg -n "ActivityPerceivedExertion" packages/web/src packages/mobile`

Expected: Only the two page imports/render calls and the six component, test, and Storybook files are returned. Do not alter `FingerLoadingLog`, strength-set RPE presentation, or server RPE code.

- [x] **Step 2: Delete the web input and its ownership references**

Delete `packages/web/src/components/ActivityPerceivedExertion.tsx`, its colocated test, and its Storybook story. In `packages/web/src/pages/ActivityDetailPage.tsx`, remove exactly:

```tsx
import { ActivityPerceivedExertion } from "../components/ActivityPerceivedExertion.tsx";
```

and:

```tsx
<ActivityPerceivedExertion activityId={id} value={activity.perceivedExertion} />
```

- [x] **Step 3: Delete the mobile input and its ownership references**

Delete `packages/mobile/components/ActivityPerceivedExertion.tsx`, its colocated test, and its Storybook story. In `packages/mobile/app/activity/[id].tsx`, remove exactly:

```tsx
import { ActivityPerceivedExertion } from "../../components/ActivityPerceivedExertion";
```

and:

```tsx
<ActivityPerceivedExertion activityId={id ?? ""} value={activity.perceivedExertion} />
```

Delete the existing `renders the activity's session perceived exertion control` test from `packages/mobile/app-tests/activity/[id].test.tsx`; it tests only the intentionally removed control.

- [x] **Step 4: Verify deletion and client integrity**

Run:

```bash
rtk rg -n "ActivityPerceivedExertion" packages/web/src packages/mobile
rtk pnpm test -- --run packages/web/src/pages/ActivityDetailPage.test.tsx packages/mobile/app-tests/activity/[id].test.tsx
rtk pnpm typecheck
rtk pnpm lint
```

Expected: The search has no matches; the activity-detail test files pass; typecheck and lint exit successfully. The project rule against absence tests applies, so no new test is introduced solely to assert that the input is gone.

- [x] **Step 5: Commit and push only this task's files**

```bash
rtk git add \
  packages/web/src/pages/ActivityDetailPage.tsx \
  packages/mobile/app/activity/[id].tsx \
  packages/mobile/app-tests/activity/[id].test.tsx \
  packages/web/src/components/ActivityPerceivedExertion.tsx \
  packages/web/src/components/ActivityPerceivedExertion.test.tsx \
  packages/web/src/components/ActivityPerceivedExertion.stories.tsx \
  packages/mobile/components/ActivityPerceivedExertion.tsx \
  packages/mobile/components/ActivityPerceivedExertion.test.tsx \
  packages/mobile/components/ActivityPerceivedExertion.stories.tsx
rtk git commit -m "Remove activity perceived effort input"
rtk git push
```

Expected: The commit excludes `paseo.json` and the already-committed design/plan documents.
