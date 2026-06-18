# Provider Agent Guide

> **Read the [README.md](./README.md) first** for the core architecture and features.

## Agent-Specific Information

### Development Rules
- **Modular Design**: Each provider MUST be self-contained. Do not add cross-provider dependencies.
- **Raw Data Only**: Store raw data from providers. Deduplication and aggregation belong in the database layer (see `src/db/dedup.ts`).
- **Error Handling**: Use `SyncResult` to report successes and failures. Never swallow API errors.
- **Validation**: Ensure `validate()` checks all required environment variables.

### Provider Activity Absence Checklist
When a provider writes activities, follow this contract (see `src/db/provider-activity-absence.ts`):
- **Authoritative list syncs must reconcile provider absence**: After a completed, authoritative activity-list fetch for the exact sync window, call `reconcileProviderActivityAbsence()`.
- **Webhook deletes must tombstone**: Explicit delete/removed events must call `markProviderActivityAbsent()`, not hard-delete rows.
- **Upserts must clear tombstones**: Activity upserts must clear `providerAbsentAt` so restored provider activities become visible again.
- **Do not reconcile partial fetches**: Never reconcile when the provider response is partial because of rate limits, auth failures, incomplete pagination, checkpoint resumes, or other fetch errors. Absence is not proof of deletion unless the list fetch was complete and successful.
- **Filter absent activities everywhere else**: Any code that shows activities, totals, stats, exports, or analytics must exclude rows where `provider_absent_at IS NOT NULL`. Tombstones are soft — they preserve raw history but must not appear in normal user-facing views.

### Testing Strategy
- **Unit Tests**: `<provider>.test.ts` for parsing logic and API client mocks.
- **Integration Tests**: `<provider>-sync.integration.test.ts` for end-to-end sync against a real database (uses `test-helpers.ts`).
- **Contract Tests**: `provider-api-contracts.test.ts` ensures providers adhere to the `Provider` interface.

### Adding a New Provider
1. Define the provider class in a new file (e.g., `my-provider.ts`).
2. Implement `validate()`, `authSetup()`, and `sync()`.
3. Register the provider in `index.ts`.
4. Add unit and integration tests.
5. Document any provider-specific quirks in `docs/`.
