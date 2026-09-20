# Ziva Nutrition Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `ziva` as a normal Dofek OAuth sync provider that imports verified Ziva meal aggregates into canonical nutrition storage through a deterministic MCP client.

**Architecture:** Reuse Dofek's OAuth callback and encrypted token repository, adding the OAuth resource indicator Ziva requires and validating account identity before rotated credentials are saved. A focused SDK-backed MCP client reads one diary date per call, a strict parser maps each complete stable Ziva meal to one `meal_aggregate`, and a Ziva-local transactional writer replaces that meal's four-macro set. A generic opaque source-account key prevents records from different Ziva accounts from being silently combined. Generic sync windows, checkpoints, continuations, queue status, effective-food overlays, and query-time provider reconciliation remain authoritative.

**Tech Stack:** TypeScript, Zod 4.4.3, `@modelcontextprotocol/sdk` 1.30.0, Drizzle ORM, PostgreSQL/TimescaleDB, BullMQ, Vitest, an injected protocol-level fetch harness for unit tests, and MSW 2.15.0 for network-level integration tests.

**Spec:** `docs/superpowers/specs/2026-09-20-ziva-nutrition-provider-design.md`

## Global Constraints

- Provider ID is exactly `ziva`; display name is exactly `Ziva`.
- Keep `@modelcontextprotocol/sdk` at the repository's current exact supported version, `1.30.0`; do not add the v2 split client package.
- Import is one-way and read-only. Production code may call `tools/list` and `get_meals_for_date` only; it must never call Ziva write/delete/search tools or interpret returned text as instructions.
- OAuth uses state, S256 PKCE, `client_secret_post`, `resource=https://connect.ziva.fit/mcp`, empty scopes, encrypted per-user tokens, and the verified JWT `sub` account identity.
- Empty scope means the `scope` authorization parameter is omitted, matching the successful live request; no blank or fabricated scope is sent.
- The authenticated service currently errors on a multi-day range; sync makes one `start_date` call per calendar date and never sends `end_date`.
- Every nonempty response must contain only the requested `mealDate` and unique nonblank `mealId` values. Any cross-date or duplicate identity rejects the whole date before writes, counts, or checkpoint advancement.
- Initial history is capped at 730 days and split into at most 14 diary dates per continuation job. Explicit backfills keep their requested bounds subject only to the same per-job chunking.
- A returned meal is authoritative only when all four observed macro keys are present, finite, and nonnegative. Store its calories, protein, carbohydrate, and fat totals directly once; item `quantity`, `portion`, and `gramWeight` never rescale them.
- Fiber, micronutrients, per-item nutrients, item IDs, database food IDs, portion IDs, pagination, completeness, and source deletion markers are unavailable from the verified read. Preserve unmodeled fields in raw JSON and do not synthesize nutrient rows.
- A numeric zero for a verified macro is a real row. A missing/null verified macro makes the meal/date malformed, preserves the prior record, and prevents checkpoint advancement; it is never interpreted as authoritative nutrient removal. Replacing a complete returned meal replaces its exact verified nutrient set transactionally.
- A successful empty date does not hide an older Ziva row because the source exposes no authoritative completeness/deletion signal.
- Preserve source diary dates and explicit backfill bounds as literal `YYYY-MM-DD` values. Do not timezone-format generic UTC sync-window bounds. Only map `createdAt` to `loggedAt` when it is an RFC 3339 instant with `Z` or an explicit offset; never invent a meal time or timezone.
- Preserve the observed one-item quantity, portion text, and nullable gram weight in the existing serving columns. For a synthetic/unverified multi-item response, leave aggregate serving columns null and retain items only in raw provenance.
- Derive an opaque account-scoped source key and a separate account-and-meal external identity from Dofek user ID plus verified Ziva `sub`; never persist the raw subject in food rows. Different connected accounts on one day must conflict rather than sum.
- Expose each meal aggregate once through the provider-neutral nutrition display view so existing food cards, meal counts, edits, and hiding work; never expose the display-only Ziva item array as additional intake.
- Generic provider metadata supplies both web and mobile Data Sources UI. Do not add client-side metric computation or a parallel nutrition store.
- Use `pnpm`, keep tests colocated, keep integration tests free of module mocks, and push every commit to the remote branch.

### Mandatory pre-push gate

Before every commit/push below, run the repository-required gate. Add the focused tests and any migration/database command named in that task before these common checks:

```bash
rtk pnpm lint
rtk pnpm tsc --noEmit
rtk pnpm --dir=packages/server exec tsc --noEmit
rtk pnpm --dir=packages/web exec tsc --noEmit
```

When mobile code changes, also run `rtk pnpm test:mobile` and `rtk pnpm --filter dofek-mobile typecheck`. Never commit or push a failing gate. Push immediately after each successful commit.

## Review Focus

- When `structuredContent` and JSON text both exist but differ, reject the response instead of selecting one silently; Task 5 owns this test.
- When one Dofek user reconnects to another Ziva `sub` that reuses the same `mealId`, retain two account-scoped records rather than overwriting; Task 8 owns this test.
- When a previously imported date later returns an empty list, retain the old record and advance only the successful date checkpoint; Task 8 owns this test.
- When a complete meal changes a macro to exactly zero, retain the zero row atomically. When a later payload omits/nulls any verified macro, reject the date and retain the entire prior nutrient set; Task 6 owns the transactional replacement test and Tasks 4/8 own rejection/no-checkpoint tests.
- When an unexpired access token gets 401, refresh exactly once; if the refreshed token also gets 401 or refresh returns `invalid_grant`, clear unusable credentials and surface reconnect instead of looping; Task 8 owns this test.
- When refresh rotates both credentials, preserve the stored account ID and validate the new JWT `sub` before saving. A changed subject clears credentials and surfaces reconnect; Tasks 1/3/8 own these tests.
- When the currently stored access token is malformed, has the wrong issuer/audience/subject, or disagrees with encrypted `providerAccountId`, clear the Ziva credentials immediately and surface reconnect before opening MCP; Task 8 owns this test.
- When old-account and new-account meals overlap on a date, canonical nutrition reports a source conflict instead of summing them; Tasks 2/8 own this test.
- When account deletion is requested with an active Ziva connection, fail before confirmation with an instruction to disconnect Ziva first because no revocation endpoint is advertised; Task 9 owns this test.

---

## File Structure

- `src/providers/ziva/auth.ts` — Ziva endpoints, OAuth setup, code exchange, and verified JWT issuer/audience/subject extraction.
- `src/providers/ziva/schemas.ts` — observed external response schemas and deterministic meal-to-Dofek normalization.
- `src/providers/ziva/client.ts` — official-SDK Streamable HTTP session, tool allowlist/schema verification, result extraction, timeout/cancellation, and error classification.
- `src/providers/ziva/sync-plan.ts` — literal calendar-date slicing and versioned continuation checkpoints.
- `src/providers/ziva/nutrition-writer.ts` — one transaction per validated date for parent upserts plus exact nutrient replacement.
- `src/providers/ziva/provider.ts` — `SyncProvider` orchestration, token lifecycle, client recreation after one refresh, checkpointing, and progress.
- `src/providers/ziva/test-helpers.ts` — synthetic protocol-level MCP fetch harness shared by Ziva tests only.
- `src/providers/ziva/msw-test-helpers.ts` — network-level JSON-RPC handlers used only by integration tests.
- `src/providers/ziva/fixtures/observed-meal.sanitized.json` — privacy-scrubbed shape from the authorized 2026-09-20 read.
- `src/providers/ziva/diagnostic.ts` — redacted dry-run summary used by the operator smoke command.
- `scripts/ziva-smoke.ts` — read-only command that loads an unexpired stored user token and performs no Dofek writes.
- `docs/ziva.md` — verified contract, connection, operation, and limitations.

