# Climbing Send Probability Implementation Plan

> **For agentic workers:** Use the Paseo Implementer profile for approved tasks. Use superpowers:subagent-driven-development as the task-by-task execution workflow. Steps use checkboxes for tracking.

**Goal** — Let a climber search their imported climbs by name or location and see the estimated chance of a clean send the next day they try the selected climb.

**Architecture** — Reuse Dofek’s owner-scoped climbing records and the existing Training → Climbing screen. Validate forecasts offline before adding an application forecast path. The server supplies the estimate and its evidence. Web and iOS render a shared response contract.

**Design** — The [approved Canvas artboard](../../../design/climbing-send-probability/chat.html) defines the search and selection flow. Its results and probabilities are fictional.

**Evaluation decision** — The user confirmed option A in Paseo Progress Q1. Evaluate Drummond and Popinga’s assigned-grade Bradley–Terry model at the climb-day level. The paper fits the ability trajectory within the observation window. Extending its random walk forward is the prospective adaptation to test and label.

## Scope and acceptance criteria

- Search the owner’s imported climb records by name or recorded location. Show grade, location, and climbing context when available so a user can distinguish matches with the same name. Select by stable identity. Show the forecast for the selected result.
- Preserve nullable source dates, grades, setting, method, and outcomes. Represent a target or context with insufficient evidence as unavailable with a short reason. Preserve visible search results when an estimate is unavailable.
- Use the owner’s data. Keep gym and outdoor modeling and evaluation separate, along with recorded climbing style and native grade system. Keep each board angle and mirror configuration distinct where they affect climb identity. Use the Climbing screen on web and iOS, with no logging or setup requirement.
- Plan the offline evaluation first. A decision to expose forecasts and a choice of serving architecture follow the evaluation evidence.

### Task 1: Build and verify eligible climb-day inputs

Verification reached the expected missing-module failure before implementation.
The standard suite exceeded the local template setup budget. A direct
PostgreSQL diagnostic used the same template migrations and verified the
climb-day labels, owner scope, access window, and read-only export.

**Reuse** [rock observation projection](../../../packages/server/src/repositories/climbing-rock-observations.ts), [canonical climbing dates](../../../packages/server/src/repositories/climbing-canonical-observations.ts), [climbing storage contract](../../climbing-context.md), and the [source completion projection](../../../drizzle/0172_source_climbing_completion.sql). Keep the new selection focused in `packages/server/src/repositories/climbing-forecast-observations.ts` if the existing descriptive projection cannot supply the required provenance directly.

**Offline row contract** — Owner scope, provider-scoped verified target identity, source date, native grade and provenance, setting, climbing style, known outcome, and source record identifiers. For outputs, keep the latter to identifiers needed for audit and deduplication. A whole-climb row models a whole-climb result.

