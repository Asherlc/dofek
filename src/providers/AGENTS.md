# Provider Agent Guide

> **Read the [README.md](./README.md) first** for the core architecture and features.

## Agent-Specific Information

### Development Rules
- **Modular Design**: Each provider MUST be self-contained. Do not add cross-provider dependencies.
- **Raw Data Only**: Store raw data from providers. Deduplication and aggregation belong in the database layer (see `src/db/dedup.ts`).
- **Error Handling**: Use `SyncResult` to report successes and failures. Never swallow API errors.
- **Validation**: Ensure `validate()` checks all required environment variables.

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
