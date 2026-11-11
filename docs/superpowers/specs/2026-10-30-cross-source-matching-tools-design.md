# Offline cross-source matching tools

Status: approved by the user on 2026-10-30 for offline implementation.

## Intent and scope

Implement all four approaches requested after the
[research evaluation](../../cross-source-matching-evaluation.md): probabilistic
record linkage, learned field matching with active learning, transformer pair
classification, and sequence-aware GPS map matching. The user selected offline
training and evaluation first. These must be executable implementations with
real library-backed training/inference and reproducible examples, rather than
documentation, placeholders, or fabricated model scores.

Place the tools in the existing `packages/ml` Python package. Keep live server,
web, mobile, ingestion, canonical identities, and production infrastructure
unchanged. There is no production accuracy claim or automatic rollout in this
scope. Synthetic fixtures establish executable behavior, not real-world quality.

## Approaches and library choices

The user requested all four approaches; they are distinct experiments, not four
competing implementations of one production responsibility. Each has one library.

| Approach | Proposed implementation | Trade-off |
| --- | --- | --- |
| Probabilistic linkage | Splink with its DuckDB backend; train agreement/disagreement evidence and use term-frequency adjustments for names. | Interpretable evidence; sufficient training data and a declared population prior are required. |
| Learned field matching | Dedupe record linkage, labeled positive/negative pairs, persisted model settings, and an explicit uncertain-pair labeling cycle. | Learns weights and blocking; relies on human labels and has an older release cadence. |
| Transformer matching | Hugging Face Transformers text-pair sequence classification, actual fine-tuning, saved tokenizer/model, and inference. | Handles richer text variation; larger dependencies and compute cost, with no implied quality before evaluation. |
| Sequence-aware matching | Leuven Map Matching `DistanceMatcher` over an explicitly supplied directed graph and ordered observations. | HMM-based matching without deploying a routing service; older upstream maintenance is a recorded limitation. |

