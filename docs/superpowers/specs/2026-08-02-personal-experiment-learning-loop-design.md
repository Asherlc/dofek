# Personal Experiment Learning Loop Design

## Goal

Close the personal-experiment learning loop with one user-authored check-in per experiment and local calendar day, while presenting a transparent server-derived comparison of the configured canonical outcome metric.

## Approved scope

- Check-ins retain only raw user input: local calendar date, `adherent`, `partial`, `not_adherent`, or `unknown`, plus optional confounder and note text.
- `fitness.life_events` remains the one canonical annotation table. It gains an optional association to a personal experiment; no experiment-specific text table is created.
- Outcome values, phase means, effects, coverage, uncertainty, and limitations are derived in the server response only. They are never persisted.
- Web and mobile render the same tRPC contract. MCP is intentionally out of scope because the existing authenticated tRPC API already serves both clients.

## Data model

`fitness.personal_experiment_check_in` has an experiment foreign key, a local `date`, adherence, nullable confounder, nullable note, and creation timestamp. A unique `(personal_experiment_id, date)` constraint implements one raw check-in per local calendar day. Check-in rows cascade when their experiment is deleted.

`fitness.life_events.personal_experiment_id` is nullable and references the experiment with `ON DELETE SET NULL`, so an existing user annotation remains intact if the experiment is removed. The repository validates user ownership through its existing user-scoped writes.

## Derived analysis contract

For every phase calendar day, the server resolves the configured metric from the canonical correlation data pipeline. An intervention day maps to its outcome date by adding the configured lag; no client shifts dates or calculates metric values. Each observation exposes its phase date, outcome date, nullable value, check-in state, and source provenance. Missing metric days remain explicit `null` observations.

The descriptive effect is `mean(observed adherent-or-partial intervention outcomes) − mean(observed baseline outcomes)`. `not_adherent` and `unknown` intervention days remain in coverage but cannot represent intervention exposure. The response is available only with at least five observed outcomes in each comparison group, matching the project’s existing minimum for sparse daily comparisons. It returns a deterministic 95% circular moving-block bootstrap interval for the difference in means, preserving the calendar spine and its missing markers during resampling. This is an interval for observed data under dependence, not a causal claim or a significance result; it uses the existing method documented for correlations ([Künsch 1989](https://doi.org/10.1214/aos/1176347265); [Politis and Romano 1992](https://mathweb.ucsd.edu/~politis/DPpublication.html)).

Coverage reports expected days, observed canonical outcomes, missing outcomes, check-in count, and the count of each adherence state for baseline and intervention. Limitations always identify observational design, raw confounders, missing outcomes, incomplete adherence, and provider provenance/overlap as applicable. The clients present these server-authored limitations rather than inferring their own conclusion.

## Out of scope

No user-entered outcome value, causal conclusion, evidence-based stop recommendation, Daily Brief integration, extra annotation table, analytics read model, or MCP tool is added.