- [x] Write a PostgreSQL regression with one stable climb logged twice on the same day, with an explicit send and additional unlabeled tries. Assert one positive climb-day and no synthesized failures. Include an explicit no-send summary, an ambiguous completion, an unlabeled Mountain Project or OpenBeta completion, a pitch attempt, and a second owner with the same source target ID. Assert the explicit negative survives and each unsupported or unauthorized row contributes no label.
- [x] Run the regression against the real database and observe it fail before adding the projection. Use the repository’s real-engine commands in [Test Policy](../../testing.md#test-policy).
- [x] Read the existing raw source semantics where the display completion is inferred or a count expands a summary. Use the owner and access-window constraints, active records, the source climbing date or verified session date, and verified climb identity. Collapse only sufficiently identified same-climb days within the same context. A known clean send establishes a positive day. Use explicit no-send summaries or sufficiently documented unsuccessful outcomes for negatives. Keep ambiguous days outside the binary labels. Preserve exact duplicates once and avoid merging across feeds from names alone.
- [x] Verify the regression assertions on PostgreSQL using the approved diagnostic. The standard integration command still needs a run after the workspace services recover.

| Context | Indoor evidence to verify | Outdoor evidence to verify |
| --- | --- | --- |
| Bouldering | Kaya has shared climb IDs, published grades, and session outcomes. BoardSesh has outcomes and board configuration, with grading provenance still to verify. | Kaya can retain the necessary route-day facts. The paper includes outdoor V-scale cohorts. |
| Sport lead | Kaya has lead and outcome fields. Require separate protection evidence and indoor calibration. | The published model covers outdoor sport. Require explicit lead and sport evidence. TheCrag retains labels and route IDs but its adapter leaves setting unset. |
| Trad lead | No matching evidence in the cited studies. | The paper includes Ewbank trad cohorts. Require explicit trad lead evidence and evaluate independently of sport. |
| Top rope, auto-belay, follow, solo, unroped route, aid, pitch, or ambiguous type and setting | Keep searchable where identified. Return unavailable where the method or required evidence is unsupported. | Keep searchable where identified. Return unavailable where the method or required evidence is unsupported. |

Grade and identity gaps also apply to several export and board feeds. A user’s history with only sends cannot supply a calibrated binary forecast by itself. The source capability audit uses contracts and fixtures and remains independent of any individual user’s row counts. [Source inventory](../../climbing-trait-coverage.md) · [TheCrag adapter](../../../src/providers/thecrag/mapping.ts) · [Kaya adapter](../../../src/providers/kaya-sync.ts) · [BoardSesh adapter](../../../src/providers/boardsesh.ts)

### Task 2: Evaluate the selected published model offline

The [retrospective pilot](../../climbing-send-probability-evaluation.md)
reports held-out results from two outdoor study logbooks. Prospective
calibration and a serving decision remain open. The pilots each fit one
logbook. Discuss whether to pool the slope within a setting, style, and native
grade system before a broader evaluation.

**Reuse** the [local ML workspace](../../../packages/ml/README.md) and established statistical tooling. For option A, use Stan for the paper’s assigned-grade likelihood and monthly ability trajectory. The grade encoding and priors must match the particular published analysis being evaluated, or the adaptation must be explicit. Verify licensing and pin any dependencies before adding them. [Authored manuscript](https://github.com/alexeid/climbing-grades/blob/main/manuscript/ms-jqas-r1.tex) · [Paper](https://doi.org/10.1515/jqas-2026-0040) · [Scarff comparison](https://arxiv.org/abs/2001.05388)

- [x] Write offline tests for chronological splits with linked same-day rows, a climb first seen in the held-out block, and one of those climbs supplying a grade only after the cutoff. Assert no same-day or later information reaches training, and the missing pre-cutoff grade produces an unavailable result. Verify model outputs on a deterministic reference example from the selected likelihood. Run the tests and observe them fail before adding the evaluator.
- [x] Run two retrospective outdoor pilots using the authors’ study data. Report the grade provenance, results by familiarity, and fit diagnostics.
- [ ] Fit and evaluate on authorized data using rolling local-date cutoffs. Keep all same-day records together. Score later climb-days separately for familiar and first-recorded targets. Use grade and identity information available before each prediction. Label a retrospective run with mutable grades as such where timestamped provenance cannot establish what was known then. Use the established package’s offline data paths and keep private source data local.
- [ ] Report per-context coverage, class counts, Brier score, log loss, and calibration with uncertainty. Compare against the observed send rate from training history in the same context. Report model fit diagnostics and how missing labels and sends-only logging affect interpretation. Synthetic fixtures exercise the evaluator. Calibration evidence comes from held-out observed outcomes. [Rolling-origin evaluation](https://otexts.com/fpptr/tscv.html) · [Probability scoring](https://sites.stat.washington.edu/raftery/Research/PDF/Gneiting2007jasa.pdf)
- [ ] Review results with the user before serving numerical estimates. Present which contexts are supported, which require more evidence, and what serving cost the measured model entails. Record the decision here before launching serving or client work.

### Task 3: Deliver search and forecasts through Training → Climbing

**Entry points** — [Climbing router](../../../packages/server/src/routers/climbing.ts), [web Climbing screen](../../../packages/web/src/routes/training/climbing.tsx), and [iOS Training screen](../../../packages/mobile/app/strain.tsx). Use a shared typed contract in `packages/training` for climb search matches, estimate details, and unavailable reasons. Finalize the exact response and bounded server compute with the evaluation review.

- [ ] Write a database-backed search regression with two same-name climbs in different locations, an unrelated owner’s record, and an unidentified import. Assert name or location finds owned matches, the chosen target uses its stable identity, and unauthorized records produce no results. Test that private or out-of-window evidence cannot be recovered via the estimate lookup. Run the tests before implementing.
- [ ] Implement an owner-scoped search of existing climb and Area records. Return the source identity, source grade, location, and applicable context for each row. Keep identical names separate when identities differ. Search operates independently of the Climbing Strengths breakdown. Searchable targets with insufficient forecast evidence receive an explicit unavailable state.
- [ ] Add matching web and iOS search and selected-climb states to the existing Climbing screen, following the approved artboard. Write interaction tests for keyboard selection, no matches, replacing a query while an old estimate is pending, and selecting a sends-only climb. Add Storybook examples with duplicate names and unavailable estimates. Check both platforms.
- [ ] Run the repository’s required lint and recursive typechecks, focused noninteractive tests, and real-engine integration tests. Review the complete change against the approved design and evaluation evidence. Commit and push verified implementation chunks per repository policy.
