# Adding a Provider

Providers are plugins that pull data from an external API and upsert it into the database.

## 1. Create the provider file

```
src/providers/my-provider.ts
```

## 2. Implement the Provider interface

```typescript
import type { Provider, SyncResult } from "./types.js";
import type { Database } from "../db/index.js";

export class MyProvider implements Provider {
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

  async sync(db: Database, since: Date): Promise<SyncResult> {
    const errors = [];
    let recordsSynced = 0;
    const start = Date.now();

    // 1. Fetch data from API
    // 2. Transform to schema types
    // 3. Upsert into database

    return {
      provider: this.id,
      recordsSynced,
      errors,
      duration: Date.now() - start,
    };
  }
}
```

## 3. Register the provider

In `src/providers/index.ts`, import and register:

```typescript
import { MyProvider } from "./my-provider.js";
registerProvider(new MyProvider());
```

## 4. Add env var to .env.example

```
MY_PROVIDER_API_KEY=
```

## 5. Write tests first (TDD)

Create `src/providers/__tests__/my-provider.test.ts` with:
- API response parsing tests (mock the HTTP calls)
- Data transformation tests
- Upsert/dedup logic tests

Run `pnpm test:watch` while developing.

## Key conventions

- **Deduplication**: Use `(provider_id, external_id)` unique constraints. Always upsert.
- **Exercise mapping**: When a provider has its own exercise names, create entries in `exercise_alias` to map them to canonical exercises.
- **Incremental sync**: Use the `since` parameter to only fetch new/updated data. Don't re-sync everything on every run.
- **Error handling**: Catch per-record errors and continue syncing. Return errors in the `SyncResult` rather than throwing.
