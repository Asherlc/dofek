# Cycling Polarization Index Implementation Plan

> **For agentic workers:** Use test-driven development for each task. Record the failing and passing checks. The Architect owns final review and the Paseo Implementer makes bounded changes.

### Goal

Report one descriptive weekly polarization index for all cycling rides in the selected training range.

### Design

The approved Endurance mockup combines all cycling rides irrespective of modality. It shows a weekly index, the three zone shares, the 2.00 reference line, and an explanation of the adapted bands. Both clients reuse their existing Endurance displays. Dofek uses profile maximum heart rate with three explicitly labeled bands: easy below 80%, middle at least 80% and below 90%, and high at least 90%. The user approved Treff's zero-zone conventions where defined.

For nonnegative observed zone times with positive total, let `f1`, `f2`, and `f3` be their fractions of that total. The index is `log10((f1 / f2) × f3 × 100)`. If `f2 = 0` and `f3 > 0`, Table 1 implies `log10((f1 / 0.01) × (f3 - 0.01) × 100)`, which requires `f3 > 0.01`. The zero-high result and the high-above-easy exclusion apply as specified in Task 1.

[Approved prototype](../../../design/cycling-polarization-index/endurance-card.html) · [Treff et al. (2019), Figure 1, Equations 1 and 2, and Table 1](https://www.frontiersin.org/journals/physiology/articles/10.3389/fphys.2019.00707/pdf)

## Task 1. Implement the approved calculation

- [ ] In `packages/zones/src/zones.test.ts` and `packages/training/src/training-distribution.test.ts`, cover 80/5/15 (2.380), 80/0/20 (3.182), 40/59.9/0.1 (negative index), 70/30/0 (zero), 0/0/0 (unavailable), 99/0/1 (unavailable), 20/10/70 (unavailable), and 49.5/1/49.5 (numeric result with no polarized label). Check exact 2.00 with 60/15/25 and a polarized result just above 2.00 with 60/14.995/25.005. Record the regressions that fail before implementation.
- [ ] Keep `computePolarizationIndex(z1Seconds, z2Seconds, z3Seconds)` as the one calculation. Reject non-finite and negative inputs, zero total, and high time above easy time. With positive observed volume and zero high time, return zero. With zero middle time, move one percentage point from high to middle using the grouping confirmed by Table 1. A nonpositive log argument produces an unavailable result. Use normalized fractions and retain full precision for classification.
- [ ] In `packages/training/src/training-distribution.ts`, use the numeric cutoff and strict easy > high > middle ordering for the polarized label. Preserve the numeric value at an easy/high tie and the existing rounded wire display. Supply separate explanations for no covered time and an input outside the domain. Preserve the server-owned classification and wire shape.
- [ ] In `packages/server/src/repositories/efficiency-repository.ts`, pool eligible canonical cycling activities from the selected range and existing entitlement window into one server-computed result per local week. Use the existing access-window predicate and parameter helpers. Cover a limited access window and the approved calculation cases in the existing repository and router suites.
- [ ] Update the method text and existing web/mobile disclosures. Share the three boundaries and label the fixed profile-HRmax bands as Dofek's proxy. Describe the positive log-argument rule, zero high time, and the meaning of the 2.00 reference. The chart and card render the server result. Update the zones and training package READMEs with the cited method.
- [ ] Run the relevant noninteractive domain, server, web, and mobile tests. Run the real ClickHouse endpoint suite, workspace lint, and recursive typechecks before pushing the application change.

## Task 2. Use elapsed heart-rate coverage

This step needs a decision on how long a recorded heart-rate reading represents a time interval. The existing cycling aerobic-efficiency model bounds a reading by the next observation, the ride end, and ten seconds after recording. Reusing that policy gives time-weighted input with a finite bound on gaps. Keep this operation in the existing dbt model over deduplicated, timestamped cycling heart rate.

- [ ] Confirm the covered-time rule. Review the existing analytics orchestration and bounded refresh runbook to settle the rollout before changing the model. Time-weighted results require refreshed time-weighted rows throughout the reported period.
- [ ] Add real ClickHouse regressions for irregular recording cadence, an interval beyond the approved gap, a reading at the ride endpoint, and the 80% and 90% boundary transitions. Verify the selected period pools covered zone time before calculating the index. Cover missing and explicitly estimated heart-rate evidence according to the approved eligibility rule.
- [ ] Reuse the existing per-activity read model and refresh path. Aggregate covered elapsed time per zone and expose the coverage basis in the existing method disclosure. Verify existing and newly ingested rides use the same basis throughout rollout.
- [ ] Run the focused ClickHouse model and endpoint tests and the full required pre-push checks. Review the complete patch and verify both clients before handing the change back.

[Existing aerobic-efficiency duration handling](../../../analytics/models/read_models/activity_aerobic_efficiency.sql) · [Read-model deployment runbook](../../clickhouse-read-model-deploy-runbook.md)
