# Training Progression Status Implementation Plan

> For implementers, follow the approved task scope and the repository test policy. Use test-driven development for each behavior change.

**Goal** — Show the athlete whether their recorded training supports readiness to progress or a flat strength benchmark, with evidence they can inspect.

**Architecture** — The server interprets canonical strength sets and comparable recorded cycling intervals. Reuse the existing Strength, Activity Detail, and Home screens on web and iOS. Existing Postgres and ClickHouse sources remain the owners of training records.

**Tech stack** — TypeScript, tRPC, React, Expo, Vitest, Postgres, and ClickHouse.

**Approved design** — [Training progression mockups](../../../design/training-progression/design.json) and the confirmed scope to surface a read-only Home summary, Strength evidence, and cycling Activity Detail evidence on both platforms. A repeatable rep improvement without a usable effort rating gets evidence text without a readiness badge.

## Global requirements

- Render recorded work and explanatory status. Use completed reps and optional recorded perceived effort. No targets, prescribed changes, fitness diagnosis, questionnaire, new workout entry, or reps-in-reserve field.
- Require comparable observations, including exercise and equipment or a comparable recorded cycling interval sequence. Status can be absent. Whole-ride effort is displayable where imported and cannot establish interval readiness on its own.
- Own selection and metric calculations on the server. Clients format returned evidence, use existing units and accessibility conventions, and link to the existing detail experience where practical.
- Reuse canonical user-scoped activity identity, set deduplication, visibility, provider provenance, and local dates. Use bounded reads and existing repositories. Allow old provider records and absent optional fields.
- Strength decisions use a bounded 56-day window. A flat result describes the measured benchmark across the observed period. The observation count and tolerance are product heuristics, separate from the reported values.

## Review cases

- Cross-provider duplicate sets or rides, mixed equipment, and mismatched activity modalities cannot manufacture repeated evidence.
- Missing, conflicting, or incomparable effort allows a demonstrated rep improvement with no training-status badge and leaves cycling status unavailable.
- A single good or poor day, a short block, and small deviations within normal variation cannot each establish a status on their own.
- API authorization applies to both the selected activity and comparison history, including a caller's date entitlement.
- The two clients render the same status labels and evidence. An empty response leaves each page's other content usable.

## Task 1. Strength evidence and contract

**Files** — `packages/server/src/repositories/strength-progression-repository.ts`, its colocated integration and unit tests, the new `packages/server/src/routers/training-progression.ts` registered in `packages/server/src/router.ts`, and a focused internal comparison module with colocated tests if needed.

**Interface** — Add a protected, cached, bounded `trainingProgression.strength` query returning per-exercise results keyed by exercise name and equipment, with the canonical exercise ID, a nullable `status` of `ready` or `stagnating`, and discriminated evidence `rep_improvement` or `flat_benchmark`. Evidence includes dated, source-backed observations with recorded weight and reps, optional perceived effort, and activity IDs. Results include the most recent evidence date so Home can select the latest result on the server or consume the server's first eligible result. Return arrays in deterministic newest-first order.

- [x] Add test coverage through the repository and route for three same-lift sessions on distinct dates with comparable working sets at 60 kg for 8, 10, 10 reps. All three at similarly recorded effort produce `ready`. Missing effort still produces `rep_improvement` with null status. A harder or incomparable reported effort produces null status.
- [x] Add a flat-benchmark case with at least six comparable distinct session dates spanning at least 28 days. Favor an existing admissible estimated one-rep-max benchmark of the same exercise, equipment, and effort protocol, and report its observed range. Use an explicit 2.5% maximum range relative to the lowest estimate as a documented initial heuristic. Keep comparisons from distinct compatible rep protocols separate. Confirm that a sparse block does not qualify and an increase outside the tolerance does not show stagnation.
- [x] Run the focused tests and observe failing assertions before implementing. Reuse the strength repository's canonical set reads and the current strength estimate logic. Compare the same set ordinal and working-set context, at the same recorded load and on the same source effort scale. Use a maximum 0.5-point spread across compared ratings as the initial similarity rule. Return source references with the evidence.
- [x] Run unit tests and real Postgres integration tests for ownership, entitlement, deduplication, and optional effort.

## Task 2. Cycling evidence on Activity Detail

**Files** — `packages/server/src/routers/training-progression.ts`, existing interval and repeated-workout repositories, and focused tests. Retain existing plan-comparison and decoupling behavior.

**Interface** — `trainingProgression.cycling` accepts an activity ID and returns either null or a cycling `ready` result and two dated, source-backed ride observations with interval count, work duration and average measured power, and imported session effort. Preserve the existing session effort display outside this feature.

- [x] Test two authorized rides with a matched workout and equivalent recorded work intervals with measured power and session effort at most 5/10. Test missing ratings, inferred intervals, unmatched work, and inaccessible rides.
- [x] Observe expected failures. Reuse existing workout identity and recorded interval evidence, including current power provenance and session-level perceived exertion. Use exact known workout identity where available, plus the same count of explicitly recorded work intervals. Each corresponding interval must be within 5% of recorded duration and measured mean power for this first pass. Restrict the sample to the selected ride and its most recent eligible earlier comparable ride in 56 days. Read the ride's imported effort from the current activity detail data. Keep return null when comparison evidence is incomplete.
- [x] Verify behavior with focused unit and real-engine integration checks. Keep history lookups bounded, and report input or repository limitations to the lead before changing the approach.

## Task 3. Web and iOS status surfaces

**Files** — Home in `packages/web/src/pages/Dashboard.tsx` and `packages/mobile/app/(tabs)/index.tsx`, Strength in `packages/web/src/routes/training/strength.lazy.tsx` and the mobile Strength section, and existing activity detail in both packages. Use platform-local components with colocated Storybook stories for new visual components.

- [x] Write client tests for ready, stagnating, recorded improvement without a badge, and empty data on both platforms. Test the disclosure and existing detail navigation where present. Observe failures first.
- [x] Show one latest eligible strength status on Home. Show the selected lift's state and evidence on Strength. Show cycling results on the relevant activity, including the distinction between recorded interval work and the ride's overall Session effort. Render dates, units, and copy for the shared server result on both platforms. Keep other page content present when the status is unavailable.
- [x] Verify focused web and mobile tests and inspect the status and evidence stories at phone width. Verify selected exercise changes and disclosure controls in the client tests.

## Task 4. Final verification and review

- [x] Review scope, evidence rules, metric ownership, access windows, async and empty states, compatibility, and web/iOS parity. Resolve material findings.
- [x] Run `pnpm lint`, `pnpm --recursive --include-workspace-root --if-present typecheck`, relevant noninteractive unit/mobile tests, and real-engine integration tests for database behavior. Use the workspace Compose wrapper and the integration readiness runbook if needed.
- [ ] Commit and push each reviewed, meaningful slice. Verify remote CI and report any remaining evidence or verification limits.
