# Dofek Server

The backend API and background job processor for Dofek. Built with Node.js, Express, tRPC, and Drizzle ORM.

## Architecture

- **tRPC API**: The primary interface for both web and mobile clients. Defined in `src/router.ts`.
- **Express Server**: Hosts the tRPC middleware and supplementary REST routes for webhooks, file uploads, and authentication.
- **Maintenance Webhooks**: Includes internal REST endpoints that run background maintenance asynchronously.
- **BullMQ**: Manages distributed background jobs for data synchronization, imports, and exports.
- **Drizzle ORM**: Type-safe database interactions with TimescaleDB.
- **Repositories**: Data access layer encapsulated in `src/repositories/`, abstracting SQL logic.
- **Insights Engine**: Complex data analysis and correlation logic located in `src/insights/`.
- **Machine Learning**: Predictive modeling (e.g., weight prediction, activity features) in `src/ml/`.

## Key Implementation Details

- **Safe SQL**: Uses `executeWithSchema` (in `src/lib/typed-sql.ts`) which combines Drizzle's `sql` template literal with Zod schema validation to ensure runtime type safety and catch schema drift.
- **Caching**: Implements a `queryCache` middleware for tRPC procedures (`src/trpc.ts`), with per-user isolation and configurable TTLs.
- **Nutrition AI Parsing**: `food.analyzeWithAi` estimates one entry, while `food.analyzeItemsWithAi` parses a natural-language meal into multiple itemized entries for client-side logging flows.
- **Cycle estimate provenance**: `menstrualCycle.currentPhase` counts the cycle
  day from the latest recorded period start, matching
  [ACOG's first-day-to-first-day cycle definition](https://www.acog.org/womens-health/faqs/your-first-period).
  A phase estimate requires at least three completed intervals, every interval
  to be 21–35 days, and an observed range no wider than 9 days. Otherwise the
  endpoint returns a server-authored sparse, irregular, or stale-history
  explanation instead of imposing a regular-cycle model. Those conservative
  boundaries follow ACOG's adult cycle-length and variation guidance, while
  ACOG also cautions that 28-day calendar assumptions do not account for
  irregular cycles or variable ovulation timing
  ([cycle guidance](https://www.acog.org/womens-health/faqs/abnormal-uterine-bleeding),
  [calendar-method limitation](https://www.acog.org/clinical/clinical-guidance/committee-opinion/articles/2017/05/methods-for-estimating-the-due-date)).
  The observed range remains descriptive history, not a calibrated confidence
  score or next-period forecast. Period rows can be corrected or deleted by
  stable ID through user-scoped mutations; web and iOS require explicit
  confirmation before deleting an erroneous entry, consistent with Apple's
  cycle-history review and correction flow
  ([Apple Cycle Tracking guide](https://support.apple.com/en-gb/guide/iphone/iph1a4a00aa0/26/ios/26)).
- **Authentication**: Supports session-based auth with cookie-based persistence for web and Bearer tokens for mobile. See `src/auth/` and `src/routes/auth/`.
- **Redis pairing store**: Companion pairing uses Lua scripts over related Redis keys and is intended for the single-node Redis deployment used by Dofek. Redis Cluster requires every key touched by one Lua script to be in the same hash slot; supporting Cluster mode would require redesigning the pairing key names with Redis hash tags. See the Redis Cluster scaling and hash tag documentation: https://redis.io/docs/latest/operate/oss_and_stack/management/scaling/ and https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/#hash-tags.
- **Monitoring**: Integrated with Sentry for error tracking and Prometheus for performance metrics (`src/lib/metrics.ts`).

### Activity training-stress availability contract

`calendar.weekList` owns both Training Stress Score calculation and availability explanations.
Each activity stat is discriminated by `status`: an `available` stat contains its display-ready
`value`, while a `missing` stat contains an actionable `reason` naming the missing duration,
power/functional-threshold-power, or heart-rate/maximum-heart-rate prerequisite. Web and mobile
render this contract without deriving metric availability. The numeric activity `tss` field remains
nullable for consumers that need the score rather than its compact-card presentation.

### Exercise-volume trend evidence contract

`strength.progressiveOverload` is the canonical web and mobile response for exercise-volume
trends. It preserves each recorded week and fits the slope against actual elapsed calendar weeks,
so an unrecorded week is not silently treated as either an adjacent observation or zero volume.
Each result identifies the exercise, observed period, observation count, elapsed-week count,
server-authored neutral interpretation, and the limitation that volume alone cannot identify a
planned deload.

When at least four recorded weeks contain residual variation, the server reports a deterministic
95% residual circular moving-block interval with the recorded week positions held fixed. Otherwise
it reports a specific reason that uncertainty is unavailable. This reflects fixed-regressor
block-bootstrap methods for weakly dependent time-series errors
([Lahiri et al.](https://doi.org/10.1080/01621459.2011.646929)). Clients only render and
unit-format this evidence; they do not calculate slopes, intervals, or interpretations.

### Health-status evidence contract

Health-status values are interpreted only by
[`src/services/health-status.ts`](./src/services/health-status.ts). Each result includes a semantic
`statusToken`, a short `statusLabel`, the exact server-evaluated `evaluationRule`, and a
metric-specific `explanation`. Web and iOS render those fields directly and may map the semantic
token to an icon or color, but they do not infer a classification from the numeric value, baseline,
or deviation. Recovery classifications use the 30-day baseline in `baselineRelative`; its separate
7-day-versus-prior-28-day comparison is context and does not determine the status, as defined by
[`baseline-relative-metrics.ts`](./src/contracts/baseline-relative-metrics.ts).

### Correlation evidence contract

Current web and mobile clients use the versioned `correlation.computeV2` endpoint. The endpoint
reports paired-calendar-day coverage, Spearman rho, linear slope/$R^2$, and a 95% circular
moving-block interval; `correlation.compute` remains an exact legacy compatibility projection.
Both endpoints share the source pipeline in
[`correlation-repository.ts`](./src/repositories/correlation-repository.ts).
Both endpoints reject a comparison of a metric with itself. V2 also returns a
server-authored interpretation warning because measurements that persist from one day to the
next or share a time trend can appear strongly related without a direct relationship, the
classic spurious-regression problem described by
[Granger and Newbold (1974)](https://doi.org/10.1016/0304-4076(74)90034-7).

Nutrition inputs come from the canonical `fitness.v_nutrition_daily` available-resolution
rows. Activity-duration inputs come from the deduplicated ClickHouse
`analytics.activity_summary` read model, and its activity date is projected in the user's
timezone before joining. ClickHouse documents `toTimeZone` as changing the displayed
timezone/timezone metadata without changing the underlying point in time
([ClickHouse date-time functions](https://clickhouse.com/docs/en/sql-reference/functions/date-time-functions#totimezone)).
The interval design and primary statistical references are documented in
[`@dofek/stats`](../stats/README.md#dependence-aware-uncertainty).

### Journal trend evidence contract

`journal.trends` is the canonical web and mobile response for journal trend review. It returns an
exact inclusive date window, raw provider-attributed numeric and Yes/No observations, and
server-authored coverage statements. Finite windows include explicit null points for unrecorded
days; the All-history window keeps points sparse and summarizes missing days by count so response
size grows with observations instead of calendar age. The response also explicitly reports that an
uncertainty interval is unavailable for these raw observations. Clients render that evidence
directly and do not infer a directional trend, causal effect, or confidence interval. The contract
and gap construction live in
[`journal-trend-evidence.ts`](./src/services/journal-trend-evidence.ts).

### Estimated strength evidence contract

`strength.estimatedOneRepMax` returns the raw estimated-max observations together with a
server-authored first-to-latest change direction, summary, non-negative kilogram magnitude, and
exact date bounds for each exercise. Web clients may convert the kilogram values into the selected
display unit and format dates, but they render the supplied direction and summary without inferring
a trend from the observations. The responsive chart selects one exercise at a time so long exercise
lists stay readable without hiding the time axis.

See `../../docs/nutrition-ai-input.md` for full client/server flow details.

## Development

```bash
cd packages/server && pnpm dev   # Start the Express server in development mode
pnpm test                        # Run repo-wide Vitest suites from the repo root
pnpm lint                        # Run Biome from the repo root
```

## Production Deployment

The server is packaged as a Docker image (target `server`) and handles both API requests and static asset serving for the SPA.
