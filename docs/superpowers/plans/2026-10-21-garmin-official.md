# Official Garmin implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax for tracking.

**Goal:** Replace the private Garmin path with official OAuth and durable push ingestion while preserving history and platform parity.

**Architecture:** Reuse shared OAuth, token encryption, queues, R2 and FIT ingestion. Add explicit push-only capability and portal-configured receiving rather than fake API subscriptions. Replace only Garmin-specific transport and mappings.

**Tech Stack:** TypeScript, Zod, Drizzle/Postgres, BullMQ, existing AWS S3 client, Vitest, React and React Native.

**Spec:** [Approved direction and design](../specs/2026-10-21-garmin-official-design.md).

## Global constraints

- Keep provider IDs `garmin` and `garmin-dump`; preserve existing raw records.
- Use official OAuth with PKCE and server-side client authentication.
- Verify webhook sender authentication; public identifiers do not authenticate.
- Do not poll push-only sources or mask event failures with full-sync fallback.
- Parse boundary data with Zod; no `any`, test-only exports, or suppressed errors.
- Persist one-use downloads before parsing; retain account/provider erasure ownership.
- No expenditure calories or unrelated new product data.
- Both clients keep OAuth connect/reconnect but hide manual polling actions.
- Reconnect preserves Garmin registration and replaces credentials after a same-account identity check; switching Garmin accounts requires disconnect first. Registration deletion belongs only to explicit Disconnect/account erasure. All failed OAuth attempts preserve remote consent for retry, and failed reconnects retain the existing local connection ([lifecycle contract](https://developerportal.garmin.com/developer-programs/programs-docs)).
- Test first; integration tests execute database behavior without module mocks.
- Never commit credentials or confidential source documents. Required secrets must exist in Infisical.
- Stay on the existing branch; root performs final checks, commits and automatic pushes.

## Review focus

- A corrected health summary must replace previous values/stages, including explicit empty stages.
- An official token must be attached to its stable owner before any notification is accepted.
- Download/parse retries must retain the received FIT even after its callback URL expires.
- A revoked or deleted connection must fence delayed jobs and retained artifacts.
- OAuth-connected push-only sources must remain connectable on both clients.

## Task 1: Official OAuth and payload boundary

**Files:** Create `src/providers/garmin/oauth.ts`, `src/providers/garmin/payloads.ts` and colocated unit tests. Existing private provider remains until task 2 switches it.

**Interfaces:** `createGarminAuthSetup(fetchFn, host?)` returns `ProviderAuthSetup`; `parseGarminWebhookPayload(body)` returns `WebhookEvent[]` with stable `ownerExternalId`, feed `objectType`, `objectId`, and original validated record in `metadata.payload`. Export payload schemas only where production writers consume them.

- [x] Add tests for PKCE/client authentication, required stable account ID, rotating refresh, permission retrieval, deregistration and strict callback URL validation.
- [x] Add tests for supported activity/health/lifecycle payloads, numeric/string activity identity, missing values, provisional/corrected sleep and invalid boundaries.
- [x] Run `rtk pnpm vitest run --project unit src/providers/garmin/oauth.test.ts src/providers/garmin/payloads.test.ts`; record expected failures before implementing.
- [x] Implement the official contract from current authorized documentation using existing OAuth helpers.
- [x] Rerun focused tests and obtain independent spec/quality review.

## Task 2: Durable receiving, ownership and ingestion

**Files:** Modify `src/providers/garmin/provider.ts`; create focused Garmin health/activity persistence and artifact modules; modify token/schema repository, server routes, job execution and erasure boundaries as required by the approved design.

**Interfaces:** Provider exposes official auth, `pushOnly: true`, parsed notification events and targeted processing. Incoming delivery uses a real portal-configured authentication mechanism and existing queue envelopes. Storage ownership and token lookup remain in repository/domain modules.

- [x] Write and run failing owner-lookup and ingestion database integration tests with minimal fixtures.
- [x] Write and run failing unit tests for authenticating, rejecting malformed/unowned input, durable enqueue, original-event retries and retained artifact replay.
- [x] Implement the smallest indexed encrypted-owner lookup if required, with its forward migration and legacy-token reconnect transition.
- [x] Implement queued health updates, FIT archival/import and official disconnect/permission handling. Preserve partial fields and source identity; do not derive missing metrics.
- [x] Run focused unit and integration suites, apply migrations locally, and obtain independent review.

## Task 3: Push-only capability and both clients

**Files:** Provider interfaces/model, scheduler/manual trigger, `sync` API projection, existing provider cards/auth modals/detail actions on web and mobile, corresponding tests/stories.

- [x] Write failing tests proving push-only Garmin is OAuth-connectable but not scheduled/manually polled, with no scheduled-staleness warnings.
- [x] Write failing web/mobile tests for connect/reconnect and automatic delivery instructions.
- [x] Implement the explicit capability, remove Garmin credential UI/router and use generic OAuth flows.
- [x] Update stories and run relevant unit/mobile tests and typechecks; obtain independent review.

## Task 4: Remove obsolete runtime paths and finish setup

**Files:** Old Garmin private sync modules/tests, shared Garmin throttle overrides, dependency/package references, provider documentation and configuration.

- [x] Remove obsolete private sync/checkpoint/query implementations and their tests; retain source history and export/FIT import.
- [x] Remove Dofek's private-client runtime dependency. Treat changes to published package distribution separately from runtime replacement.
- [x] Update active docs, auth metadata, targeted API fixtures and any affected build references.
- [x] Register/configure the Starter app once required company facts are supplied, store app secrets in Infisical, and configure the verified receiving endpoint only when it is ready.
- [ ] Run lint, root/server/web typechecks, all affected unit/mobile suites and real database integration tests. Build/runtime checks are required if packaging changes.
- [ ] Obtain whole-change review, fix findings and rerun covering checks. Commit and push automatically.
- [ ] Report remaining external authorization/production validation prerequisites accurately; do not call an untested production cutover complete.

## Working checkpoints

- Direction: user explicitly approved official migration after the research assessment.
- Initial repository: clean branch `explore-garmin-developer-program`, research commit `585bfa7`.
- Review checkpoints: task 1, task 2, task 3, final whole change.
- Setup completed: approved Starter app, production secrets, and ten authenticated receiving feeds configured and verified On Hold. See the [release checks](../../garmin.md#operator-configuration-and-release-checks).
- Final review follow-ups: preserve registration on reconnect; preserve known summary metadata when a sparse FIT notification follows it.
- Local validation gap: the shared provider-deletion ClickHouse fixture exceeds the existing local memory cap before tests execute. Hosted integration validation remains required; see the [incident baseline](../../production-incident-baseline.md).
- Production deployment, real OAuth consent, and live Health/FIT delivery remain unverified. Do not release held delivery until those checks pass.
