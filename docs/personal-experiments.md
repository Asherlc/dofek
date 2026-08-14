# Personal Experiments

Guided N-of-1 experiment setup and schedule tracking. Product direction lives in [`docs/roadmap.md`](./roadmap.md) under **Next: Personal Experiments**. Implementation plan: [`docs/superpowers/plans/2026-07-26-personal-experiments-setup-schedule.md`](./superpowers/plans/2026-07-26-personal-experiments-setup-schedule.md).

## Current slice

Users can:

1. Start an experiment with a hypothesis, controllable intervention, outcome metric, lag, baseline length, intervention length, and start date.
2. See a server-resolved schedule with baseline / intervention / complete / stopped phases and date bounds.
3. Stop an active experiment.
4. Enter one raw check-in for each experiment and local calendar day: adherence (`adherent`, `partial`, `not_adherent`, or `unknown`), optional confounder, and optional note.
5. Link existing canonical life events to an experiment as annotations without duplicating their text.
6. See a server-derived evidence view: the canonical outcome observations (including missing days and source provenance), phase coverage, descriptive difference, bootstrap interval when enough observations exist, and explicit limitations.
7. Enter the setup flow from Correlation Explorer with the Y-axis outcome and lag prefilled. The correlated X metric is **not** treated as an intervention.

Web: `/experiments`  
Mobile: `/experiments` (also linked from Recovery)

## Server ownership

Metric labels, phase, schedule summaries, outcome observations, coverage, descriptive effects, uncertainty, and limitations are computed in the server and returned by `personalExperiments` tRPC procedures. Clients render only.

Outcome metrics come from the shared `@dofek/stats/correlation` catalog (`CORRELATION_METRICS`).

Analysis keeps one local-calendar observation for every scheduled phase day. It maps each day to its configured lagged outcome date, preserves an unavailable canonical outcome as `null`, and returns all canonical source-provider IDs. Intervention effect estimates include only `adherent` and `partial` check-ins, while all states remain visible in coverage. The server reports an effect only after at least five observed outcomes in both groups; its 95% interval uses the existing circular moving-block bootstrap method ([Künsch 1989](https://doi.org/10.1214/aos/1176347265); [Politis and Romano 1992](https://mathweb.ucsd.edu/~politis/DPpublication.html)). This is an observational comparison, not a causal conclusion.

## Storage

`fitness.personal_experiment` stores the user-authored setup fields and stop status. `fitness.personal_experiment_check_in` stores raw daily adherence and optional context, with a unique `(personal_experiment_id, date)` constraint. `fitness.life_events.personal_experiment_id` optionally links canonical annotations and becomes `NULL` if the experiment is deleted. Derived schedule and outcome-analysis fields are not persisted.

## Deferred

No user-entered outcome values, causal conclusions, evidence-based stop recommendations, Daily Brief integration, or MCP tool are part of this slice. The authenticated tRPC contract is the shared API boundary for web and mobile.
