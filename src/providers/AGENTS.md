# Provider Agent Guide

> **Read the [README.md](./README.md) first** for the core architecture and features.

## Agent-Specific Information

### Development Rules
- **Per-user auth required**: Every new sync provider must implement `authSetup()` so users connect their own account. Load credentials with `loadTokens(db, providerId, userId)` during sync. Do not add deployment-wide user env vars (grandfathered exception: `ultrahuman`). Policy is enforced in `provider-auth-policy.test.ts`.
- **Modular Design**: Each provider MUST be self-contained. Do not add cross-provider dependencies.
- **Raw Data Only**: Store raw data from providers. Deduplication and aggregation belong in the database layer (see `src/db/dedup.ts`).
- **Error Handling**: Use `SyncResult` to report successes and failures. Never swallow API errors.
- **Validation**: `validate()` may check app-level OAuth client env vars. User auth belongs in sync, not validate.
- **No empty-string sentinels**: Omit optional OAuth fields or use real config values — never default missing config to `""`. Credential providers still fill `oauthConfig` to satisfy `ProviderAuthSetup`, but users connect via `automatedLogin`, not Dofek OAuth redirects.

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
