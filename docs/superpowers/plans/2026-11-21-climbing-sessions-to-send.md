# Climbing Sessions to Send Implementation Plan

> **For agentic workers** — Use the Paseo Implementer profile for approved implementation tasks. Use superpowers:subagent-driven-development for the test-first workflow. Report unresolved architecture or source semantics to the lead before changing the approach.

**Goal** — Show the recorded route-days toward a first confirmed clean send in Dofek’s existing climb Record Detail. Show an expected session count where the shared climbing model supports one.

**Architecture** — Query the history for the selected log when its Record Detail opens. The server resolves the climb and returns observed days, first-send milestones, and any applicable estimate. The existing web dialog and iOS sheet render the same contract.

**Tech stack** — TypeScript, PostgreSQL, Drizzle, Zod, tRPC, React, and React Native.

**Design** — [First send](../../../design/climbing-sessions-to-send/first-send.html) and [in progress](../../../design/climbing-sessions-to-send/in-progress.html) in the approved Paseo Design canvas. Example climbs and values are fictional.

**Approved first release** — Ship recorded project history on web and iOS. Task 3 follows as a separate release after the send-probability workspace establishes an applicable model.

## Global constraints

- Use imported data and existing learnings from the source audit. Require neither manual entry nor a connection change. Keep the existing Activity Detail → Log details and provider Record Detail entry points. Keep existing list payloads and response versions compatible.
- Treat a session as one calendar day of observed effort on a verified whole climb. Keep indoor and outdoor histories separate. Match within a verified source climb identity and known meaningful board variant, including angle and mirror where recorded. Leave ambiguous variants or cross-provider identity links unresolved. Retain source provenance and date-access bounds.
- Preserve the distinction between an explicitly observed clean send, an explicitly unsuccessful session, and an unknown result. Generic completion, an inferred tick compatibility default, a pitch-only result and anonymous count expansions supply no clean whole-climb send. Source counts supply no extra calendar days. When an explicit unsuccessful summary is present, count-only placeholders do not change its outcome.
- Use the earliest confirmed clean send within accessible history. An earlier repeat with a missing first send yields no first-send date or count. A lone redpoint establishes one logged send day with earlier visits unknown. Later repeats do not change a confirmed milestone. Show a separate first send for an evidenced rope method when the selected record has that method and the observed method history supports it. Whole-climb history remains the default.
- History uses the record’s climb day as its upper bound. Apply account and access-window restrictions to both the selected record and related evidence. Show observed counts, including unknown-outcome days where effort is established, and qualify partial history. Unknown days and unlogged visits stay unknown.
- Preserve recorded grades for display. Estimate eligibility uses the model’s native grade scale and evidence. The published fits use outdoor V-scale bouldering, outdoor sport by advertised gear in Ewbank, French sport or UIAA, and outdoor trad or pooled sport/trad in Ewbank. There is no separate coefficient for lead, top rope, follow, solo, gym or boards. The current theCrag adapter leaves setting unknown. Keep unsupported grades, settings, methods and unknown inputs out of the estimate until an applicable fit has been evaluated. [Published paper, Table 2 and §§3.3–6](https://www.degruyterbrill.com/document/doi/10.1515/jqas-2026-0040/pdf) · [Authors’ cohort config](https://github.com/alexeid/climbing-grades/blob/f4ffdc1efd69882aa55489475202a0b2845d1c4a/R/config.csv) · [Climbing data model](../../climbing-context.md).
- The model analysis can retain repeat sends on later days. The project history stops its first-send count at the first evidenced send. The 30-record/one-explicit-failure rule belongs to the authors’ model cohort and does not gate showing history. [Authors’ daily outcome code](https://github.com/alexeid/climbing-grades/blob/f4ffdc1efd69882aa55489475202a0b2845d1c4a/R/ascents.R) · [Authors’ filtering pipeline](https://github.com/alexeid/climbing-grades/blob/f4ffdc1efd69882aa55489475202a0b2845d1c4a/R/produce-analysis-data.R).

## Eligibility by climb type and setting

Recorded history requires a verified whole-climb identity, a source climb day, and evidence of an attempt. A clean send needs explicit evidence. The grade may be unknown in recorded history. The published fit additionally requires a supported native grade and cohort. Advertised protection and the climber’s rope method are independent inputs.

| Climb type or method | Gym | Outdoor |
| --- | --- | --- |
| Boulder | Native Kaya records can support history. There is no indoor fit. | Eligible Kaya, theCrag, Mountain Project and OpenBeta records can support history. The published boulder fit uses V grades. Fontainebleau grades can appear in history. |
| Board problem | BoardSesh and eligible Aurora/Kaya records can support history. Match the recorded angle and preserve mirror, layout and revision where available. There is no board fit. | History requires a verified board variant. There is no outdoor board fit. |
| Lead on a sport route | Kaya can establish gym lead. Sport protection requires its own evidence. There is no indoor fit. | History retains both facts where supplied. Ewbank, French sport and UIAA fits use routes advertised as sport. They pool eligible rope methods. |
| Lead on a trad route | History requires independent evidence of method and protection. Current imports supplied no verified example in the audit. There is no indoor fit. | History retains both facts where supplied. Published Ewbank datasets include trad and a pooled sport/trad cohort, each pooling eligible methods. |
| Lead with unknown protection | History can show lead with protection unknown. | History can show lead with protection unknown. No fit covers an unknown-protection cohort. |
| Top rope or follow | Kaya can identify top rope. Follow requires explicit evidence. There is no indoor fit. | History retains the recorded method. The paper has no separate top-rope or follow fit. |
| Unroped, free solo or roped solo | History uses the same clean whole-climb criteria and retains recorded method. There is no solo fit. | History uses the same criteria. No published fit isolates solo efforts. |
| Aid, pitches, ice, mixed, snow, summits and non-rock activities | Separate recorded facts remain in Record Detail. The history scope is whole-climb free rock projects. | The same scope applies. An explicitly aided or hung attempt on an eligible free project can supply evidence of an unsuccessful session. |

Unknown setting or rope method stays unknown in recorded history. Unknown climb kind, a pitch-only target, or an unverified climb identity cannot establish a whole-climb project. Unknown setting is excluded from the estimate cohort. [Published study, Table 2 and §4.1](https://www.degruyterbrill.com/document/doi/10.1515/jqas-2026-0040/pdf) · [Authors’ filtering implementation](https://github.com/alexeid/climbing-grades/blob/f4ffdc1efd69882aa55489475202a0b2845d1c4a/R/ascent-filtering.R).

| Import | Evidence and limits |
| --- | --- |
| Kaya native | Source climb ID and day, gym or outdoor setting where supplied, explicit attempts or sends, and lead/top rope when recorded. |
| theCrag | Source route ID, exact day, explicit tick, and published grade and protection when supplied. The mapper leaves setting unknown. |
| Mountain Project and OpenBeta | Verified route URL/UUID and source date when supplied. Explicit outcomes can support history. Generic ticks and compatibility defaults leave the outcome unknown. |
| BoardSesh | Board type, problem UUID, mirror, angle, and source `climbedAt` timestamp. Named flash and send statuses support clean board outcomes. |
| Aurora board sources | Verified problem ID, angle and climb day where supplied. Bids and named ascents can provide evidence. A generic completion is insufficient for a clean send. |
| Kilter | Problem and angle can be identified. `createdAt` identifies when a log was created, so it cannot supply a climb day. |
| Kaya CSV, Crimpd, MoonBoard CSV, 8a.nu, Vertical-Life, workout-only and catalogue-only feeds | Current mappings lack a verified cross-date climb identity or dated route-specific outcomes. Workout sets, occurrence IDs, names, grade and summary counters cannot repair those gaps. |

A single visited day is an eligible session observation. A lone redpoint is evidence of a clean logged day and earlier attempts, with the number of earlier visits unknown. The authors found selective omission of failures and used the frequency of lone redpoints as a logging-quality signal in a sensitivity analysis. Their boulder cohorts can include repeat sends on later dates. The route cohorts exclude that repeat label. The model pipeline has no general first-send cutoff. [Published study, §§3.3 and 5.2](https://www.degruyterbrill.com/document/doi/10.1515/jqas-2026-0040/pdf) · [Authors’ outcome mappings](https://github.com/alexeid/climbing-grades/blob/f4ffdc1efd69882aa55489475202a0b2845d1c4a/R/thecrag-json.R#L13-L39) · [Import guide](../../climbing-providers.md).

## 1. Build the observed project history read

**Files** — Add `packages/server/src/repositories/climbing-project-history-repository.ts` and a PostgreSQL integration test through the climbing router. Add the typed history response in `packages/training/src/climbing-project-history.ts` and the query to `packages/server/src/routers/climbing.ts`. Follow the active record restrictions in [the current detail repository](../../../packages/server/src/repositories/climbing-activity-log-entry-repository.ts) and use [the canonical scope helper](../../../packages/server/src/lib/base-repository.ts). The observed-history path needs raw evidence to distinguish generic completion from a clean send. Keep its evidence selection local until the send-probability workspace establishes shared source-day semantics. Keep milestone derivation in this workspace.

**Interface** — `climbing.projectHistory({ logEntryId })` selects by the log entry UUID and resolves the route on the server. A selected record outside the owner or access scope yields the same not-found result as an absent record. A visible log missing a reliably identified climb or climb date returns `null`. The response carries `throughDate`, ordered observed days with `date` and `outcome` (`send`, `unsuccessful`, or `unknown`), `firstSend` as a nullable date plus observed count through that date, optional `methodFirstSend` with its recorded rope method and its date and count, and any evidence of a repeat with no preceding confirmed send. Unknown outcomes and observed totals are computed by the server. The model is unnecessary for this contract.

- [ ] Write a PostgreSQL regression for Juniper Wall with lead failures Nov 6 and 11, a clean top-rope send Nov 9, and both failure and clean lead send Nov 13. Assert exactly four observed days. Assert the first-send result is Nov 9 after two recorded sessions and the lead result is Nov 13 after three recorded lead sessions.
- [ ] Add Chalk Line with two unsuccessful days and one unknown day. Assert three observed days, two known unsuccessful days and a null first-send milestone. Include a clean flash on its only logged day, a lone redpoint, a repeat-only history, and a repeat after a known first send. Assert respectively one observed session, one observed send with earlier history unknown, an earlier send whose date and count are unknown, and an unchanged first-send milestone.
- [ ] Add regressions for same-name distinct climbs, separate gym and outdoor records, changed board angle, opposite mirror, an unverified file-import target, a pitch-only send, a missing climb date, count-expanded anonymous tries, generic completion, and OpenBeta/Mountain Project compatibility defaults. Assert these records preserve scope and unknowns. Include removed source records and another owner with the same source ID. Assert they cannot affect history.
- [ ] Check independent calendar-date and access boundaries. A source date takes priority over time derived from a verified climb timestamp. An Activity attachment or Kilter log creation time alone cannot create a climb day. For verified timestamps, exercise a UTC/local midnight boundary. Compare attached and unattached equivalents. Reject selection outside the grant and exclude earlier or later evidence outside the granted date scope or after the selected record.
- [ ] Run the focused PostgreSQL suite and router contract tests before implementing. Verify that they fail on missing behavior. Implement the read using indexed owner and climb identity lookups and existing Zod SQL boundaries. Apply known same-day send precedence. Count distinct dates within each permitted scope. Assemble first-send milestones from the same eligible route-days used to display history. Retain source tags and grade labels through existing record details rather than duplicating them in history.
- [ ] Run the tests again and review the actual diff for owner isolation, deterministic grouping, historical dates, and work performed only when opening detail. Verify no runtime change to the existing activity/provider list contracts.

Run the database regression with `rtk proxy pnpm test:integration -- packages/server/src/routers/climbing-project-history.integration.test.ts`.

## 2. Render the approved project history on web and iOS

**Files** — Extend [web ClimbingLogEntryDetails](../../../packages/web/src/components/ClimbingLogEntryDetails.tsx) and [iOS ClimbingLogEntryDetails](../../../packages/mobile/components/ClimbingLogEntryDetails.tsx), along with their colocated tests and Storybook stories. Both currently render in the corresponding [web RecordDetailModal](../../../packages/web/src/pages/RecordDetailModal.tsx) and [iOS ProviderRecordDetailModal](../../../packages/mobile/components/providers/provider-record-detail-modal.tsx). Route query loading and failure through each platform’s established rendering patterns and make expansion accessible.

- [ ] Write failing client tests on both platforms for an eligible first-send record, an ongoing record with unknown results, and an unsupported record. Assert the Project history appears below Grades, that the counts come from the server, and that View sessions reveals the observed dates. Assert opening one record and then another keeps the route-days bound to the correct record ID. Verify that the existing record stays usable while a separate history read loads or fails.
- [ ] Implement the shared-query consumption in the existing details. For the approved states, render “2 logged sessions to first recorded send” and “3 logged sessions · Send unconfirmed.” Use known date/method context and the method-specific first-send line when available. List the unknown day with “Result unknown.” Keep the actual Recorded result and other log attributes where they are.
- [ ] Add stories for both approved states and significant unavailable/partial states. Verify expansion on web and iOS and direct Storybook links for review. Run the focused noninteractive unit/mobile tests and then the full applicable repository checks before shipping.

Run the client tests with `rtk proxy pnpm exec vitest run --project unit --project mobile packages/web/src/components/ClimbingLogEntryDetails.test.tsx packages/mobile/components/ClimbingLogEntryDetails.test.tsx`.

## 3. Add the expected session count after shared model validation

**Dependency** — The send-probability workspace owns validation, cohort and native grade mapping, time-varying ability and any serving implementation. Use its evaluated **per-session** relationship for a fresh project at the supported grade and reference ability. A forecast validated only for the next session of an already practiced climb cannot be treated as fresh-project timing without supporting evaluation. Confirm the shared serving signature after that workspace has selected and evaluated a model.

- [ ] Validate the documented definition against the shared fit and the user’s approved timing scope. With fixed session probability `p`, Equation 5 gives `(1 − p) / p` failed sessions on average. Including one success day gives `1 / p` total. At `p = 0.5`, the means are one unsuccessful session and two total sessions. If the validated fit provides a probability posterior, evaluate the transform on its draws and retain the resulting uncertainty. A finite count requires an applicable supported probability. [Published paper, §§3.2–3.3 and 6](https://www.degruyterbrill.com/document/doi/10.1515/jqas-2026-0040/pdf).
- [ ] Write failing cases for the `p = 0.5` reference, a mismatched setting, unmatched grade scale, unsupported or missing fit, an attempt-based probability, and a probability series with nonfinite expected sessions. Assert no numerical display in unsupported cases and that logged failures are not subtracted from total expected sessions. Verify title copy “Expected sessions to send” and the fresh-project qualification including the send day.
- [ ] Consume the shared fit in the server history flow. Add the expected sessions disclosure only on eligible in-progress records. Include a short plain-language explanation such as “About 4 sessions for a new outdoor V4 project at your current level, including the send day.” In the approved user-facing disclosure, use product language.
- [ ] Confirm estimation evidence and review it separately from descriptive history. Run lint, recursive typechecks, focused noninteractive client tests, and real-engine integration tests. Verify compatibility and inspect the completed web and iOS surfaces. Commit and push validated implementation chunks per repository policy.

Run `rtk proxy pnpm lint` and `rtk proxy pnpm --recursive --include-workspace-root --if-present typecheck` for each releasable application change, along with the applicable focused tests above.

## Review focus

- Identity collisions and source dates take priority over a plausible but unverified merge or workout date. Task 1 includes both cases.
- One clean send on a day, unknown results, same-day failures, and repeat-only histories must lead to distinct outcomes. Task 1 includes each case.
- Data-window restrictions must apply to linked history, including already recorded past sends. Task 1 tests selection and related evidence.
- A quickly changed selection can otherwise show the previous climb’s data. Task 2 verifies query identity in both clients.
- A probability can come from the wrong unit, a different population, or a model that only forecasts practiced routes. Task 3 checks the unit and eligibility and requires evidence for the fresh-project use.
