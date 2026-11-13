# Candidate-aware Swift mutation CI implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline. User approved this direction on 2026-10-31.

**Goal:** Execute every applicable native mutation within the existing job budget and explicitly report verified zero-candidate sources as not applicable.

**Architecture:** Prepare verified full per-file plans, use the pinned tool's official sharding, execute every nonempty shard with full owning-package tests, and require official merge against each original plan. Preserve source hashes, exact candidate membership, archived evidence, official reverification and trust checks. The tool's [sharding implementation](https://github.com/juntaki/mutantkit/blob/1e345263e36e1658adeed6ae919b7f5875a2601b/Sources/MutationPlanner/PlanSharding.swift) preserves original context and detects missing/duplicate results during merge.

**Tech stack:** TypeScript/Zod, pinned MutantKit 1.3.2, SwiftPM, GitHub Actions.

## Global constraints

- Keep all configured operators, every candidate, full package tests and current CI timeout/thresholds.
- Missing sources, invalid compiler input, changed hashes, incomplete partitions, failed baselines and unverifiable evidence still fail.
- An official verified empty plan is not a measured score. Positive measured work remains required for nonempty full campaigns, including when an individual shard contains only unviable candidates.
- Do not change the WHOOP protocol or production sensor behavior.

## Review focus

- Missing and duplicate IDs across shards must fail even when individual reports validate.
- Every shard must retain original plan identity, source hashes and operator context.
- Empty data files must retain compiler, inventory, hash and official verification evidence.
- Shard artifact paths must remain distinct, and stale or missing artifacts must fail.
- Aggregate CI must require preparation, every selected worker and full-plan merge.

## Tasks

- [x] Write failing validator and partition tests; implement explicit empty-plan acceptance and per-shard versus whole-campaign validation without weakening evidence checks.
- [x] Write failing public CLI tests; prepare bounded official shards and a campaign manifest, execute selected workers, and merge complete reports against original plans. Keep the local default full-campaign command.
- [x] Wire preparation artifacts, worker matrix and required native merge into CI. Update native testing docs and the incident evidence with approval and validation.
- [ ] Run focused/full tests, typecheck, lint, real pinned-tool smoke validation and one fresh review; commit/push automatically and monitor hosted CI.

## Working rulings

Use at most twelve candidates in a native worker, based on retained observations showing 37–46-second builds plus full-suite test execution. This bounds work per job rather than dropping candidates or increasing deadlines. Official hash sharding can be uneven, so inspect every emitted partition and increase shard count until each nonempty shard meets the bound.