### Task 1: OAuth resource, empty scope, and refresh identity preservation

**Files:**
- Modify: `src/auth/oauth.ts`
- Modify: `src/auth/oauth.test.ts`
- Modify: `src/auth/resolve-tokens.ts`
- Modify: `src/auth/resolve-tokens.test.ts`

**Interfaces:**
- Consumes: existing `OAuthConfig`, `exchangeCodeForTokens()`, `refreshAccessToken()`, and `resolveOAuthTokens()`.
- Produces: `OAuthConfig.resource?: string`; all three OAuth requests propagate it when present; an empty scope list omits `scope`; refresh returns the stored account identity and offers a pre-save identity validator.

- [ ] **Step 1: Write failing resource-indicator tests**

Add tests that construct a config with:

```ts
resource: "https://connect.ziva.fit/mcp",
```

Assert `buildAuthorizationUrl()` includes that exact query parameter, and the captured `URLSearchParams` bodies from `exchangeCodeForTokens()` and `refreshAccessToken()` include it. Add companion assertions using the existing default config that no `resource` parameter is sent.

- [ ] **Step 2: Write the failing empty-scope authorization test**

Assert `buildAuthorizationUrl()` does not contain a `scope` parameter when `scopes: []`, matching the successful Ziva authorization request. Confirm a nonempty existing provider scope list is unchanged. Audit existing empty-scope provider tests for compatibility rather than adding a Ziva-only bypass.

- [ ] **Step 3: Write failing refresh-identity tests**

In `resolve-tokens.test.ts`, seed stored tokens with `providerAccountId: "account-a"`, return rotated access/refresh tokens without an account ID, and assert both the returned `TokenSet` and `saveTokens()` input preserve `account-a`. Add a test that an optional `validateRefreshedTokens(current, refreshed)` callback runs before persistence and that a rejection prevents `saveTokens()`.

- [ ] **Step 4: Run the tests and observe the failures**

Run:

```bash
rtk pnpm vitest run --project unit src/auth/oauth.test.ts src/auth/resolve-tokens.test.ts
```

Expected: the resource assertions fail, the empty-scope URL contains `scope=`, and refreshed return values lose the stored account ID.

- [ ] **Step 5: Implement the minimum generic OAuth extensions**

Add `resource?: string` to `OAuthConfig`. Conditionally add it in authorization, exchange, and refresh requests. Only set the authorization `scope` query parameter when `config.scopes.length > 0`.

```ts
validateRefreshedTokens?: (
  currentTokens: TokenSet,
  refreshedTokens: TokenSet,
) => void | Promise<void>;
```

After `refreshAccessToken()`, invoke that callback before any save. Then save and return:

```ts
const resolvedTokens: TokenSet = {
  ...refreshedTokens,
  providerAccountId: refreshedTokens.providerAccountId ?? currentTokens.providerAccountId,
};
```

Do not change `ProviderAuthSetup`, the token table, or unrelated providers' token-response coercion in this task.

- [ ] **Step 6: Run focused auth tests and the mandatory pre-push gate**

Run the command from Step 4, then the common pre-push gate. Expected: PASS.

- [ ] **Step 7: Commit and push**

```bash
rtk git add src/auth/oauth.ts src/auth/oauth.test.ts src/auth/resolve-tokens.ts src/auth/resolve-tokens.test.ts
rtk git commit -m "Support OAuth resource identity refresh"
rtk git push
```

### Task 2: Honest meal aggregates and account-scoped nutrition sources

**Files:**
- Modify: `src/db/schema/enums.ts`
- Modify: `src/db/schema/nutrition.ts`
- Create: `drizzle/0124_meal_aggregate_nutrition_sources.sql`
- Modify: `drizzle/meta/_journal.json`
- Modify: `packages/nutrition/src/selected-date-summary.ts`
- Modify: `packages/nutrition/src/selected-date-summary.test.ts`
- Modify: `packages/nutrition/README.md`
- Modify: `packages/server/src/repositories/food-repository.ts`
- Modify: `packages/server/src/repositories/food-repository.test.ts`
- Modify: `packages/server/src/repositories/nutrition-analytics-repository.ts`
- Modify: `packages/server/src/repositories/nutrition-analytics-repository.test.ts`
- Modify: `packages/server/src/repositories/nutrition-canonical.integration.test.ts`
- Modify: `packages/server/src/repositories/nutrition-analytics-source-breakdown.integration.test.ts`
- Modify: `packages/web/src/components/MicronutrientChart.tsx`
- Modify: `packages/web/src/components/MicronutrientChart.test.tsx`
- Modify: `packages/web/src/components/MicronutrientChart.stories.tsx`
- Modify: `packages/mobile/app/nutrition-analytics.tsx`
- Modify: `packages/mobile/app-tests/nutrition-analytics.test.tsx`
- Modify: `docs/schema.md`
- Modify/generated: `docs/schema.dbml`, `docs/schema.puml`
- Modify: `docs/apple-health.md`

**Interfaces:**
- Consumes: `fitness.food_entry`, `fitness.nutrition_entry_grain`, `v_food_entry_effective`, `v_nutrition_daily_resolution`, `nutritionSourceResolutionSchema`, and source-breakdown analytics.
- Produces: `meal_aggregate` ranked after `itemized` and before `daily_aggregate`; nullable generic `source_account_key` used only for source identity; truthful meal-aggregate analytics labels.

- [ ] **Step 1: Read the applicable package/docs instructions and write failing canonical database cases**

Read `packages/nutrition/README.md`, `packages/provider-http/README.md` when that package is reached later, and `docs/AGENTS.md`. Extend the canonical integration helper for `meal_aggregate` and optional `sourceAccountKey`. Add executable PostgreSQL cases proving:

```ts
// Two meals from one account-scoped source are one available contribution set.
expect(row).toMatchObject({
  resolution_status: "available",
  contribution_grain: "meal_aggregate",
});

// Itemized outranks meal aggregate; meal aggregate outranks daily aggregate.
// Two different meal-aggregate source-account keys conflict instead of summing.
// A meal aggregate plus an ambiguous source conflicts.
// Meal aggregates appear once in v_nutrition_display_entry and contribute to
// meal counts, while their display-only item arrays never create extra rows.
// Existing edit and hide overlays still apply to the stable meal record.
```

- [ ] **Step 2: Write failing shared, repository, analytics, web, and mobile tests**

Add `meal_aggregate` parsing to the shared resolution schema and expect the server-authored label `"Ziva meal totals"`. Add `"meal_aggregate"` to `NutritionIntakeType`; source breakdown must label it `"Meal total"`, include its amount in the existing `foodDailyAverage`, and not fold it into `providerDailyTotalAverage`. Cover the label in both `MicronutrientChart` and the mobile nutrition analytics screen. Update the existing web story with a meal-total source rather than adding a new component.

- [ ] **Step 3: Run the focused tests and observe failures**

```bash
rtk pnpm vitest run --project unit packages/nutrition/src/selected-date-summary.test.ts packages/server/src/repositories/food-repository.test.ts packages/server/src/repositories/nutrition-analytics-repository.test.ts packages/web/src/components/MicronutrientChart.test.tsx
rtk pnpm test:mobile -- packages/mobile/app-tests/nutrition-analytics.test.tsx
rtk pnpm test:integration -- packages/server/src/repositories/nutrition-canonical.integration.test.ts packages/server/src/repositories/nutrition-analytics-source-breakdown.integration.test.ts
```

Expected: TypeScript/runtime schemas reject the new grain/type and PostgreSQL rejects the new enum literal/column.

- [ ] **Step 4: Add the generic column, enum, and complete in-place view migration**

Add nullable `sourceAccountKey: text("source_account_key")` to `foodEntry` and `"meal_aggregate"` to `nutritionEntryGrainEnum`. Register the provider-neutral migration name in the journal. The migration must:

