# Supplement Safety Context Implementation Plan

**Issue:** [#2065](https://github.com/Asherlc/dofek/issues/2065)

**Overlapping issue:** [#2141](https://github.com/Asherlc/dofek/issues/2141) is the narrower medication/high-intake subset, not a prerequisite. It should be closed as a duplicate only after #2065 merges and its acceptance criteria are verified.

## Problem

The existing micronutrient API exposes one adult-male RDA scalar. Web and mobile clients derive presentation from it and color every intake at or above 100% green. That model cannot distinguish an adequacy target from a tolerable upper intake level (UL), food from supplemental intake, nutrient form, population, source, or ruleset revision. Supplement screens provide no high-intake or medication-review context.

## Bounded Design

Preserve the existing `micronutrientAdequacy` contract exactly for installed clients. Add a versioned safety-review contract whose values, statuses, and user-facing messages are computed on the server:

- FDA Daily Values provide the generic adequacy reference for adults and children age 4+.
- NIH Office of Dietary Supplements/Food and Nutrition Board U.S. adult ULs are evaluated only when the tracked nutrient unit, intake scope, and nutrient form match the source.
- The first ruleset covers vitamin C, vitamin D, vitamin B6, zinc, magnesium, and the vitamin A form limitation.
- Vitamin C, vitamin D, vitamin B6, and zinc use total food-plus-supplement intake.
- Magnesium uses supplemental intake only.
- Vitamin A is explicitly `not_evaluable` because its UL applies only to preformed vitamin A and the current canonical nutrient rows do not identify that form.
- Other nutrients explicitly report that no UL is included in this bounded ruleset; the absence of an app rule is not represented as proof that no UL exists.
- If medication records and a supplement stack both exist, return a general FDA-backed recommendation to review the complete list with a doctor or pharmacist. Do not infer a drug-specific interaction, diagnose risk, or give medication/supplement timing advice.

Every reference includes its target type, population, agency, title, URL, and a ruleset review date. The repository query returns average daily total, food, and taken-supplement intake so scope-specific rules are evaluated from canonical data. Web and mobile render the server-owned status and copy without deriving safety classifications.

## Authoritative Sources

- [FDA Daily Values on Nutrition and Supplement Facts Labels](https://www.fda.gov/food/nutrition-facts-label/daily-value-nutrition-and-supplement-facts-labels)
- [FDA: Mixing Medications and Dietary Supplements Can Endanger Your Health](https://www.fda.gov/consumers/consumer-updates/mixing-medications-and-dietary-supplements-can-endanger-your-health)
- [NIH ODS Vitamin C Health Professional Fact Sheet](https://ods.od.nih.gov/factsheets/VitaminC-HealthProfessional/)
- [NIH ODS Vitamin D Health Professional Fact Sheet](https://ods.od.nih.gov/factsheets/VitaminD-HealthProfessional/)
- [NIH ODS Vitamin B6 Health Professional Fact Sheet](https://ods.od.nih.gov/factsheets/VitaminB6-HealthProfessional/)
- [NIH ODS Zinc Health Professional Fact Sheet](https://ods.od.nih.gov/factsheets/Zinc-HealthProfessional/)
- [NIH ODS Magnesium Health Professional Fact Sheet](https://ods.od.nih.gov/factsheets/Magnesium-HealthProfessional/)
- [NIH ODS Vitamin A and Carotenoids Health Professional Fact Sheet](https://ods.od.nih.gov/factsheets/VitaminA-HealthProfessional/)

## TDD Tasks

1. Extend the canonical nutrition package tests with FDA Daily Value metadata and source-, scope-, form-, and unit-aware UL evaluation cases. Confirm the tests fail before implementation.
2. Add repository unit tests and a real-Postgres integration test for daily total/food/supplement averages and server-owned statuses. Confirm failure before implementing the query and domain model.
3. Add router tests for the new versioned endpoint while retaining the exact V1 response.
4. Add web component/page tests showing high intake is never automatically positive, UL limitations are visible, and the professional-review recommendation renders on the supplement surface.
5. Add equivalent mobile screen tests and Storybook data.
6. Implement the canonical rule model, server query/contract, and dual-platform renderers.
7. Run focused tests, package type checks, lint, and the repository pre-push suite. Push one PR for #2065, monitor CI, address review feedback, and report ready-to-merge status before merge.

## Non-goals

- No drug-name or RxNorm-specific interaction engine.
- No clinical diagnosis, treatment advice, medication timing, or supplement dosing recommendation.
- No inferred sex, pregnancy, lactation, or medical-treatment status.
- No database migration or replacement of the backward-compatible V1 RDA field.
- No claim that nutrients omitted from the bounded UL ruleset have no UL.
