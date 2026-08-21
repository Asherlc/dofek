# Adding a Provider

Providers are plugins that pull data from an external API and upsert it into the database.

## Per-user authentication (required)

**Every new sync provider must authenticate per user.** Users connect their own account via the app UI (Settings → Data Sources). Credentials are stored in `oauth_token` and loaded during sync with `loadTokens(db, providerId, userId)`.

Do **not** build new providers that read user-specific credentials from deployment env vars (for example `MY_PROVIDER_USER_ID`, `MY_PROVIDER_API_TOKEN`, or a shared email address). External-account providers have no exemptions. `auto-supplements` is exempt only because it is an internal provider with no external account.

Supported connect flows:

| Pattern | When to use | Example |
|---------|-------------|---------|
| OAuth 2.0 | Provider has a standard OAuth app | Strava, Oura, Withings |
| OAuth 1.0 | Provider requires 3-legged OAuth 1 | FatSecret |
| Credential (`automatedLogin`) | Email/password or token exchange without browser | Eight Sleep, Zwift, Amazfit/Zepp |
| Personal token (`manualToken`) | User mints a personal API or access token | Cycling Analytics, Ultrahuman |
| Custom auth router | Login flow needs extra UI/steps | Garmin, WHOOP |

App-level OAuth client IDs/secrets in env vars are fine — those identify the Dofek application, not an individual user.

Policy tests in `src/providers/provider-auth-policy.test.ts` fail CI if a new provider skips per-user auth. See `src/providers/provider-auth-policy.ts` for exemptions.

## 1. Create the provider file

```text
src/providers/my-provider.ts
```

For reverse-engineered APIs, prefer a dedicated client package under `packages/` (see `zepp-client`, `zwift-client`).

## 2. Implement the provider interface

Use this template for API sync providers:

