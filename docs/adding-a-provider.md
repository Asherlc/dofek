# Adding a Provider

Providers are plugins that pull data from an external API and upsert it into the database.

## 1. Create the provider file

```text
src/providers/my-provider.ts
```

## 2. Implement the current provider interface

```typescript
import type { SyncDatabase } from "../db/index.ts";
import type { SyncOptions, SyncProvider, SyncResult } from "./types.ts";

export class MyProvider implements SyncProvider {
  readonly id = "my-provider";
  readonly name = "My Provider";

  private apiKey: string | undefined;

  constructor() {
    this.apiKey = process.env.MY_PROVIDER_API_KEY;
  }

  validate(): string | null {
    if (!this.apiKey) return "MY_PROVIDER_API_KEY is not set";
    return null;
  }

  async sync(
    db: SyncDatabase,
    since: Date,
    options?: SyncOptions,
  ): Promise<SyncResult> {
    const errors = [];
    let recordsSynced = 0;
    const start = Date.now();

    // 1. Fetch data from the API
    // 2. Parse/validate responses with Zod
    // 3. Upsert raw records into schema tables
    // 4. Report progress with options?.onProgress?.(percentage, message)

    return {
      provider: this.id,
      recordsSynced,
      errors,
      duration: Date.now() - start,
    };
  }
}
```

If the provider is file-import-only (like Strong CSV or Cronometer CSV), implement `ImportProvider` instead and add `readonly importOnly = true` rather than a `sync()` method.

## 3. Register the provider

Add it to the lazy registration list in `src/jobs/provider-registration.ts`:

```typescript
["my-provider", () => import("../providers/my-provider.ts").then((m) => new m.MyProvider())],
```

That keeps provider loading consistent for the worker, CLI, and server routes via `ensureProvidersRegistered()`.

If other packages need a bare import such as `dofek/providers/my-provider`, add a matching export to the root `package.json`.

## 4. Add env vars and setup notes

Add any new env vars to `.env.example`, and update `README.md` or a provider-specific doc if the provider has unusual setup or auth requirements.

```text
MY_PROVIDER_API_KEY=
```

## 5. Write tests first

Create `src/providers/my-provider.test.ts` next to the provider source file with:
- API response parsing tests
- data transformation tests
- sync/upsert behavior tests
- validation tests

Run `pnpm test:watch` while developing.

## Key conventions

- **Validation gates visibility**: providers whose `validate()` returns an error are hidden from enabled-provider lists and the UI.
- **Incremental sync**: use the `since` parameter to fetch only new or updated records when the provider API supports it.
- **Zod at boundaries**: validate external API payloads with Zod instead of trusting TypeScript-only types.
- **Raw data first**: store raw/provider-native records and leave deduplication/aggregation to query-time logic.
- **Repository-only DB secret crypto**: if a provider uses stored credentials/tokens, encryption/decryption must happen in repository/data-access code. Provider/service logic should only work with plaintext values returned by repository helpers.
- **Error handling**: collect per-record errors in `SyncResult.errors` instead of aborting the whole sync.
- **Tests stay colocated**: keep unit tests next to the provider file as `<provider>.test.ts`.