1. add `fitness.food_entry.source_account_key`;
2. add the enum value;
3. `CREATE OR REPLACE` `v_food_entry_effective`, preserving every current output column in order and appending `source.source_account_key` at the end;
4. `CREATE OR REPLACE` `v_nutrition_entry_classification` with unchanged public columns but choose `source_key` in this order:

```sql
CASE
  WHEN NULLIF(BTRIM(food.source_account_key), '') IS NOT NULL
    THEN food.provider_id || ':account:' || BTRIM(food.source_account_key)
  WHEN NULLIF(BTRIM(food.source_name), '') IS NOT NULL
    AND LOWER(BTRIM(food.source_name)) <> LOWER(provider.name)
    THEN food.provider_id || ':' || BTRIM(food.source_name)
  ELSE food.provider_id || ':provider'
END
```

5. `CREATE OR REPLACE` the complete current `v_nutrition_daily_resolution` definition with unchanged output columns, adding meal-aggregate source counts/keys and exact priority `itemized` → `meal_aggregate` → `daily_aggregate` → singleton `ambiguous`;
6. `CREATE OR REPLACE` the complete current `v_nutrition_display_entry` definition with unchanged output columns and a provider-neutral filter that includes both `itemized` and `meal_aggregate`, while continuing to exclude `daily_aggregate` and `ambiguous` records.

Multiple sources at the selected tier conflict. Both singleton-ambiguous guards require meal-aggregate count zero. Use the generic exclusion message `Totals use the most detailed available source; overlapping less detailed sources are preserved but excluded.` Do not edit historical migrations. The display-view change is limited to the new honest meal grain and does not expose daily aggregate or ambiguous rows.

- [ ] **Step 5: Update all TypeScript consumers and current documentation**

Extend contribution-grain schemas and labels. In analytics, classify `effective_grain = 'meal_aggregate'` as intake type `meal_aggregate`; include `itemized_food` plus `meal_aggregate` in `foodDailyAverage`, while preserving daily aggregates separately. Extend the existing real-database food repository coverage to prove `byDate`, range meal counts, edit overlays, and hide overlays include a meal aggregate exactly once. Update current nutrition/schema/Apple Health descriptions to three-tier precedence and explain that itemized and meal-aggregate records are displayable while daily aggregates remain totals-only. Generate schema diagrams through the repository script—do not hand-edit generated output:

```bash
rtk pnpm tsx scripts/generate-schema-diagram.ts
```

- [ ] **Step 6: Run migration and all focused behavior checks**

```bash
rtk pnpm migrate
rtk pnpm lint:migrations
rtk pnpm vitest run --project unit packages/nutrition/src/selected-date-summary.test.ts packages/server/src/repositories/food-repository.test.ts packages/server/src/repositories/nutrition-analytics-repository.test.ts packages/web/src/components/MicronutrientChart.test.tsx
rtk pnpm test:mobile -- packages/mobile/app-tests/nutrition-analytics.test.tsx
rtk pnpm test:integration -- packages/server/src/repositories/nutrition-canonical.integration.test.ts packages/server/src/repositories/nutrition-analytics-source-breakdown.integration.test.ts
```

Expected: PASS, including real PostgreSQL source selection and account-source conflict behavior. Then run the mandatory pre-push gate, including mobile checks.

- [ ] **Step 7: Commit and push**

Stage only the listed source, migration, test, and generated documentation files after reviewing `git status --short`.

```bash
rtk git add src/db/schema/enums.ts src/db/schema/nutrition.ts drizzle/0124_meal_aggregate_nutrition_sources.sql drizzle/meta/_journal.json packages/nutrition/src/selected-date-summary.ts packages/nutrition/src/selected-date-summary.test.ts packages/nutrition/README.md packages/server/src/repositories/food-repository.ts packages/server/src/repositories/food-repository.test.ts packages/server/src/repositories/nutrition-analytics-repository.ts packages/server/src/repositories/nutrition-analytics-repository.test.ts packages/server/src/repositories/nutrition-canonical.integration.test.ts packages/server/src/repositories/nutrition-analytics-source-breakdown.integration.test.ts packages/web/src/components/MicronutrientChart.tsx packages/web/src/components/MicronutrientChart.test.tsx packages/web/src/components/MicronutrientChart.stories.tsx packages/mobile/app/nutrition-analytics.tsx packages/mobile/app-tests/nutrition-analytics.test.tsx docs/schema.md docs/schema.dbml docs/schema.puml docs/apple-health.md
rtk git commit -m "Model account-scoped meal nutrition sources"
rtk git push
```

### Task 3: Ziva OAuth identity

**Files:**
- Create: `src/providers/ziva/auth.ts`
- Create: `src/providers/ziva/auth.test.ts`

**Interfaces:**
- Consumes: `getOAuthRedirectUri()`, `exchangeCodeForTokens()`, and `OAuthConfig.resource` from Task 1.
- Produces: `createZivaAuthSetup(options, fetchFn?): ProviderAuthSetup | undefined`; `zivaSubjectFromAccessToken()` and `validateZivaRefreshedIdentity()` used by initial exchange and refresh; exchanged tokens always carry a verified nonblank `providerAccountId` from JWT `sub`.

- [ ] **Step 1: Write failing OAuth configuration tests**

Stub `ZIVA_CLIENT_ID`, `ZIVA_CLIENT_SECRET`, and `OAUTH_REDIRECT_URI`. Assert the setup uses:

```ts
{
  authorizeUrl: "https://connect.ziva.fit/authorize",
  tokenUrl: "https://connect.ziva.fit/token",
  scopes: [],
  usePkce: true,
  tokenAuthMethod: "body",
  resource: "https://connect.ziva.fit/mcp",
}
```

Assert missing either application credential returns no setup and produces the exact validation error later used by the provider.

- [ ] **Step 2: Write failing token-identity tests through the production exchange API**

Build synthetic JWTs in the test from base64url header/payload segments. Return them from a fake token endpoint and assert exchange accepts only:

```ts
{
  iss: "https://connect.ziva.fit/",
  aud: "https://connect.ziva.fit/mcp",
  sub: "stable-ziva-subject",
}
```

Cover array audience containing the resource, and reject malformed JWTs, wrong issuer, wrong audience, and blank/missing `sub`. Assert the returned `TokenSet.providerAccountId` is the subject while access tokens are never logged. Add refresh-validation cases for matching and changed subjects; the changed subject must throw `ProviderAuthorizationFailedError` before persistence.

- [ ] **Step 3: Run the tests and observe module-not-found failure**

```bash
rtk pnpm vitest run --project unit src/providers/ziva/auth.test.ts
```

- [ ] **Step 4: Implement the Ziva auth boundary**

Keep raw claim decoding inside this module and expose only the production identity functions used by the provider. Validate decoded claims with Zod, then return:

```ts
return {
  ...tokens,
  providerAccountId: claims.sub,
};
```

The setup's `exchangeCode` must require a PKCE verifier and call the shared exchange function with the configured resource. The refresh validator compares the refreshed JWT subject to the stored encrypted account identity. Signature verification is unavailable because Ziva advertises no JWKS endpoint; claim validation is safe here because the credential was obtained directly from the fixed HTTPS token endpoint and MCP independently rejects invalid bearer signatures. Do not implement DCR or revocation at runtime.

- [ ] **Step 5: Run the focused tests and mandatory pre-push gate**

```bash
rtk pnpm vitest run --project unit src/providers/ziva/auth.test.ts
```

Expected: PASS. Then run the common pre-push gate.

- [ ] **Step 6: Commit and push**

```bash
rtk git add src/providers/ziva/auth.ts src/providers/ziva/auth.test.ts
rtk git commit -m "Add Ziva OAuth identity validation"
rtk git push
```

