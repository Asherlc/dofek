# Database Agent Guide

> **Read the [README.md](./README.md) first** for the core architecture and features.

## Agent-Specific Information

### Development Rules
- **Schema as Source of Truth**: `schema.ts` defines all database tables and enums. Update it before running migrations.
- **No `any` in queries**: Use `executeWithSchema()` (from `typed-sql.ts`) for raw SQL queries to ensure Zod validation.
- **Hypertable DDL**: New TimescaleDB hypertables must be created via SQL migrations, as Drizzle doesn't support them natively.
- **Implicit User ID**: Use `resolveImplicitUserId()` in Drizzle defaults to automatically attribute rows to the current user context.
- **ClickHouse analytics SQL lives in dbt**: Put transformation SQL for ClickHouse analytics read models in `analytics/models/*.sql`, not TypeScript strings. Use incremental dbt models for derived analytics tables and keep TypeScript ClickHouse migrations to schema/bootstrap/drop compatibility only.

### Testing Strategy
- **Integration Tests**: `db.integration.test.ts` for verifying schema-level constraints and basic operations.
- **Dedup Tests**: `dedup.integration.test.ts` to ensure provider priority and deduplication logic are correct.
- **Migration Tests**: `migrate.integration.test.ts` verifies that the full migration sequence runs correctly on a fresh database.

### Workflow
1. Modify `schema.ts`.
2. Generate migrations: `pnpm generate` (or write manually if detection is ambiguous).
3. Apply migrations: `pnpm migrate`.
4. Update integration tests as needed.
5. For ClickHouse analytics changes, run `pnpm analytics:build`, `pnpm lint:analytics-sql`, and `pnpm lint:analytics-policy`.
