# Offline Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement and verify all four approved offline matching approaches.

**Architecture:** The existing Python ML package owns typed dataset contracts,
evaluation, independently persisted library-backed engines, and a CLI. Pair
engines score caller candidates; GPS matching uses its own graph/trace contract.

**Tech Stack:** Python, uv, pytest, Splink/DuckDB, Dedupe, Transformers/Torch,
Leuven Map Matching; existing repository checks.

**Spec:** [Approved design](../specs/2026-10-30-cross-source-matching-tools-design.md).

## Global Constraints

- Offline only; preserve production runtime and raw data.
- Missing labels stay unresolved; isolate train/validation/test by entity.
- Real library training/inference, saved artifacts, explicit thresholds.
- No network during inference/normal tests; pretrained smoke is separate.
- Latest stable compatible libraries, recorded in `uv.lock`.

## Review Focus

- Candidate retrieval misses must remain in the recall denominator.
- Reversed pairs and shared entity groups must not leak between splits.
- Same-name distinct entities and missing fields must not become truth labels.
- Partial GPS paths must remain unresolved and respect directed edges.
- Saved model inference must preserve label order and artifact provenance.

### Task 1: Dataset contracts and evaluation

**Files:** `packages/ml/src/dofek_ml/matching_data.py`, `matching_metrics.py`;
`packages/ml/tests/test_matching_data.py`, `test_matching_metrics.py`, `matching_helpers.py`.

**Interfaces:** `Dataset.load(path)`, `Dataset.records`, `Dataset.pairs`,
`Dataset.labels`; `evaluate(dataset, predictions, split, lower, upper)` returns
a JSON-serializable report. Predictions map pair keys to model scores.

- [x] Write tests for missing candidates, abstentions, null rates, reverse-pair
  conflicts, record/group leakage, invalid namespace/coordinate/reference inputs.
- [x] Run targeted pytest and observe failure before implementation.
- [x] Implement typed validated contracts, canonical pair keys, explicit metrics.
- [x] Run targeted tests, then review results against hand-derived counts.

### Task 2: Splink and Dedupe engines

**Files:** `matching_splink.py`, `matching_dedupe.py`, their focused tests;
`packages/ml/pyproject.toml`, `uv.lock`.

**Interfaces:** Each engine offers `train(dataset, directory, seed)`,
`predict(dataset, directory, split)` returning pair scores; Dedupe additionally
offers `uncertain(dataset, directory)` and accepts labels through dataset input.

- [x] Write failing real-engine tests: positive outranks distinct, saved-model
  roundtrip, uncertainty/label/retraining cycle, missing fields and invalid fits.
- [x] Add current dependencies, resolve and inspect installed APIs.
- [x] Implement Splink label-trained comparisons and name frequency adjustments;
  implement Dedupe record linkage, saved training/settings, active-learning queue.
- [x] Run real minimal engine fits and predictions, compare saved/reloaded output.

### Task 3: Transformer engine

**Files:** `matching_transformer.py`, `tests/test_matching_transformer.py`.

**Interfaces:** `train(dataset, directory, model_path, seed, epochs)` and
`predict(dataset, directory, split)`; local tokenizer and safe tensor artifacts.

- [x] Write failing tests for actual tiny local model training, score ordering,
  paired serialization, saved inference, incomplete/unsafe artifacts.
- [x] Implement sequence-pair fine-tuning and inference with deterministic seeds,
  explicit train/validation data and no implicit model downloads.
- [x] Run local tests; separately acquire a revision-pinned pretrained model,
  fine-tune it and run held-out predictions. Record actual smoke results.

### Task 4: HMM map matching

**Files:** `matching_map.py`, `tests/test_matching_map.py`, graph/trace fixture.

**Interfaces:** `match_trace(input_path)` returns directed edges, path,
observation coverage and complete/unresolved status.

- [x] Write failing tests for noisy paths, directed/disconnected networks,
  missing graph coverage, invalid coordinates and non-increasing timestamps.
- [x] Implement validated WGS84 input and Leuven DistanceMatcher adaptation.
- [x] Run real graph/trace matches; check partial matches are unresolved.

### Task 5: CLI, fixtures, documentation, verification and shipping

**Files:** `matching_cli.py`, `tests/test_matching_cli.py`,
`packages/ml/examples/matching/`, ML README, research document, Python CI step.

**Interfaces:** `dofek-match train|predict|evaluate|uncertain|map` consumes files
and writes reports/artifacts. Dataset labels are the active-learning input;
retraining consumes the updated labels, never mutates the held-out set.

- [x] Write failing subprocess CLI tests for executable outputs and nonzero
  prerequisite/input failures.
- [x] Implement orchestration, reproducible synthetic fixtures, dependency extras
  and CI engine coverage; document commands, labels and limitations with sources.
- [x] Correct stale research statements about the existing catalogue matcher.
- [x] Run Python lint/format/mypy/full tests/coverage, real CLI smoke runs,
  repository lint and root/server/web type checks. Review dependency advisories.
- [x] Fresh whole-change review; fix important findings with regression tests.
- [ ] Commit and push passing work; open implementation PR and monitor CI.

## Execution notes

The user approved the design and requested implementation. Execute inline in the
existing isolated worktree; preserve its branch and workspace. Record task gates
and implementation rulings in this plan's ignored execution ledger. Commit once
the complete coherent change passes mandatory pre-push gates, then push immediately;
intermediate incomplete engines are not shipped.