### Task 4: Observed meal parsing and normalization

**Files:**
- Create: `src/providers/ziva/fixtures/observed-meal.sanitized.json`
- Create: `src/providers/ziva/schemas.ts`
- Create: `src/providers/ziva/schemas.test.ts`

**Interfaces:**
- Consumes: the sanitized authenticated result documented in the spec.
- Produces: `parseZivaMealPayload(value, { expectedDate }): ZivaMealPayload` and `normalizeZivaMeal(meal, { userId, accountSubject }): NormalizedZivaMeal`.

The normalized shape is:

```ts
export interface NormalizedZivaMeal {
  externalId: string;
  sourceAccountKey: string;
  date: string;
  meal: "breakfast" | "lunch" | "dinner" | "snack" | "other";
  foodName: string;
  foodDescription: string;
  numberOfUnits: number | null;
  servingUnit: string | null;
  servingWeightGrams: number | null;
  loggedAt: Date | null;
  raw: Record<string, unknown>;
  nutrients: Array<{
    nutrientId: "calories" | "protein" | "carbohydrate" | "fat";
    amount: number;
  }>;
}
```

- [ ] **Step 1: Add the sanitized observed fixture**

Use synthetic IDs, names, date, timestamps, and altered numeric values while retaining the observed keys:

```json
{
  "meals": [{
    "mealId": "meal_sanitized_001",
    "description": "Sanitized meal",
    "mealDate": "2000-01-02",
    "items": [{
      "food": "Sanitized food",
      "portion": "Sanitized portion",
      "gramWeight": null,
      "quantity": 1
    }],
    "macros": { "protein": 12, "fat": 15, "carbs": 34, "calories": 321 },
    "itemCount": 1,
    "mealType": "snack",
    "mealTime": null,
    "createdAt": "2000-01-02T03:04:05Z"
  }],
  "dailyTargets": { "protein": 50, "fat": 78, "carbs": 275, "calories": 2000 },
  "instructions": "Sanitized and ignored"
}
```

- [ ] **Step 2: Write failing parser and completeness tests**

Cover the observed fixture, `meals: []`, invalid dates, blank IDs, nonnumeric/negative macros, malformed item arrays, an `itemCount` mismatch, known/unknown meal types, and RFC 3339 timestamps with `Z` or offsets. Require every returned `mealDate` to equal `expectedDate` and every `mealId` to be unique within the whole response; a cross-date or duplicate-ID response rejects before normalization. Require all four verified macro keys: a missing or null macro rejects the payload rather than authorizing destructive replacement. A timezone-less `createdAt` remains raw and yields `loggedAt: null`.

- [ ] **Step 3: Write failing nutrition-semantics tests**

For the observed singleton shape, assert `quantity`, nonblank `portion`, and nullable `gramWeight` map to the three serving columns without changing macros. Use a clearly labeled synthetic multi-item resilience case with `quantity: 2`, `gramWeight: 200`, and meal macros of 400 dietary kcal. Assert normalization creates one meal aggregate totaling 400 kcal, not item rows and not 800 kcal, and sets all aggregate serving columns to null. This test prevents double counting; it does not claim live multi-item support.

Cover explicit zero for each verified macro. Compare absent unverified fiber with synthetic `fiber: 0`: neither becomes a nutrient row, while the explicit unknown field remains distinguishable in raw provenance. Do the same for unverified `sodium: 123` and `kilojoules: 456`: neither is mislabeled as a supported unit or converted to canonical intake. Assert `dailyTargets` and `instructions` never become intake.

Add explicit basis-boundary cases: the observed whole-meal `macros` object is
the only imported nutrient source. Clearly synthetic `perServingMacros` and
`per100GramMacros` fields remain in raw provenance and never become nutrient
rows or scaling inputs; a response that contains only either unsupported basis
and omits the complete observed whole-meal macro set is rejected.

Assert identity derivation is stable for the same `(Dofek user, Ziva subject, mealId)`, differs for a second Dofek user or second Ziva subject with the same `mealId`, and stores neither the raw subject nor raw meal ID in `externalId`/`sourceAccountKey`.

- [ ] **Step 4: Run tests and observe module-not-found failure**

```bash
rtk pnpm vitest run --project unit src/providers/ziva/schemas.test.ts
```

- [ ] **Step 5: Implement strict observed schemas and normalization**

Use `.passthrough()` at provider objects so unknown fields survive in `raw`, but validate every consumed field. Parse the complete response first, then reject duplicate meal IDs or any meal date other than the caller's validated expected date before returning it. Require each verified macro field to be a finite nonnegative number and emit all four rows, preserving exact zero. Account-scope identity with separate deterministic digests:

```ts
const sourceAccountKey = createHash("sha256")
  .update(`ziva\0${userId}\0${accountSubject}`)
  .digest("hex");
const externalId = `meal:${createHash("sha256")
  .update(`${sourceAccountKey}\0${meal.mealId}`)
  .digest("hex")}`;
```

Map `carbs` to canonical `carbohydrate`. For exactly one item, use its food name plus the meal description and serving fields; for any other item count, use the meal description/display summary and null serving fields. Preserve the complete meal object as raw provenance. Never place the raw account subject in a food row.

- [ ] **Step 6: Run tests and mandatory pre-push gate**

```bash
rtk pnpm vitest run --project unit src/providers/ziva/schemas.test.ts
```

Expected: PASS. Then run the common pre-push gate.

- [ ] **Step 7: Commit and push**

```bash
rtk git add src/providers/ziva/fixtures/observed-meal.sanitized.json src/providers/ziva/schemas.ts src/providers/ziva/schemas.test.ts
rtk git commit -m "Parse verified Ziva meal aggregates"
rtk git push
```

### Task 5: Deterministic MCP client and protocol harness

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `src/providers/ziva/client.ts`
- Create: `src/providers/ziva/client.test.ts`
- Create: `src/providers/ziva/test-helpers.ts`

**Interfaces:**
- Consumes: `parseZivaMealPayload()` from Task 4 and the official SDK.
- Produces: `ZivaMcpClient.connect({ accessToken, fetchFn, signal? })`, `getMealsForDate(date, options?)`, and `close()`; typed auth/tool/malformed-response errors.

- [ ] **Step 1: Write the protocol-level fake fetch harness**

The harness parses JSON-RPC POST bodies and responds to actual SDK traffic:

```ts
switch (request.method) {
  case "initialize":
    return jsonRpc(request.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "fake-ziva", version: "1" },
    });
  case "notifications/initialized":
    return new Response(null, { status: 202 });
  case "tools/list":
    return jsonRpc(request.id, { tools: [verifiedMealTool] });
  case "tools/call":
    return jsonRpc(request.id, configuredCallResult);
}
```

Handle optional GET with 405, retain received bearer headers and tool arguments for assertions, and support configured HTTP 401/429, delayed responses, tool `isError`, malformed content, and paginated `tools/list` cursors. This is a protocol-level transport harness, not a mocked `fetchMeals` function.

- [ ] **Step 2: Write failing SDK-client tests**

Cover initialization, all-page tool discovery, exact `start_date` arguments with no `end_date`, successful structured content, JSON-in-text fallback, valid empty results, mismatched structured/text rejection using semantic deep equality, non-JSON prose rejection, absent/writable tool rejection, HTTP 401 classification, HTTP 429 propagation, `isError`, malformed meal data, timeout, caller cancellation, redacted error messages, and client/transport close after every outcome. Extra write tools may be listed but can never be invoked through the adapter.

- [ ] **Step 3: Run tests and observe missing implementation/dependency failure**

```bash
rtk pnpm vitest run --project unit src/providers/ziva/client.test.ts
```

- [ ] **Step 4: Add the exact SDK dependency**

