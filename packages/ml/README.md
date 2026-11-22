# Dofek ML

Machine Learning and data export pipeline for Dofek.

## Features
- **Training Export**: The old Postgres-backed `metric_stream` export is retired.
- **Data Loading**: Utilities for loading exported Parquet data into Python environments.
- **Training**: Core model training logic.

## Technical Details
- **Architecture**:
  - Local ML training scripts and Parquet loading utilities for R2/ClickHouse-derived datasets.
- **Infrastructure**:
  - Container image kept for local ML workflows (`packages/ml/Dockerfile`).
  - Uses `uv` for dependency management.
- **Data Model**:
  - Parquet files are organized by athlete and date range.
  - Stored in a directory structure defined by `JOB_FILES_DIR`.

## Usage
Postgres `fitness.metric_stream` training export is retired. Use the Redpanda R2
archive or ClickHouse metric-stream data for ML training datasets.

The retired CLI entrypoint still reports the migration path clearly:
```bash
dofek-export --output-dir /tmp/unused
```

## Offline climbing send forecasts

From the repository root, with a read-only `DATABASE_URL` for the authorized
database, export one owner's climb-days with the existing TypeScript runtime.

To export from the newest production backup without a production connection,
run `infisical run --env=prod -- pnpm climbing:export-from-backup <owner> <timezone> <start> <end>`.
It needs `DATABASUS_SECRET_KEY` in Infisical, restores into a throwaway database in
the workspace Compose Postgres, and drops it afterward.

```bash
rtk proxy pnpm tsx scripts/export-climbing-forecast-observations.ts \
  "$climbing_owner_id" America/Los_Angeles 2025-01-01 2025-12-31 > climb-days.json
```

The export keeps provider-scoped climb identity, source log IDs, local date,
setting, style, assigned grade, and a known whole-climb outcome. A day with a
known clean send counts once. A day with exclusively known unsuccessful
outcomes counts once as unsuccessful. Shared grades are current catalogue
values, with the snapshot date recorded as `capturedOn`.