```typescript
import type { SyncDatabase } from "../db/index.ts";
import { getOAuthRedirectUri } from "../auth/oauth.ts";
import { ensureProvider, loadTokens } from "../db/tokens.ts";
import { ProviderStoredIdentityMissingError } from "./auth-errors.ts";
import type {
  ProviderAuthSetup,
  SyncOptions,
  SyncProvider,
  SyncResult,
} from "./types.ts";

export class MyProvider implements SyncProvider {
  readonly id = "my-provider";
  readonly name = "My Provider";

  validate(): string | null {
    // Always enabled — auth is checked at sync time via stored per-user tokens.
    // OAuth app credentials may still be validated here if needed.
    return null;
  }

  authSetup(options?: { host?: string }): ProviderAuthSetup {
    return {
      oauthConfig: {
        clientId: process.env.MY_PROVIDER_CLIENT_ID!,
        clientSecret: process.env.MY_PROVIDER_CLIENT_SECRET,
        authorizeUrl: "https://provider.example.com/oauth/authorize",
        tokenUrl: "https://provider.example.com/oauth/token",
        redirectUri: getOAuthRedirectUri(options?.host),
        scopes: ["read"],
      },
      exchangeCode: async (code) => {
        // Exchange authorization code for tokens
        throw new Error("not implemented");
      },
      apiBaseUrl: "https://api.provider.example.com",
    };
  }

  async sync(db: SyncDatabase, since: Date, options?: SyncOptions): Promise<SyncResult> {
    const start = Date.now();
    const errors = [];
    let recordsSynced = 0;
    const userId = options?.userId;
    if (!userId) throw new Error("my-provider sync requires a userId");

    await ensureProvider(db, this.id, this.name, undefined, userId);

    const stored = await loadTokens(db, this.id, userId);
    if (!stored) {
      errors.push({
        message: new ProviderStoredIdentityMissingError(
          "My Provider",
          "credentials — connect via the app",
        ).message,
      });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    // 1. Fetch data from the API using stored.accessToken
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

For credential-based providers (email/password, no browser OAuth), return only `automatedLogin` from `authSetup()` — do not include `oauthConfig` or `exchangeCode`. See `src/providers/amazfit-zepp.ts` or `src/providers/eight-sleep.ts`:

```typescript
authSetup(_options?: { host?: string }): ProviderAuthSetup {
  const fetchFn = this.#fetchFn;
  return {
    apiBaseUrl: "https://api.provider.example.com",
    automatedLogin: async (email: string, password: string) => {
      const result = await ProviderClient.signIn(email, password, fetchFn);
      return {
        accessToken: result.token,
        refreshToken: null,
        expiresAt: new Date(Date.now() + result.expiresIn * 1000),
        scopes: `userId:${result.userId}`,
      };
    },
  };
}
```

For providers that let each user mint a personal token, return `manualToken`. The shared web and
mobile modal links to the vendor instructions, accepts the token as a password field, validates it
through `exchangeToken()`, and stores the returned token set per user. This passthrough template is
only for provider-issued API/access tokens. If the provider instead asks the user for a refresh
credential, exchange it for the provider's access/refresh token response and preserve the returned
expiry and rotation data (for example, Wger documents a JWT refresh endpoint in its
[official API guide](https://wger.readthedocs.io/en/latest/api/api.html#jwt-tokens)):

```typescript
authSetup(): ProviderAuthSetup {
  return {
    apiBaseUrl: "https://api.provider.example.com",
    manualToken: {
      label: "Personal API token",
      instructionsUrl: "https://provider.example.com/account/api",
      exchangeToken: async (token) => {
        await validateToken(token);
        return {
          accessToken: token,
          refreshToken: null,
          expiresAt: new Date("2099-12-31T00:00:00.000Z"),
          scopes: "read",
        };
      },
    },
  };
}
```

If the provider is file-import-only (like Strong CSV or Cronometer CSV), implement `ImportProvider` instead and add `readonly importOnly = true` rather than a `sync()` method.

## 3. Register the provider

Add it to the lazy registration list in **both** `src/jobs/provider-registration.ts` and `packages/server/src/routers/sync-helpers.ts`:

```typescript
["my-provider", () => import("../providers/my-provider.ts").then((m) => new m.MyProvider())],
```

Also add metadata in `packages/providers-meta/src/providers.ts` (label, logo or brand color), queue config in `src/jobs/provider-queue-config.ts`, and optional entries in `packages/onboarding/src/provider-guide.ts`.

If other packages need a bare import such as `dofek/providers/my-provider`, add a matching export to the root `package.json`.

## 4. Add env vars and setup notes

Document **app-level** OAuth client IDs/secrets in `.env.example`. Do not document per-user secrets there.

Update `src/providers/README.md` if the provider has unusual setup (SSO limitations, region-specific hosts, etc.).

## 5. Write tests first

Create `src/providers/my-provider.test.ts` next to the provider source file with:
- API response parsing tests
- data transformation tests
- sync/upsert behavior tests (mock `loadTokens` for per-user credentials)
- `authSetup` / `automatedLogin` tests when applicable

Run `pnpm test:watch` while developing.

## Key conventions

- **Per-user auth**: users connect individually; sync reads tokens from the database.
- **validate() gates app config only**: return `null` when the provider should appear in the UI; check user auth at sync time. OAuth client env vars may still disable a provider when the app is not registered with the vendor.
- **Incremental sync**: use the `since` parameter to fetch only new or updated records when the provider API supports it.
- **Zod at boundaries**: validate external API payloads with Zod instead of trusting TypeScript-only types.
- **Raw data first**: store raw/provider-native records and leave deduplication/aggregation to query-time logic.
- **Repository-only DB secret crypto**: encryption/decryption must happen in repository/data-access code. Provider logic works with plaintext values from `loadTokens`.
- **JWT subject caveat**: for OAuth/JWT providers, `sub` may not be the numeric profile ID required by downstream endpoints; canonicalize with a profile lookup when needed.
- **Error handling**: collect per-record errors in `SyncResult.errors` instead of aborting the whole sync.
- **Tests stay colocated**: keep unit tests next to the provider file as `<provider>.test.ts`.
- **Provider activity absence**: Use `src/db/provider-activity-sync.ts`. Upsert with `upsertProviderActivity()` / `ProviderActivityListSync.upsert()`. After a completed authoritative activity-list fetch for the sync window, call `finishProviderActivityListSync()` / `ProviderActivityListSync.reconcile()`. Explicit delete/removed webhook events should call `markProviderActivityAbsent()`. Shared upserts never set `providerAbsentAt: null`; reconciliation clears tombstones for activities still present in the provider list. Do not reconcile on partial fetches — absence from an incomplete response is not proof the provider removed the activity.