```bash
rtk pnpm view @modelcontextprotocol/sdk version
rtk pnpm add --save-exact -w @modelcontextprotocol/sdk@1.30.0
```

Verify the registry still reports `1.30.0`, the exact version already used by `packages/server`, and no second MCP client package was added. If the latest stable version changed, stop and reconcile compatibility rather than mixing SDK generations or performing an implicit repository-wide upgrade.

- [ ] **Step 5: Implement the focused client**

Use:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
```

Wrap injected fetch with `createProviderRateLimitFetch("ziva", fetchFn)`. Supply the bearer only through `requestInit.headers`; do not also provide an SDK OAuth provider. Call `client.connect(transport, { timeout: 30_000, signal })`, manually paginate `listTools` with the same bounded options, verify the observed read-only/non-destructive tool schema, and call:

```ts
await client.callTool(
  { name: "get_meals_for_date", arguments: { start_date: date } },
  undefined,
  { timeout: 30_000, signal },
);
```

Treat `StreamableHTTPError.code === 401` as the typed auth error. Check `isError` explicitly. If both result encodings exist, parse both and require `isDeepStrictEqual`; never compare serialized key order. Sanitize SDK/server error bodies before producing user-visible errors. The provider and smoke caller must always await `client.close()` in `finally`; never call `terminateSession()` because Ziva is stateless.

- [ ] **Step 6: Run focused tests, dependency policy checks, and mandatory pre-push gate**

```bash
rtk pnpm vitest run --project unit src/providers/ziva/client.test.ts
rtk pnpm lint:exact-versions
rtk pnpm typecheck
```

Expected: PASS.

Then run the common pre-push gate.

- [ ] **Step 7: Commit and push**

```bash
rtk git add package.json pnpm-lock.yaml src/providers/ziva/client.ts src/providers/ziva/client.test.ts src/providers/ziva/test-helpers.ts
rtk git commit -m "Add deterministic Ziva MCP client"
rtk git push
```

### Task 6: Transactional meal and nutrient upsert

**Files:**
- Create: `src/providers/ziva/nutrition-writer.ts`
- Create: `src/providers/ziva/nutrition-writer.integration.test.ts`

**Interfaces:**
- Consumes: `NormalizedZivaMeal` and the existing `foodEntry`/`foodEntryNutrient` tables.
- Produces: `upsertZivaMealsForDate(db, userId, meals): Promise<number>` with one date-level transaction and atomic exact-set replacement for every meal.

- [ ] **Step 1: Write failing real-database tests**

Cover first insert, identical repeat without duplicate rows, scalar/raw update, singleton serving/description edit, singleton-to-multi-item clearing of all serving columns, date/meal change, tenant isolation, and the same provider meal ID under distinct account keys. Assert `providerFoodId` and `providerServingId` remain null and the returned count is the number of logical meals in the validated date response.

Directly seed a stale fifth `fiber` row on an otherwise valid Ziva meal, then re-upsert the complete four-macro normalized record with carbohydrate exactly zero. Assert the stale row is removed and zero carbohydrate remains. Separately prove a missing/null macro payload is rejected by the parser before this writer is called, so exact-set replacement is authorized only for complete records.

Add a two-meal constraint-failure case that fails the second nutrient insert and proves the entire date—including the first meal, a new parent, and an existing parent's prior nutrients—rolls back. Add human nutrient, serving-field, and hide overlays before a raw re-sync and query effective views to prove the overlays survive the stable-key source update.

- [ ] **Step 2: Run the integration test and observe missing module failure**

```bash
rtk pnpm test:integration -- src/providers/ziva/nutrition-writer.integration.test.ts
```

- [ ] **Step 3: Implement a narrow transactional database requirement**

Keep `SyncDatabase` unchanged. Locally require:

```ts
type TransactionalSyncDatabase = SyncDatabase & Pick<Database, "transaction">;
```

Fail loudly when `transaction` is unavailable. Open one transaction for the complete validated date and run the following for each meal before returning `meals.length`:

```ts
const [row] = await tx
  .insert(foodEntry)
  .values({
    userId,
    providerId: "ziva",
    externalId: meal.externalId,
    sourceAccountKey: meal.sourceAccountKey,
    date: meal.date,
    nutritionGrain: "meal_aggregate",
    meal: meal.meal,
    foodName: meal.foodName,
    foodDescription: meal.foodDescription,
    numberOfUnits: meal.numberOfUnits,
    servingUnit: meal.servingUnit,
    servingWeightGrams: meal.servingWeightGrams,
    loggedAt: meal.loggedAt,
    sourceName: "Ziva",
    raw: meal.raw,
    confirmed: true,
  })
  .onConflictDoUpdate({
    target: [foodEntry.userId, foodEntry.providerId, foodEntry.externalId],
    set: {
      sourceAccountKey: meal.sourceAccountKey,
      date: meal.date,
      nutritionGrain: "meal_aggregate",
      meal: meal.meal,
      foodName: meal.foodName,
      foodDescription: meal.foodDescription,
      numberOfUnits: meal.numberOfUnits,
      servingUnit: meal.servingUnit,
      servingWeightGrams: meal.servingWeightGrams,
      loggedAt: meal.loggedAt,
      sourceName: "Ziva",
      raw: meal.raw,
      confirmed: true,
    },
  })
  .returning({ id: foodEntry.id });