Evaluate one owner, setting, style, and native grade system at a time.
Encode grades using the corresponding [author-supplied grade encoding](https://github.com/alexeid/climbing-grades/blob/f4ffdc1efd69882aa55489475202a0b2845d1c4a/R/grades.R)
and [configuration](https://github.com/alexeid/climbing-grades/blob/f4ffdc1efd69882aa55489475202a0b2845d1c4a/R/config.csv).
`ClimbDay.grade_known_on` identifies when the assigned grade was available.
`split_holdout` withholds records without pre-cutoff grade evidence by default.
Use `retrospective=True` only for a retrospective analysis of frozen grades and
label the resulting evidence accordingly.

`build_model_data` prepares input for `climbing_forecast.stan`. Sample with
[CmdStan](https://mc-stan.org/cmdstanpy/), then pass the posterior `slope` and
`ability` draws to `score_holdout`. This reports Brier score, log loss, observed
send rate, mean predicted probability, and a 90% posterior interval for the
mean prediction. It compares the same held-out days with the earlier observed
send rate and returns separate scores for climbs familiar and unfamiliar at
the cutoff. Repeat across chronological cutoffs to assess calibration stability.

The likelihood and monthly ability process follow
[Drummond and Popinga](https://doi.org/10.1515/jqas-2026-0040). Continuing the
monthly random walk into future months is Dofek's prospective adaptation.

## Offline cross-source matching

`dofek-match` implements four independent research approaches: Splink probabilistic
linkage with name-frequency adjustments, Dedupe learned field comparisons and
active learning, transformer text-pair fine-tuning, and HMM GPS map matching.
These tools run locally and do not update application identities or production
matching. The reference tasks are catalogue identity and GPS-to-network matching;
activity occurrence and nutrition contribution selection remain separate problems.
See the [cross-source evaluation](../../docs/cross-source-matching-evaluation.md).

The implementations use [Splink](https://moj-analytical-services.github.io/splink/),
[Dedupe](https://docs.dedupe.io/en/latest/API-documentation.html),
[Transformers sequence classification](https://huggingface.co/docs/transformers/tasks/sequence_classification),
and [Leuven DistanceMatcher](https://leuvenmapmatching.readthedocs.io/en/latest/usage/introduction.html).
The transformer is inspired by [Ditto](https://arxiv.org/abs/2004.00584); it does not
claim to reproduce Ditto's augmentation or published benchmark results.

Run these commands from `packages/ml`:

```bash
uv sync --locked --extra matching
uv run --extra matching dofek-match train splink examples/matching/catalogue.json /tmp/matching-splink --prior 0.01
uv run --extra matching dofek-match predict splink examples/matching/catalogue.json /tmp/matching-splink /tmp/splink-scores.json
uv run --extra matching dofek-match evaluate examples/matching/catalogue.json /tmp/splink-scores.json /tmp/splink-report.json --lower 0.2 --upper 0.8

uv run --extra matching dofek-match train dedupe examples/matching/catalogue.json /tmp/matching-dedupe
uv run --extra matching dofek-match predict dedupe examples/matching/catalogue.json /tmp/matching-dedupe /tmp/dedupe-scores.json
uv run --extra matching dofek-match evaluate examples/matching/catalogue.json /tmp/dedupe-scores.json /tmp/dedupe-report.json --lower 0.2 --upper 0.8
uv run --extra matching dofek-match uncertain examples/matching/catalogue.json /tmp/matching-dedupe /tmp/next-label.json

uv run --extra matching dofek-match acquire distilbert/distilbert-base-uncased 12040accade4e8a0f71eabdb258fecc2e7e948be /tmp/matching-pretrained
uv run --extra matching dofek-match train transformer examples/matching/catalogue.json /tmp/matching-transformer --pretrained /tmp/matching-pretrained --epochs 1
uv run --extra matching dofek-match predict transformer examples/matching/catalogue.json /tmp/matching-transformer /tmp/transformer-scores.json
uv run --extra matching dofek-match evaluate examples/matching/catalogue.json /tmp/transformer-scores.json /tmp/transformer-report.json --lower 0.2 --upper 0.8

uv run --extra matching dofek-match map examples/matching/trace.json /tmp/map-report.json
```

Training and acquisition require a new output directory and publish it only after
success. Failed attempts discard their private staging directory, so the same
output path can be retried. Inference uses saved
models and local files, without implicit training or downloads. `acquire` is the
explicit network operation; it requires a full revision SHA and downloads only
configuration, tokenizer, and safe tensor files from the selected model repository,
including sharded weights and their index. Missing weights or referenced shards
fail acquisition before an output artifact is published.
The example checkpoint is [DistilBERT at the pinned revision](https://huggingface.co/distilbert/distilbert-base-uncased/tree/12040accade4e8a0f71eabdb258fecc2e7e948be).
Transformers supports [local-only loading and safe tensor weights](https://huggingface.co/docs/transformers/main_classes/model).

### Dataset and evaluation contract

[`catalogue.json`](examples/matching/catalogue.json) is deliberately synthetic.
It contains 15 training entities, three validation entities, and three held-out
entities, each represented by two sources. Some training observations deliberately
disagree on names, hierarchy text, or kind. Train/validation/test use independent
entities; the labels are constructed fixture truth, not independently reviewed
production examples. Its small size makes it suitable for executable examples,
not calibration or model selection.

Inputs are JSON with `domain`, `relationship`, `records`, `pairs`, and `labels`:

- Records have `id` (`provider:external-id`), `provider`, `name`, `entity_group`,
  and `split` (`train`, `validation`, or `test`). Optional `context`, `kind`, and
  paired `latitude`/`longitude` preserve missing values as null. Pair classifiers
  currently use name, context and kind; the transformer also serializes available
  coordinates. Splink/Dedupe do not claim spatial evidence from these fields.
- Candidate `pairs` have `left` and `right` record IDs. Each pair joins different
  providers within one split. Reversed duplicates are rejected.
- `labels` have `left`, `right`, `label` (`same`, `different`, `unresolved`), and
  `provenance`. Labels need not occur in the candidate set: this preserves known
  retrieval misses. `same` labels require shared entity groups. Groups and records
  cannot cross splits; unresolved labels never train a negative class.

All three pair engines score the supplied candidates, rather than silently
replacing retrieval with their own blockers. Dedupe's blocker participates in
its active-learning procedure. Candidate recall in the report measures the
supplied candidates, not learned-blocker recall. See
[Dedupe's learning process](https://docs.dedupe.io/en/latest/how-it-works/Matching-records.html).

Splink learns nonmatch frequencies from random cross-source training comparisons
and match frequencies from positive training labels; its required population
prior is an experiment assumption, not the labeled class balance. This sampling
assumes random pairs are predominantly nonmatches. Training fails if a nonnull
comparison level remains unestimated rather than using an implicit default.
Provide agreement and disagreement examples for each compared field. See
[Splink parameter estimation](https://moj-analytical-services.github.io/splink/topic_guides/training/training_rationale.html).
Dedupe requires exactly two training providers and at least five positive and
five negative labels for its cross-validation. Its saved settings use Python
serialization; load only trusted local artifacts, as explained by
[Dedupe's static matcher API](https://docs.dedupe.io/en/latest/API-documentation.html).

For an active-learning round, review `/tmp/next-label.json`, add the pair's label
and provenance to the dataset's `labels`, and train a **new** Dedupe artifact.
Request its next uncertain pair. Changed training records or resolved labels require
a new artifact before requesting another queue. Leave validation/test labels unchanged and retain
prior dataset/artifact files for reproducibility. The queue excludes resolved
training labels; an exhausted queue is empty.

Choose lower/upper decision thresholds before held-out evaluation. Scores at or
above the upper threshold match; scores at or below the lower threshold differ;
the middle region and missing scores abstain. Reports include candidate recall,
labeled precision/recall, false-positive links, missed positives, abstentions,
unresolved truth, per-source counts, pair decisions, and fixture disagreements.
Source-pair dictionary keys encode the sorted provider names as compact JSON arrays,
so provider names containing punctuation cannot merge separate source-pair counts.
Recall counts all labeled positives, including retrieval misses and abstentions.
Undefined rates are null; relevant denominator counts accompany them. Scores are
not claimed to be calibrated probabilities or cluster-accuracy measurements.

Model metadata records training provenance, engine version, seed and settings.
Prediction files carry dataset/artifact fingerprints; the artifact fingerprint
covers a sealed manifest of metadata, native model settings/weights, tokenizer,
and training output files. Inference verifies each manifested file before loading
the model, detecting changed or missing model content. Evaluation refuses a
different dataset. Saved-model inference also checks domain, relationship, library
version, and overlap with recorded training IDs/groups. The caller must label
entity groups correctly: invented group IDs cannot prove real-world separation.
Sealed model directories are immutable: added files also invalidate their
fingerprint, since tokenizer/model loaders may consult additional configuration.
Write prediction and evaluation reports outside the model directory.

### GPS input and result

[`trace.json`](examples/matching/trace.json) supplies a directed graph, WGS84
nodes, increasing numeric observation timestamps, and expected edges. Coordinates
are latitude then longitude. Supply your own permitted network with its
provenance; this tool does not download a map or infer a network from the trace.
The result includes ordered edges/nodes, matched-observation coverage, and
`complete` or `unresolved`. Completion requires full observation coverage and
valid directed progress. Partial coverage or backwards projected progress beyond
the configured 20 m observation-noise tolerance remains unresolved; the latter
sets `direction_conflict`. Edge indexing finds traces that start inside long edges
without requiring a nearby endpoint, while results preserve caller node IDs.
Expected-edge
recall, when truth is supplied, is independent of pairwise classifier metrics.
The HMM uses a 100 m search radius, 20 m observation/distance noise and lattice
width 10; these are explicit experiment settings, not calibrated route confidence.
See [Leuven's distance and pruning parameters](https://leuvenmapmatching.readthedocs.io/en/latest/usage/introduction.html).

The edge index uses [Rtree](https://rtree.readthedocs.io/en/stable/) through
[Leuven's edge-index support](https://github.com/wannesm/LeuvenMapMatching/blob/master/leuvenmapmatching/map/inmem.py).

### Dependencies and verification

The matching extra pins the algorithm libraries and `uv.lock` pins resolution.
Linux uses CPU Torch wheels through an explicit PyTorch index, following
[uv's PyTorch integration guidance](https://docs.astral.sh/uv/guides/integration/pytorch/).
Normal tests build a tiny local transformer and never fetch pretrained weights.
The explicit pretrained smoke above is separate from those mechanics tests.

**Approved dependency exception:** BTrees is pinned to 6.4 because Dedupe 3.0.3
calls `byValue()` on a float-valued bucket. BTrees 6.5 removed that method;
the actual training test reproduced the resulting `AttributeError`. Its release
also addresses a crash in object-valued buckets. This constraint is an explicit
user-approved exception to the latest-version policy, not an advisory ignore.
See [BTrees release notes](https://btrees.readthedocs.io/en/latest/changes.html)
and [Dedupe's float-valued canopy code](https://github.com/dedupeio/dedupe/blob/v3.0.3/dedupe/canopy_index.py).

```bash
uv run --locked --extra matching ruff check src/ tests/
uv run --locked --extra matching ruff format --check src/ tests/
uv run --locked --extra matching mypy src/ tests/
uv run --locked --extra matching pytest --cov
```

Python CI executes the matching extra, including real minimal algorithm fits and
save/load cycles. No engine is substituted with mock scores; synthetic examples
and a one-epoch pretrained smoke cannot establish production accuracy.

Observed smoke results on 2026-10-30 using the committed
[catalogue fixture](examples/matching/catalogue.json), seed 42, thresholds
0.2/0.8, Splink prior 0.01, and one transformer epoch:

| Engine | Same decisions | Different decisions | Abstentions |
| --- | ---: | ---: | ---: |
| Splink | 3 | 1 | 0 |
| Dedupe | 0 | 0 | 4 |
| Pretrained DistilBERT after fine-tuning | 0 | 0 | 4 |

The held-out fixture has three positives and one negative. The
[GPS fixture](examples/matching/trace.json) matched all five observations and
both expected directed edges. These observations demonstrate executable paths;
the abstentions do not justify relaxing thresholds using held-out outcomes.
