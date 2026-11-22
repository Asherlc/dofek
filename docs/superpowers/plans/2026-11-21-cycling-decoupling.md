# Cycling decoupling implementation plan

The approved [Canvas mockup](../../../design/cycling-decoupling/repeat-rides.html) shows one repeated workout and one dot per qualifying ride. Selecting a dot shows the ride date, elapsed duration, the mean watts and heart rate for each half, and paired coverage. Use the existing Cycling date range in both clients. The two Canvas revisions removed the ride-setting control and the method-note line. The empty state explains that the selected range has no matching rides with usable paired signals.

Use a bounded server query over existing ClickHouse activity, identity, and sensor models and reuse the workout calculation in `@dofek/training`. Treat the observed power-to-heart-rate change as descriptive. The [Barsumyan equation](https://link.springer.com/article/10.1186/s13102-026-01678-w) supplies the first-half denominator. The approved adaptation applies it to repeated recorded workouts of varying duration. Dofek's existing 20-minute and 90%-per-half limits govern data coverage. Workout identity establishes repetition. Hydration and other conditions can change HR between or within rides. [Montain and Coyle](https://pubmed.ncbi.nlm.nih.gov/1447078/)

## 1. Reuse the cycling calculation

Files: `packages/training/src/cycling-workout-metrics.ts` and its colocated tests.

- [ ] Add failing tests for the shared calculation. A 20-minute effort at 200 W with 100 then 125 bpm gives 20.0% power-to-HR decoupling. Equal ratios give 0%, and an increase in the ratio gives a negative result. A first-half ratio of zero is unavailable. A recorded zero power second contributes to the mean and coverage. Missing seconds and invalid HR do not contribute, and 89% paired coverage in either half makes the result unavailable.
- [ ] Extract the existing equal-elapsed-halves logic into `summarizeCyclingDecoupling(power: Array<number | null>, heartRate: Array<number | null>)` in the workout module. Use the existing resampled seconds, midpoint, coverage policies, paired averaging and method identifier. Return percent or null and both halves' paired seconds, mean watts, mean bpm, and coverage percent. Calculate the ratio from unrounded paired totals. The existing workout MCP adapter keeps its shape and label and calls the shared computation. TrainingPeaks's normalized-power Efficiency Factor and the HR-only drift formula remain distinct.
- [ ] Run the training unit test in non-watch mode and review the calculation including the zero-denominator guard.

## 2. Serve one exact repeat-workout series

Files: `packages/server/src/repositories/cycling-decoupling-repository.ts`, its real ClickHouse integration test, `packages/server/src/routers/cycling.ts`, and `packages/server/src/lib/date-window.ts`.

- [ ] Write and run failing repository integration fixtures. A repeat group consists of at least two canonical user-owned cycling rides with the same exact provider-workout namespace and value. Use distinct canonical IDs and exclude tombstones, other users, rides outside the selected date range or entitlement, similarly named unlinked rides, and per-ride IDs. Include repeated Peloton class identity as a realistic provider fixture. Verify the result excludes known estimated streams, preserves unknown provenance, date-filters candidates before calculating, and keeps same-day workouts distinct. Test an insufficient paired half and a group with only one eligible result.
- [ ] Implement `CyclingDecouplingRepository.getTrend(range: ChartRange)` and the cached protected `cycling.decoupling` query using the selected chart range registry. Return `{ workoutName: string | null, rides: [...] }` through a Zod output schema. Each ride includes canonical activity ID, name, local date, elapsed duration, percent, each half's mean watts, mean bpm, paired seconds and coverage percent, and recorded power/HR measurement kind or unknown. Use the existing date/access-window helpers. The chart response orders points chronologically and uses the newest eligible ride's name for the cohort label, with a generic label when the name is absent.
- [ ] Read exact `provider_workout` identities from `analytics.activity_effort_identity FINAL` for canonical cycling activities with recorded end times. Place a server-side bound of 25 recent candidate rides, matching the existing cycling workout sample query's page size. Filter to repeated identity groups before selecting candidates. Read only power and HR from `analytics.activity_sensor_sample FINAL` for those user-scoped canonical IDs and their recorded time bounds. Reuse `resampleCyclingStream` with the shared `cyclingPowerCoveragePolicy` and `summarizeCyclingDecoupling`. Known estimated power or HR disqualifies a ride. Preserve unidentified sensor sources as unknown. Respect recorded cycling modality as context and keep eligibility independent of a ride-setting selector. Pick the series containing the most recent eligible ride with at least one other eligible ride of the same identity. Return an empty series if no group qualifies.
- [ ] Run focused real-engine integration and router/unit tests. Document the source selection, bounded request, eligibility, and limitations in the training/server guides. Keep the existing efficiency query and Zone 2 chart behavior intact.

## 3. Render the Cycling section in both clients

Files: `packages/web/src/routes/training/cycling.tsx`, `packages/mobile/app/strain.tsx`, and colocated chart components, stories, and tests in the established chart locations.

- [ ] Add failing web and mobile tests for date plumbing, the empty state, and selecting a point to see both halves' values. Verify the chart never shows an empty details box and the selected workout links to its activity detail.
- [ ] Use existing chart primitives, the existing Cycling screen, and standard loading, error, and empty states. Render the approved chart and details with server-computed metrics. Keep coverage, identity, source context when recorded, and the sign explanation. Show one matched workout series and use accessible point selection. Use the existing date selector and preserve usable data on refetch. Include default, loading, and empty stories.
- [ ] Run the focused web/mobile tests. Review both layouts and the interaction against Canvas.

## Whole-change verification

- [ ] Review authorization and date limits, exact identity grouping and deduplication, sensor coverage/provenance, formula and sign, and web/mobile parity independently of the mechanical edits.
- [ ] Run repository lint, all-package typecheck, relevant non-watch unit/mobile tests, and real-engine integration. Report actual outcomes and any environment blockers. Commit meaningful chunks and push each commit.
