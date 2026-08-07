# Get Started Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make landing-page Get started CTAs send new users into a polished, resumable onboarding checklist.

**Architecture:** Keep product decisions in `@dofek/onboarding`, then render them in web and mobile. Web adds an auth-gated `/onboarding` route and login `returnTo` support; mobile adds an equivalent onboarding screen that points into provider setup.

**Tech Stack:** TypeScript, React, TanStack Router, Expo Router, Vitest, React Testing Library.

---

## Task 1: Shared Onboarding Flow

**Files:**
- Create: `packages/onboarding/src/get-started-flow.ts`
- Test: `packages/onboarding/src/get-started-flow.test.ts`

- [x] **Step 1: Write failing tests**

Assert that goal options and checklist steps are non-empty, have stable IDs, and include provider setup plus first insight steps.

- [x] **Step 2: Implement minimal metadata**

Export goal options and checklist steps as readonly arrays with descriptive IDs and layman-readable labels.

## Task 2: Web Get Started Route

**Files:**
- Modify: `packages/web/src/routes/__root.tsx`
- Modify: `packages/web/src/routes/login.tsx`
- Modify: `packages/web/src/pages/LandingPage.tsx`
- Create: `packages/web/src/pages/OnboardingPage.tsx`
- Create: `packages/web/src/pages/OnboardingPage.test.tsx`
- Create: `packages/web/src/routes/onboarding.tsx`
- Modify generated route tree after route generation.

- [x] **Step 1: Write failing tests**

Assert landing CTAs link to login with `returnTo=/onboarding`, login OAuth links preserve a safe `return_to`, and onboarding renders the shared checklist.

- [x] **Step 2: Implement route and page**

Add `/onboarding`, validate `returnTo`, render goal selection and checklist, and keep provider setup linked to `/settings`.

## Task 3: Mobile Parity

**Files:**
- Create: `packages/mobile/app/onboarding.tsx`
- Create: `packages/mobile/app/onboarding.test.tsx`

- [x] **Step 1: Write failing tests**

Assert the mobile screen renders the same shared goals and navigates provider setup to `/providers`.

- [x] **Step 2: Implement screen**

Use local selected-goal state and existing app colors/components.

## Task 4: Docs and Verification

**Files:**
- Modify: `docs/roadmap.md`

- [x] **Step 1: Update roadmap**

Record the chosen flow: goal, source setup, mobile path, first useful insight.

- [x] **Step 2: Run focused checks**

Run unit tests for changed packages and typecheck the touched packages.

Focused tests, formatting, onboarding typecheck, and web typecheck pass. Mobile typecheck still
fails on a pre-existing `src/db/clickhouse-sql.ts` URL type mismatch outside the onboarding files.
