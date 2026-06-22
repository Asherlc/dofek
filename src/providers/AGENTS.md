# Provider Agent Guide

> **Read the [README.md](./README.md) first** for the core architecture and features.

## Agent-Specific Information

### Development Rules
- **Per-user auth required**: Every new sync provider must implement `authSetup()` so users connect their own account. Load credentials with `loadTokens(db, providerId, userId)` during sync. Do not add deployment-wide user env vars (grandfathered exception: `ultrahuman`). Policy is enforced in `provider-auth-policy.test.ts`.
- **Modular Design**: Each provider MUST be self-contained. Do not add cross-provider dependencies.
- **Raw Data Only**: Store raw data from providers. Deduplication and aggregation belong in the database layer (see `src/db/dedup.ts`).
- **Error Handling**: Use `SyncResult` to report successes and failures. Never swallow API errors.
- **Validation**: `validate()` may check app-level OAuth client env vars. User auth belongs in sync, not validate.
- **No empty-string sentinels**: Omit optional OAuth fields or use real config values — never default missing config to `""`. Credential providers use `automatedLogin` only and omit `oauthConfig`.

### Provider Activity Absence Checklist

When a provider writes activities, follow this contract (see `src/db/provider-activity-sync.ts` and `src/db/provider-activity-absence.ts`):
- **Use shared activity sync helpers**: Upsert activities with `upsertProviderActivity()` or `ProviderActivityListSync.upsert()`. Tombstone completed authoritative list fetches with `finishProviderActivityListSync()` or `ProviderActivityListSync.reconcile()`.
- **Authoritative list syncs must reconcile provider absence**: After a completed, authoritative activity-list fetch for the exact sync window, reconcile through the shared sync helper.
- **Webhook deletes must tombstone**: Explicit delete/removed events must call `markProviderActivityAbsent()`, not hard-delete rows.
- **Reconcile restores tombstones; upserts must not undo them**: Shared upsert helpers never set `providerAbsentAt: null`. Reconciliation clears tombstones for activities still present in the authoritative provider list.
- **Do not reconcile partial fetches**: Never reconcile when the provider response is partial because of rate limits, auth failures, incomplete pagination, checkpoint resumes, or other fetch errors. Absence is not proof of deletion unless the list fetch was complete and successful.
- **Filter absent and user-deleted activities everywhere else**: Any code that shows activities, totals, stats, exports, or analytics must exclude rows where `provider_absent_at IS NOT NULL` or `deleted_at IS NOT NULL`. Tombstones are soft — they preserve raw history but must not appear in normal user-facing views. Pair both filters; `scanActiveActivityPredicatePairing` in `src/db/activity-visibility.ts` guards this in CI.

### Testing Strategy
- **Unit Tests**: `<provider>.test.ts` for parsing logic and API client mocks.
- **Integration Tests**: `<provider>-sync.integration.test.ts` for end-to-end sync against a real database (uses `test-helpers.ts`).
- **Contract Tests**: `provider-api-contracts.test.ts` ensures providers adhere to the `Provider` interface.
- **Auth Policy Tests**: `provider-auth-policy.test.ts` ensures new providers expose a user connect flow.

### Adding a New Provider
1. Read [docs/adding-a-provider.md](../../docs/adding-a-provider.md) — follow the per-user auth template.
2. Define the provider class in a new file (e.g., `my-provider.ts`).
3. Implement `validate()`, `authSetup()`, and `sync()` with per-user token loading.
4. Register in **both** `src/jobs/provider-registration.ts` and `packages/server/src/routers/sync-helpers.ts`.
5. Add metadata (`packages/providers-meta`), queue config, and tests.
6. Run `pnpm vitest run src/providers/provider-auth-policy.test.ts` to confirm policy compliance.