await tx.delete(foodEntryNutrient).where(eq(foodEntryNutrient.foodEntryId, row.id));
if (meal.nutrients.length > 0) {
  await tx.insert(foodEntryNutrient).values(
    meal.nutrients.map(({ nutrientId, amount }) => ({
      foodEntryId: row.id,
      nutrientId,
      amount,
    })),
  );
}
```

Require the returned row to exist before replacing nutrients. Do not update human overlay tables and do not interpret missing dates/records as deletion.

- [ ] **Step 4: Run the integration test and mandatory pre-push gate**

Run the Step 2 command. Expected: PASS. Then run the common pre-push gate.

- [ ] **Step 5: Commit and push**

```bash
rtk git add src/providers/ziva/nutrition-writer.ts src/providers/ziva/nutrition-writer.integration.test.ts
rtk git commit -m "Upsert Ziva meals transactionally"
rtk git push
```

### Task 7: Date windows and continuation checkpoints

**Files:**
- Create: `src/providers/ziva/sync-plan.ts`
- Create: `src/providers/ziva/sync-plan.test.ts`

**Interfaces:**
- Consumes: `SyncWindow` and unknown checkpoint JSON.
- Produces: validated `ZivaSyncCheckpoint`, a maximum 14-date chunk, and the next checkpoint.

- [ ] **Step 1: Write failing pure date/checkpoint tests**

Cover inclusive since/until dates, leap day, explicit backfill bounds, full-window clamp to exactly 730 inclusive dates, exactly 14 dates per chunk, next-date continuation, final completion, malformed/stale checkpoint rejection, and cancellation/failure semantics where the caller does not request a checkpoint advance.

Add the regression that `SyncWindow.fromDateRange({ sinceDate: "2026-09-20", untilDate: "2026-09-20" })` plans only `2026-09-20`, including when the test process/user timezone is `America/Los_Angeles`. DST must not enter date-only arithmetic.

Use this checkpoint shape:

```ts
interface ZivaSyncCheckpoint {
  version: 1;
  nextDate: string;
  endDate: string;
  recordsSynced: number;
}
```

- [ ] **Step 2: Run tests and observe module-not-found failure**

```bash
rtk pnpm vitest run --project unit src/providers/ziva/sync-plan.test.ts
```

- [ ] **Step 3: Implement literal calendar-date slicing**

Do not use `formatDateYmdInTimeZone()` on these generic window bounds. `SyncWindow.fromDateRange()` and `lastDays()` intentionally encode their calendar bounds at UTC day start/end, so a non-full window uses `window.since.toISOString().slice(0, 10)` and `window.until.toISOString().slice(0, 10)` verbatim. A full epoch window takes its end ISO date and subtracts 729 date-only days for at most 730 inclusive dates. Perform increment/decrement in UTC over validated `YYYY-MM-DD` strings so DST cannot skip or duplicate diary dates. Export constants:

```ts
export const ZIVA_INITIAL_HISTORY_DAYS = 730;
export const ZIVA_DATES_PER_JOB = 14;
```

Reject a checkpoint whose `endDate` differs from the current computed window or whose `nextDate` lies outside it; never reset it silently.

- [ ] **Step 4: Run tests and mandatory pre-push gate**

```bash
rtk pnpm vitest run --project unit src/providers/ziva/sync-plan.test.ts
```

Expected: PASS. Then run the common pre-push gate.

- [ ] **Step 5: Commit and push**

```bash
rtk git add src/providers/ziva/sync-plan.ts src/providers/ziva/sync-plan.test.ts
rtk git commit -m "Plan bounded Ziva diary sync windows"
rtk git push
```

### Task 8: Sync provider orchestration and auth recovery

**Files:**
- Create: `src/providers/ziva/provider.ts`
- Create: `src/providers/ziva/provider.test.ts`
- Create: `src/providers/ziva/provider-sync.integration.test.ts`
- Create: `src/providers/ziva/msw-test-helpers.ts`

**Interfaces:**
- Consumes: auth, MCP client, normalization, writer, and sync-plan modules from Tasks 3–7.
- Produces: `ZivaProvider implements SyncProvider`, including `sync(run: SyncRun)` and standard OAuth `authSetup()`.

- [ ] **Step 1: Pin shared forced-refresh behavior**

Confirm Task 1's resolver test proves `forceRefresh: true` refreshes an otherwise unexpired token, validates before save, preserves provider account ID, and persists both rotated access and refresh tokens. Run it first and confirm the behavior is green before relying on it.

- [ ] **Step 2: Write failing provider unit tests with the protocol harness**

Cover validation/auth setup, a two-date successful sync, progress/cumulative counts, a tool error, incomplete-macro payload, cross-date meal, duplicate meal ID, rate-limit propagation, timeout/cancellation, and failed second date. Assert the first date is committed atomically, the checkpoint advances to the second date, the terminal result contains the committed count plus an error, the checkpoint does not pass the failed date, and the result is never reported as success/continued. Cross-date and duplicate-ID responses must write/count nothing for that date.

Cover 401 behavior precisely:

```ts
// validate the current access-token sub against stored providerAccountId
// malformed/wrong/mismatched current identity -> deleteTokens("ziva") -> reconnect
// first 401 -> resolveOAuthTokens({ forceRefresh: true, validateRefreshedTokens }) once
// matching rotated sub -> new client -> retry the failed date once
// changed/malformed sub -> deleteTokens("ziva") -> ProviderAuthorizationFailedError
// second 401 -> deleteTokens("ziva") -> RefreshTokenRevokedError
// invalid_grant during forced refresh -> shared resolver deletes tokens -> no MCP retry
```

- [ ] **Step 3: Write failing end-to-end provider/database integration tests**

Use the actual SDK client with global fetch and a real PostgreSQL database. Intercept the network boundary with root `msw@2.15.0` and `setupServer(http.all("https://connect.ziva.fit/mcp", ...))`; parse actual initialize, initialized-notification, tools/list, and tools/call JSON-RPC bodies in `msw-test-helpers.ts`. Do not use `vi.mock`, an injected fetch, or a global fetch spy in this integration test.

Seed encrypted tokens per user. Prove repeated sync idempotency, changed singleton portion/date, exact nutrient-set replacement, two users sharing one `mealId`, separate bearer headers per user, and no source session/client reuse. Reconnect one Dofek user to a new verified `sub` that reuses `mealId`; assert two account-scoped raw rows remain and an overlapping date resolves to `source_conflict`, never a silent sum.

Seed a prior Ziva row, return a successful `meals: []`, and assert the row remains visible because absence is non-authoritative while that successful date checkpoint advances. Return one valid date followed by malformed data and assert the error result reports the first date's committed count, cache-visible data remains idempotent, and the failed date checkpoint does not advance. A fresh manual retry starts its requested window again and safely upserts without duplication because completed-job checkpoints are not global state.

- [ ] **Step 4: Run tests and observe provider module failure**

```bash
rtk pnpm vitest run --project unit src/auth/resolve-tokens.test.ts src/providers/ziva/provider.test.ts
rtk pnpm test:integration -- src/providers/ziva/provider-sync.integration.test.ts
```

- [ ] **Step 5: Implement `ZivaProvider`**

Use `scheduledSyncLookbackDays = 1`. Require `run.options.userId`, a transaction-capable database, checkpoint storage, and continuation enqueue support. Do not read or apply the home timezone to date-only window bounds.

Resolve tokens once and validate the current JWT issuer, audience, and subject against nonblank `providerAccountId`. If that current credential is malformed or its subject differs, delete the stored Ziva credentials immediately and surface `ProviderAuthorizationFailedError` so scheduled sync cannot loop forever on a permanently invalid identity. Otherwise connect one user-bound MCP client and process the current 14-date chunk sequentially. For each date:

1. Fetch and fully validate the response, including exact requested dates and unique meal IDs.
2. Normalize every meal before any write.
3. Upsert all meals for that date in the single Task 6 transaction.
4. Add the committed logical meal count and only then save a checkpoint pointing at the next date.

Always close the active client in `finally`. Let `ProviderRateLimitError` and retryable database/Redis failures escape so the existing delayed/BullMQ path reuses the saved failed-date checkpoint. Convert terminal provider-service/timeout, MCP protocol/tool/schema, cancellation, and authorization failures into `SyncResult.errors` with the cumulative committed count and `continued: false`; this lets the worker invalidate caches and log an error with an accurate partial count. Do not clear the failed-date checkpoint. A later manual retry replays its requested window idempotently.

After a complete chunk with more dates, save/enqueue one continuation and return `continued: true`; on final successful completion clear the checkpoint. Never reconcile absent meal IDs. A successful empty date is complete only for checkpoint progression—not deletion inference.

For one auth error, close the old client, force refresh through `resolveOAuthTokens` with `validateZivaRefreshedIdentity`, and construct a fresh client. If refresh validation fails, delete stored Ziva credentials before surfacing `ProviderAuthorizationFailedError`; if the replacement bearer gets a second 401, delete credentials and surface `RefreshTokenRevokedError("Ziva")`. No other error is retried inside the provider.

- [ ] **Step 6: Run provider tests, integration tests, and mandatory pre-push gate**

Run the Step 4 commands. Expected: PASS. Then run the common pre-push gate.

- [ ] **Step 7: Commit and push**

```bash
rtk git add src/providers/ziva/provider.ts src/providers/ziva/provider.test.ts src/providers/ziva/provider-sync.integration.test.ts src/providers/ziva/msw-test-helpers.ts
rtk git commit -m "Sync Ziva meal history"
rtk git push
```

### Task 9: Application registration and shared web/mobile discovery

**Files:**
- Modify: `package.json`
- Modify: `.env.example`
- Modify: `scripts/deploy-service-environment.ts`
- Modify: `scripts/deploy-service-environment.test.ts`
- Modify: `src/account-erasure/remote-snapshot.ts`
- Modify: `src/account-erasure/remote-snapshot.integration.test.ts`
- Modify: `src/jobs/provider-registration.ts`
- Modify: `src/jobs/provider-registration.test.ts`
- Modify: `src/jobs/provider-queue-config.ts`
- Modify: `src/jobs/provider-queue-config.test.ts`
- Modify: `src/jobs/process-scheduled-sync-job.test.ts`
- Modify: `src/providers/provider-auth-policy.test.ts`
- Modify: `src/processing/dataset-contracts.ts`
- Modify: `src/processing/dataset-contracts.test.ts`
- Modify: `packages/server/src/routers/sync-helpers.ts`
- Modify: `packages/server/src/routers/sync-registration.test.ts`
- Modify: `packages/server/src/routers/sync.test.ts`
- Modify: `packages/providers-meta/src/provider-catalog.ts`
- Modify: `packages/providers-meta/src/providers.test.ts`
- Modify: `packages/onboarding/src/provider-guide.ts`
- Modify: `packages/onboarding/src/provider-guide.test.ts`
- Modify: `packages/provider-http/src/adaptive-rate-limit.ts`
- Modify: `packages/provider-http/src/adaptive-rate-limit.test.ts`
- Modify: `packages/web/src/components/DataSourcesPanel.test.tsx`
- Modify: `packages/mobile/app-tests/providers/index.test.tsx`

**Interfaces:**
- Consumes: `ZivaProvider` and all generic registry/auth/UI machinery.
- Produces: worker/server discovery, serialized queue execution, nutrition cache/status invalidation, and standard web/mobile Data Sources cards.

- [ ] **Step 1: Write failing registration, policy, metadata, and dataset tests**

Read `packages/provider-http/README.md` and its local `AGENTS.md`. Expect `ziva` in both registries, root package export `./providers/ziva`, auth-policy compliance with stubbed application credentials, queue config `{ concurrency: 1, syncTier: "frequent" }`, nutrition/provider dataset capabilities, provider label `Ziva`, and the onboarding nutrition category. Update mocked provider counts rather than weakening exact registry assertions.

Add adaptive/scheduled-dispatch tests proving Ziva is recognized as a step-chain provider and a scheduled job is skipped while any Ziva continuation for that user is queued/active. Confirm each real MCP request still passes through per-request adaptive admission; do not use `runWithSyncStepAdmission` for the 14-call loop or add a guessed vendor quota. Add one generic web Data Sources and one mobile provider-list assertion showing a configured `ziva` metadata row renders as `Ziva`.

Add deployment-environment rendering assertions that both `web.env` and `worker.env` retain `ZIVA_CLIENT_ID` and `ZIVA_CLIENT_SECRET`, while unrelated service artifacts do not receive them. Add an executable account-erasure snapshot case with an active Ziva connection that fails before confirmation with: `Disconnect Ziva in Dofek before deleting your account because Ziva does not advertise remote token revocation.` This must run before credentials enter a snapshot that the remote-revocation phase cannot complete.

- [ ] **Step 2: Run focused tests and observe failures**

```bash
rtk pnpm vitest run --project unit scripts/deploy-service-environment.test.ts src/jobs/provider-registration.test.ts src/jobs/provider-queue-config.test.ts src/jobs/process-scheduled-sync-job.test.ts src/providers/provider-auth-policy.test.ts src/processing/dataset-contracts.test.ts packages/server/src/routers/sync-registration.test.ts packages/server/src/routers/sync.test.ts packages/providers-meta/src/providers.test.ts packages/onboarding/src/provider-guide.test.ts packages/provider-http/src/adaptive-rate-limit.test.ts packages/web/src/components/DataSourcesPanel.test.tsx
rtk pnpm test:mobile -- packages/mobile/app-tests/providers/index.test.tsx
rtk pnpm test:integration -- src/account-erasure/remote-snapshot.integration.test.ts
```

- [ ] **Step 3: Wire the provider**

Add lazy constructors in both registries, the root export, `ZIVA_CLIENT_ID` and `ZIVA_CLIENT_SECRET` examples, auth-policy env stubs, explicit concurrency-one/frequent queue config without a speculative vendor quota, and `ziva: ["nutrition", "providers"]` processing capability. Add both Ziva application credentials to `APPLICATION_ENVIRONMENT_KEYS` so they reach the web OAuth callback path and worker sync path, but keep them optional and out of unrelated service policies. Add `ziva` to the nutrition dataset's provider IDs. Add `ziva` to `STEP_CHAIN_SYNC_PROVIDERS` solely so scheduled dispatch sees the continuation chain; leave per-request admission and `DEFAULT_HTTP_REQUESTS_PER_SYNC_JOB` unchanged.

Add a provider-specific pre-confirmation guard in `loadProviderConnections()` for active Ziva connections because the verified authorization metadata advertises no revocation endpoint. It must return the tested actionable disconnect message before any remote snapshot is persisted; do not add a fake `revokeUrl` or weaken the generic fail-closed remote revocation phase.

Add shared catalog metadata `{ label: "Ziva" }`, using the existing letter fallback; do not introduce a guessed logo or brand color. Add `ziva` to the onboarding nutrition provider list. No Ziva-specific web or mobile component is required.

- [ ] **Step 4: Run focused tests and mandatory pre-push gate**

```bash
rtk pnpm vitest run --project unit scripts/deploy-service-environment.test.ts src/jobs/provider-registration.test.ts src/jobs/provider-queue-config.test.ts src/jobs/process-scheduled-sync-job.test.ts src/providers/provider-auth-policy.test.ts src/processing/dataset-contracts.test.ts packages/server/src/routers/sync-registration.test.ts packages/server/src/routers/sync.test.ts packages/providers-meta/src/providers.test.ts packages/onboarding/src/provider-guide.test.ts packages/provider-http/src/adaptive-rate-limit.test.ts packages/web/src/components/DataSourcesPanel.test.tsx
rtk pnpm test:mobile -- packages/mobile/app-tests/providers/index.test.tsx
rtk pnpm test:integration -- src/account-erasure/remote-snapshot.integration.test.ts
rtk pnpm --filter @dofek/provider-http typecheck
rtk pnpm --filter @dofek/providers typecheck
rtk pnpm --filter @dofek/onboarding typecheck
```

Expected: PASS. Then run the full common pre-push gate, including mobile checks.

- [ ] **Step 5: Commit and push**

```bash
rtk git add package.json .env.example scripts/deploy-service-environment.ts scripts/deploy-service-environment.test.ts src/account-erasure/remote-snapshot.ts src/account-erasure/remote-snapshot.integration.test.ts src/jobs/provider-registration.ts src/jobs/provider-registration.test.ts src/jobs/provider-queue-config.ts src/jobs/provider-queue-config.test.ts src/jobs/process-scheduled-sync-job.test.ts src/providers/provider-auth-policy.test.ts src/processing/dataset-contracts.ts src/processing/dataset-contracts.test.ts packages/server/src/routers/sync-helpers.ts packages/server/src/routers/sync-registration.test.ts packages/server/src/routers/sync.test.ts packages/providers-meta/src/provider-catalog.ts packages/providers-meta/src/providers.test.ts packages/onboarding/src/provider-guide.ts packages/onboarding/src/provider-guide.test.ts packages/provider-http/src/adaptive-rate-limit.ts packages/provider-http/src/adaptive-rate-limit.test.ts packages/web/src/components/DataSourcesPanel.test.tsx packages/mobile/app-tests/providers/index.test.tsx
rtk git commit -m "Register Ziva across Dofek"
rtk git push
```

### Task 10: Read-only smoke command, provider documentation, and deployment credentials

**Files:**
- Create: `src/providers/ziva/diagnostic.ts`
- Create: `src/providers/ziva/diagnostic.test.ts`
- Create: `scripts/ziva-smoke.ts`
- Modify: `package.json`
- Create: `docs/ziva.md`
- Modify: `docs/README.md`
- Modify: `src/providers/README.md`

**Interfaces:**
- Consumes: encrypted token loading and the production `ZivaMcpClient`.
- Produces: `pnpm smoke:ziva -- --user-id "$DOFEK_ZIVA_SMOKE_USER_ID" --date YYYY-MM-DD`, which performs only read operations and outputs no diary content, IDs, credentials, or nutrient amounts.

- [ ] **Step 1: Write failing redaction/diagnostic tests**

Test a diagnostic summary containing only tool presence, meal count, field availability, nutrient-key availability, and whether meal/item IDs and gram weights are present. Assert it excludes names, descriptions, portions, IDs, macro amounts, JWT claims, bearer values, and raw tool text.

- [ ] **Step 2: Implement the dry-run command**

The command validates `--user-id` and `--date`, opens the configured database, loads/decrypts that user's stored Ziva token read-only, validates its Ziva subject, and fails if it is expired instead of refreshing/persisting. It uses the production MCP client, prints the redacted summary, and closes client/database resources. It never calls the writer, saves tokens, or invokes a Ziva write tool.

To keep dry-run free of Dofek writes while retaining HTTP timeout/status behavior, first wrap global fetch with `createRateLimitAwareFetch(fetch, { providerId: "ziva" })` without an adaptive store, then pass that already-wrapped fetch to `ZivaMcpClient`. The provider wrapper recognizes it as wrapped and does not attach the Redis-backed adaptive store. Test that the command path has no writer, checkpoint, token-save/refresh, or adaptive-store dependency.

Add:

```json
"smoke:ziva": "tsx scripts/with-env.ts -- tsx scripts/ziva-smoke.ts"
```

- [ ] **Step 3: Write the cited provider document**

Document:

- official MCP docs, protected-resource/authorization metadata, pricing, and official SDK links;
- verified DCR, PKCE/resource, one-hour JWT, stable `sub`, refresh rotation, empty scopes, and absent revocation endpoint;
- the exact verified dynamic-registration request needed by a self-hosted Dofek deployment, safe handling of its client secret, the exact registered callback requirement, deployment allowlist behavior, and `ZIVA_CLIENT_ID`/`ZIVA_CLIENT_SECRET` setup;
- exact user-facing Data Sources connect, reconnect, disconnect, and account-deletion prerequisite steps; explain that disconnect deletes Dofek's credentials but cannot claim server-side revocation because Ziva advertises no revocation endpoint;
- observed meal fields, meal-level total basis, four supported macros/units, one-item-only verification, and unavailable fiber/micros/item IDs;
- one-date calls, 730-day initial bound, 14-date continuations, timezone rules, update behavior, local-overlay preservation, and no source deletion inference;
- smoke command and its no-write/no-refresh behavior.

Clearly distinguish the sanitized live observation from synthetic test cases and state that only one item was logged/observed; multi-item payloads, multi-date reads, pagination, explicit unit metadata, and deletion semantics were not verified. Explain that `calories`/macro values are stored using Ziva's documented dietary-calorie/macro convention (kcal/g), with no scaling or conversion because the read carries no unit fields.

Add `docs/ziva.md` to the Provider Research table in `docs/README.md`. Cite Ziva's MCP docs, pricing, protected-resource metadata URL, authorization-server metadata URL, and the official SDK at each third-party behavior section. Label authenticated facts as direct read-only observations at the linked endpoint rather than implying the public docs publish the response schema.

- [ ] **Step 4: Provision application credentials without exposing values**

Follow the repository's workstation procedure before any secret write:

```bash
rtk command -v infisical
rtk mise which infisical
rtk infisical --version
rtk mise exec -- infisical --version
```

Perform an escalated, names-only production export check. Store the already registered production callback client's ID and secret from the mode-0600 temporary registration file as `ZIVA_CLIENT_ID` and `ZIVA_CLIENT_SECRET` in the production Infisical environment, redirecting both command streams away from tool output. Verify afterward by key name only. Never print a raw export or secret value. After successful verification, delete the exact temporary client-registration credential file/directory; do not delete it before the production values are confirmed. If access is unavailable, report this as a deployment blocker rather than committing a shared token.

- [ ] **Step 5: Run focused tests and a read-only smoke check**

```bash
rtk pnpm vitest run --project unit src/providers/ziva/diagnostic.test.ts
rtk pnpm smoke:ziva -- --user-id "$DOFEK_ZIVA_SMOKE_USER_ID" --date 2026-09-20
```

The live command requires a normally connected Dofek user with an unexpired token. Expected output is redacted metadata only. If normal Data Sources authorization must be exercised locally, start the API server with its required quick tunnel, register that emitted callback URI with Ziva, and report only the emitted `https://…trycloudflare.com` URL for the server.

