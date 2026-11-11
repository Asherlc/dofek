# Food Nutrition Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reject fabricated or contradictory AI food nutrition without replacing labeled calories.

**Architecture:** Validate the service's effective result within its existing transaction. Require source evidence for zero-calorie writes and retain it in the existing description. Publish the same command through MCP.

**Tech Stack:** TypeScript, Zod, Vitest, Drizzle/Postgres.

**Spec:** [Approved design](../specs/2026-10-25-food-nutrition-validation-design.md) and [issue #3082](https://github.com/Asherlc/dofek/issues/3082).

## Global Constraints

- Creating `{ calories: 0, protein: 40, carbohydrate: 0, fat: 0 }` fails with a machine-readable actionable validation error and no committed write.
- Evaluate effective complete updates, including calorie-only, protein-only, and source-restoring clears.
- Creation requires known calories, protein, carbohydrate, and fat. Never zero-fill unknown nutrition.
- Preserve labeled calories; tolerate fiber, sugar-alcohol, specific-factor and rounding discrepancies.
- Require explicit source evidence for zero-calorie writes, allowing genuine zero-calorie items.
- Preserve idempotent replays, historical records, and delete/restore behavior.
- No dependencies, schema migrations, new env vars, or client metric computations.
- TDD: observe regression tests fail before production edits; real DB tests prove rollback and daily totals.
- Work on current branch; no branch switch. Root runs pre-push checks, commits, pushes, opens an unmerged PR against main.

## Review Focus

- Failed mutation must roll back source, identity, ledger, nutrients, totals, and cache invalidation.
- Missing/null required creation nutrients must fail through direct service calls.
- Clearing nutrient overrides must validate provider-restored facts, not a shallow input patch.
- Idempotent old receipts must still replay even if current source facts would fail new validation.
- Evidence must not bypass contradictions; delete must still remove invalid historical entries.

### Task 1: Service validation, MCP guidance, and regressions

**Files:** modify `packages/server/src/services/food-record-service.ts`, its unit/integration tests, `packages/server/src/mcp/food-record-tools.ts` and its unit tests. Add a focused domain module and colocated unit test only if needed for a clear responsibility or the 1,000-line limit. Update active MCP/server documentation and the incident baseline with source links.

**Interfaces:** preserve `FoodRecordService.create/update` return values and existing error transport. Add optional nonempty `zeroCalorieEvidence` to create/update commands and snake-case MCP equivalent, required semantically when resulting calories are zero. Store supplied evidence in the existing `foodDescription`, preserving other description text.

- [ ] Write and run failing tests for missing creation nutrition, 40 g protein/0 kcal, all-zero cookies without evidence, update merged states, legitimate labels, and water with evidence.
- [ ] Add real-Postgres regression tests for two cookies plus a 40 g protein shake alongside 144 kcal collagen: rejected writes leave record/ledger counts and totals unchanged; valid sourced replacements yield correct totals. Cover existing invalid records, clear-to-source, replay, and unchanged historical raw facts.
- [ ] Implement service validation on non-replayed create/update outcomes inside the transaction. Use conservative documented protein/fat factors with rounding slack; do not infer carbohydrate energy or overwrite calories. Return `INVALID_ARGUMENT` with a stable reason and corrective action.
- [ ] Extend existing MCP descriptions/schema guidance and test transported error details and post-success daily summaries.
- [ ] Run focused unit/integration suites and self-review the diff. Report RED/GREEN evidence. Root completes lint, typechecks, broader tests, review, commit/push and PR linking.

### Completion checkpoints

- [ ] Independent task review: spec compliance and code quality.
- [ ] Full branch review and required checks pass.
- [ ] Commit and push all changes, create PR with `Fixes #3082`, comment PR link on issue, leave unmerged.
