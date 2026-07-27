# Personal Experiments: Setup & Schedule Slice

Tracking: https://github.com/Asherlc/dofek/issues/2054  
Product source: https://github.com/Asherlc/dofek/pull/2034 (§ Next: Personal Experiments)

## Goal

Ship the smallest complete high-priority vertical slice: a user can define a personal N-of-1 experiment, see a server-owned schedule with phases, and stop it — with web/mobile parity and a Correlation Explorer entry point.

## Non-goals (deferred)

- Adherence check-ins
- Confounder analysis
- Effect magnitude / statistical conclusions
- Daily Brief recommendation feed
- Mobile journal / life-event capture (Trust & Measurement workspace)

## Data model

`fitness.personal_experiment`

| Column | Notes |
|--------|-------|
| `id` | uuid PK |
| `user_id` | FK → `user_profile` |
| `hypothesis` | free text question |
| `intervention` | free text controllable action (never auto-filled from a correlated metric) |
| `outcome_metric_id` | correlation metric catalog id |
| `lag_days` | 0–7 |
| `baseline_days` | positive int |
| `intervention_days` | positive int |
| `start_date` | YYYY-MM-DD |
| `status` | `active` \| `stopped` |
| `stopped_at` | date, null while active |
| `created_at` | timestamptz |

Derived server-side (never computed in clients): `outcomeMetricLabel`, `phase`, schedule date bounds, phase labels, day-in-phase / days-remaining.

## API (`personalExperiments`)

- `list` — cached short TTL; returns enriched experiments newest-first
- `get` — `{ id }` enriched detail
- `create` — validates metric id against `CORRELATION_METRICS`, lag/duration bounds
- `stop` — sets `status=stopped`, `stopped_at=today` (user timezone date)

Cache domain: `personalExperiments` → `personalExperiments.`

## Clients

- Web `/experiments` page + `/experiments/new` search params (`outcomeMetricId`, `lagDays`)
- Mobile `/experiments` screen with same search params
- Correlation Explorer: “Start experiment” using Y-axis as outcome + lag; do not treat X-axis as intervention
- States: loading, error, empty, create form, active schedule, stop

## TDD sequence

1. Pure schedule/phase resolver unit tests → implement
2. Schema + migration `0058_personal_experiment`
3. Repository unit + integration tests → implement CRUD/stop/enrichment
4. Router unit tests → implement procedures + registration
5. Web page/component tests + stories → implement
6. Mobile screen tests + stories → implement
7. Correlation explorer link tests (web + mobile)
8. Docs: `docs/personal-experiments.md`, roadmap checkbox progress note

## Validation

- `pnpm lint`
- Relevant unit tests (`*.test.ts[x]` for changed units)
- `pnpm tsc --noEmit` (root, server, web)
- `pnpm test:integration` for repository integration coverage
- Stories present for new components