- [ ] **Step 6: Run the mandatory pre-push gate, then commit and push**

After the focused diagnostic test/smoke evidence, run the common pre-push gate.

```bash
rtk git add src/providers/ziva/diagnostic.ts src/providers/ziva/diagnostic.test.ts scripts/ziva-smoke.ts package.json docs/ziva.md docs/README.md src/providers/README.md
rtk git commit -m "Document and diagnose Ziva sync"
rtk git push
```

### Task 11: Full verification and independent review

**Files:**
- Modify only files implicated by a failing check or valid review finding.

**Interfaces:**
- Consumes: the complete branch.
- Produces: evidence that Ziva works without weakening existing FatSecret, auth, nutrition, migration, web, or mobile behavior.

- [ ] **Step 1: Run formatting, lint, dependency, and migration checks**

```bash
rtk pnpm lint
rtk pnpm lint:migrations
rtk pnpm knip
rtk pnpm migrate
```

- [ ] **Step 2: Run unit and integration tiers**

```bash
rtk pnpm test:unit
rtk pnpm test:mobile
rtk pnpm test:integration
```

Confirm the existing FatSecret client/parser/provider tests remain green alongside Ziva.

- [ ] **Step 3: Run typechecks and builds**

```bash
rtk pnpm typecheck
rtk pnpm --filter dofek-server typecheck
rtk pnpm --filter dofek-web typecheck
rtk pnpm --filter dofek-mobile typecheck
rtk pnpm --filter @dofek/providers typecheck
rtk pnpm --filter @dofek/onboarding typecheck
rtk pnpm --filter @dofek/nutrition typecheck
rtk pnpm build
rtk pnpm --filter dofek-web build
```