Sources: [Splink](https://moj-analytical-services.github.io/splink/),
[term frequencies](https://moj-analytical-services.github.io/splink/topic_guides/comparisons/term-frequency.html),
[Dedupe API](https://docs.dedupe.io/en/latest/API-documentation.html),
[Transformers classification](https://huggingface.co/docs/transformers/tasks/sequence_classification),
[Ditto research](https://arxiv.org/abs/2004.00584), and
[Leuven example and lattice controls](https://leuvenmapmatching.readthedocs.io/en/latest/usage/introduction.html).
The transformer implementation is inspired by the researched approach; it does
not claim to reproduce Ditto's complete augmentation or benchmark protocol.

Alternatives considered: reimplementing these algorithms would duplicate established
libraries; deploying hosted inference or a routing service adds infrastructure
outside the selected offline scope. Neither is proposed.

Dependency snapshot checked on 2026-10-30: Splink 5.0.0, Dedupe 3.0.3,
Transformers 5.22.1, Torch 2.15.0, DuckDB 2.0.0, Leuven Map Matching 1.1.4.
Use current stable compatible versions and update `uv.lock` during implementation;
do not silently downgrade or carry a second library to bypass incompatibility.
Version evidence: [Splink](https://pypi.org/project/splink/),
[Dedupe](https://pypi.org/project/dedupe/),
[Transformers](https://pypi.org/project/transformers/),
[Torch](https://pypi.org/project/torch/),
[DuckDB](https://pypi.org/project/duckdb/), and
[Leuven](https://pypi.org/project/leuvenmapmatching/).

Maintenance review found recent repository activity for
[Splink](https://github.com/moj-analytical-services/splink) and
[Transformers](https://github.com/huggingface/transformers), with older activity
for [Dedupe](https://github.com/dedupeio/dedupe) and
[Leuven](https://github.com/wannesm/LeuvenMapMatching).
Check dependency advisories and license files before adding dependencies; repository
activity and permissive licensing alone do not establish a security audit.

## Data boundaries

Entity-linkage datasets declare exactly one domain and target relationship.
Climb identity, activity occurrence, and comparable-route identity are distinct
datasets. Nutrition source-contribution selection remains a separate existing
decision; these tools do not treat every food item as a duplicate or change totals.

The shipped reference examples for the first three engines evaluate climbing
catalogue identity; the fourth evaluates GPS traces against a route network.
This implements all four requested algorithms without pretending a name/location
schema measures temporal activity duplication or nutrition contribution selection.
Adapters and reference datasets for other relationships are outside this initial
implementation. The broader research continues to distinguish those relationships.

Each dataset contains records, candidate pairs, and labels. A record has a stable
provider-namespaced ID plus a name, optional context text, kind, and area coordinates.
Candidate pairs identify records from different sources; labels are `same`,
`different`, or `unresolved`, with label provenance and entity-group/split metadata.
Preserve missing values. Reject invalid references, conflicting labels, duplicate
record IDs, self-pairs, and train/validation/test leakage through shared records
or labeled entity groups. Unresolved labels never become negative training truth.
Fields unsuitable for a relationship must not be claimed to supply evidence for it.

All three pair classifiers score the same caller-supplied candidate pairs. This
isolates scoring quality for comparison. Splink/Dedupe blocking may be used by
their training and active-learning APIs, but their production candidate generation
is not a second implicit prediction mode. Known labeled pairs are a separate
evaluation population, so a positive omitted from the supplied candidates remains
in the candidate-recall denominator and is reported as a retrieval miss. Report
that recall as caller-supplied candidate recall, not library-blocker performance.
Classifier abstentions and classification false negatives are counted separately
from these retrieval misses.

Keep training, validation, and held-out evaluation separate. Thresholds are explicit
experiment inputs chosen before held-out evaluation. Never calibrate thresholds or
fit frequency statistics using held-out labels. Reports distinguish model scores
from calibrated probabilities and identify the dataset, split, engine/version,
thresholds, seed, and artifact provenance.

GPS input is separate: graph nodes have WGS84 latitude/longitude and directed
edges; traces have ordered observations. Graph provenance must be supplied by the
caller. Validate coordinates, graph references, nonempty edges, and observation
order. Coordinate order is explicitly latitude then longitude. Missing graph
coverage or partial matching yields an unresolved result with matched-observation
coverage, never a complete successful route claim.

## Execution and outputs

Provide `dofek-match` subcommands for training, prediction, evaluation, selecting
uncertain pairs, accepting additional labels, and map matching. Separate modules
own input contracts, metrics, each engine, and CLI orchestration. No module is
exported solely for tests. New repository wrapper scripts, if needed, are TypeScript;
Python commands belong only to `packages/ml`.

Persist trained Splink settings, Dedupe settings/training labels, and transformer
tokenizer/model artifacts with metadata. Inference consumes saved artifacts and
does not retrain implicitly. Use documented library save/load mechanisms and
explicit trusted-local artifact handling. Transformers use safe tensor weights;
no remote custom model code. Pretrained model acquisition is explicit and revision
pinned, with no network requirement during inference or normal tests.

Pair reports include IDs, score, `same`/`different`/`unresolved` decision, and
available evidence. Evaluation reports candidate recall separately from classifier
precision/recall, false-positive links, missed positives, abstentions, and labeled
coverage, including per-source-pair counts. Undefined rates are null with their
denominators. Report disagreements by fixture ID for review. Avoid claiming
cluster-level correctness from pairwise metrics; clustering is outside this scope.

The HMM report includes matched directed edges, ordered path, observation coverage,
and completion status. It does not convert an HMM path score into a record-linkage
probability. Map evaluation uses expected paths/edges and completion independently
of pairwise entity classification.

## Validation and completion

Use test-first development for contracts, metric boundaries, active-learning
round trips, training/save/load/inference for each pair engine, and GPS fixtures
with noise, direction constraints, disconnected coverage, and partial paths.
Run the actual third-party algorithms on minimal datasets. A tiny local randomly
initialized transformer tests mechanics; additionally run fine-tuning/inference
with a real pretrained checkpoint and clearly distinguish that smoke run from
accuracy evaluation. No mocked library score counts as algorithm verification.

Keep related examples in one split. Include same-name different-entity pairs,
aliases, missing fields, conflicting namespaces, incomplete candidate retrieval,
and uncertainty. Document each synthetic dataset's construction and limits.

Run Python lint, formatting, strict type checks, existing and new tests, real
engine smoke commands, repository lint, relevant TypeScript checks, and dependency
checks. Add CI coverage for the new engine tests without downloading pretrained
weights in normal CI. Update the research document's inaccurate description of
the existing catalogue matcher. Document commands and actual results in the ML
README. Push commits automatically and open an implementation PR; the original
research PR has already merged. Do not merge or enable auto-merge.

## Decisions left to implementation

Module names, minimal fixture sizes required by library training, the explicit
pretrained checkpoint used for the local smoke run, CLI spelling, and compact
report formatting are builder decisions. Scope, train/test separation, use of
real engines, and the offline-only boundary are fixed by this design proposal.
