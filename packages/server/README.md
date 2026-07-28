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
- **Authentication**: Supports session-based auth with cookie-based persistence for web and Bearer tokens for mobile. See `src/auth/` and `src/routes/auth/`.
- **Redis pairing store**: Companion pairing uses Lua scripts over related Redis keys and is intended for the single-node Redis deployment used by Dofek. Redis Cluster requires every key touched by one Lua script to be in the same hash slot; supporting Cluster mode would require redesigning the pairing key names with Redis hash tags. See the Redis Cluster scaling and hash tag documentation: https://redis.io/docs/latest/operate/oss_and_stack/management/scaling/ and https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/#hash-tags.
- **Monitoring**: Integrated with Sentry for error tracking and Prometheus for performance metrics (`src/lib/metrics.ts`).
- **Slack Integration**: A built-in Slack bot (`src/slack/`) for status updates and basic data interactions.

### Correlation evidence contract

Current web and mobile clients use the versioned `correlation.computeV2` endpoint. The endpoint
reports paired-calendar-day coverage, Spearman rho, linear slope/$R^2$, and a 95% circular
moving-block interval; `correlation.compute` remains an exact legacy compatibility projection.
Both endpoints share the source pipeline in
[`correlation-repository.ts`](./src/repositories/correlation-repository.ts).

Nutrition inputs come from the canonical `fitness.v_nutrition_daily` available-resolution
rows. Activity-duration inputs come from the deduplicated ClickHouse
`analytics.activity_summary` read model, and its activity date is projected in the user's
timezone before joining. ClickHouse documents `toTimeZone` as changing the displayed
timezone/timezone metadata without changing the underlying point in time
([ClickHouse date-time functions](https://clickhouse.com/docs/en/sql-reference/functions/date-time-functions#totimezone)).
The interval design and primary statistical references are documented in
[`@dofek/stats`](../stats/README.md#dependence-aware-uncertainty).

See `../../docs/nutrition-ai-input.md` for full client/server flow details.

## Development

```bash
cd packages/server && pnpm dev   # Start the Express server in development mode
pnpm test                        # Run repo-wide Vitest suites from the repo root
pnpm lint                        # Run Biome from the repo root
```

## Production Deployment

The server is packaged as a Docker image (target `server`) and handles both API requests and static asset serving for the SPA.
