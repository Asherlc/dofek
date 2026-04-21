# Server Agent Guide

**Read [README.md](./README.md) first.** It contains the primary architecture and implementation details.

## Context for Agents

- **tRPC Procedures**: When adding new functionality, always create a router in `src/routers/` and register it in `src/router.ts`. Use `protectedProcedure` for user-scoped data and `cachedProtectedQuery` for read-heavy operations.
- **Data Access**: Logic should reside in `src/repositories/`. Never write raw SQL directly in routers; use the repository pattern and prefer `executeWithSchema` for raw queries.
- **Zod Schemas**: Every tRPC input/output and every raw SQL result MUST have a Zod schema. Use `dateStringSchema` and `timestampStringSchema` from `src/lib/typed-sql.ts` to handle DB-to-JS type normalization.
- **Error Handling**: Use `TRPCError` with semantic codes. Never swallow errors; ensure they are logged and reported to telemetry if they represent internal failures.
- **Testing**:
  - Unit tests (`*.test.ts`) live next to the source.
  - Integration tests (`*.integration.test.ts`) verify DB and router interactions. Use the `test-helpers.ts` utilities.
- **Metrics**: Add instrumentation to new critical paths using the `registry` from `src/lib/metrics.ts`.