- [ ] **Step 4: Verify the branch diff and external-state claims**

Check that no user token, client secret, raw live meal, temporary callback URL, raw Ziva subject, fake claim of fiber/unit support, Ziva write-tool call, or unrelated refactor entered the diff. Confirm the provider is hidden without application credentials and discoverable with them on both generic web and mobile Data Sources surfaces; the deployment renderer supplies the configured credentials to web and worker only. Confirm meal aggregates appear exactly once in ordinary food reads and meal counts, edits/hides survive resync, old/new account rows conflict instead of summing, active Ziva blocks account-erasure confirmation with the documented disconnect action, and FatSecret regression tests remain green.

- [ ] **Step 5: Request independent whole-branch review**

Use `superpowers:requesting-code-review` with the spec, plan, base commit, and branch head. Fix only validated findings, rerun the implicated checks, and preserve evidence of any pre-existing failure.

- [ ] **Step 6: Commit and push final fixes**

If review or verification changed files, first confirm `git status --short` lists only reviewed corrections, stage those exact paths (including any intentional new file), rerun the mandatory pre-push gate, then commit and push. Do not use a broad add that could capture unrelated work.

```bash
rtk git status --short
rtk git commit -m "Harden Ziva nutrition sync"
rtk git push
```

- [ ] **Step 7: Apply completion verification**

Use `superpowers:verification-before-completion`. Check the pushed commit's CI status without claiming success while jobs are pending. Record exact commands/results, implementation-backed versus contract-only live verification, supported/unavailable fields, the one-item-only observation, refresh behavior, identity/update/deletion/timezone/missing-nutrient semantics, Infisical status, and the smallest remaining external action in the final report.
