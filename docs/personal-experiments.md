# Personal Experiments

Guided N-of-1 experiment setup and schedule tracking. Product direction lives in [`docs/roadmap.md`](./roadmap.md) under **Next: Personal Experiments**. Implementation plan: [`docs/superpowers/plans/2026-07-26-personal-experiments-setup-schedule.md`](./superpowers/plans/2026-07-26-personal-experiments-setup-schedule.md).

## Current slice

Users can:

1. Start an experiment with a hypothesis, controllable intervention, outcome metric, lag, baseline length, intervention length, and start date.
2. See a server-resolved schedule with baseline / intervention / complete / stopped phases and date bounds.
3. Stop an active experiment.
4. Enter the setup flow from Correlation Explorer with the Y-axis outcome and lag prefilled. The correlated X metric is **not** treated as an intervention.

Web: `/experiments`  
Mobile: `/experiments` (also linked from Recovery)

## Server ownership

Metric labels, phase, and schedule summaries are computed in `packages/server/src/personal-experiments/experiment-schedule.ts` and returned by `personalExperiments` tRPC procedures. Clients render only.

Outcome metrics come from the shared `@dofek/stats/correlation` catalog (`CORRELATION_METRICS`).

## Storage

`fitness.personal_experiment` stores the user-authored setup fields and stop status. Derived schedule fields are not persisted.

## Deferred

Adherence check-ins, confounder capture, effect estimation, conclusions, and Daily Brief integration ship in later slices.
