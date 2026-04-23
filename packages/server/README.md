# Dofek Server

The backend API and background job processor for Dofek. Built with Node.js, Express, tRPC, and Drizzle ORM.

## Architecture

- **tRPC API**: The primary interface for both web and mobile clients. Defined in `src/router.ts`.
- **Express Server**: Hosts the tRPC middleware and supplementary REST routes for webhooks, file uploads, and authentication.
- **Maintenance Webhooks**: Includes internal REST endpoints (for example, materialized-view refresh triggers) that run background maintenance asynchronously.
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
- **Monitoring**: Integrated with Sentry for error tracking and Prometheus for performance metrics (`src/lib/metrics.ts`).
- **Slack Integration**: A built-in Slack bot (`src/slack/`) for status updates and basic data interactions.

See `../../docs/nutrition-ai-input.md` for full client/server flow details.

## Development

```bash
pnpm dev      # Start the Express server in development mode
pnpm test     # Run unit and integration tests
pnpm lint     # Run Biome linter
```

## Production Deployment

The server is packaged as a Docker image (target `server`) and handles both API requests and static asset serving for the SPA.
