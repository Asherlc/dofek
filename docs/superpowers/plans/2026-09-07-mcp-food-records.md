# MCP Food Records Implementation Plan

<!-- cspell:ignore dbml worktree -->

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let authenticated MCP clients search, read, create, update, delete, restore, and inspect the history of effective food records.

**Architecture:** A food-specific domain service resolves stable human-record identities and appends changes to the shared ledger from PR #2678. Normalized nutrient decisions and effective PostgreSQL views apply human assertions before canonical source selection; typed MCP tools provide transport, authorization, annotations, and structured results.

**Tech Stack:** TypeScript, Zod 4, Drizzle ORM, PostgreSQL, Model Context Protocol TypeScript SDK, Vitest.

**Spec:** [`docs/superpowers/specs/2026-09-07-mcp-food-records-design.md`](../specs/2026-09-07-mcp-food-records-design.md)

## Global Constraints

- Keep provider rows raw; no MCP command may update or physically delete a provider food row.
- Store scalar decisions in `human_record_target.fields`; store nutrient decisions as normalized rows.
- Apply effective decisions before canonical nutrition contribution selection and aggregation.
- Require `nutrition:read` for reads and both `nutrition:read` and `nutrition:write` for mutations.
- Existing tokens and OAuth grants do not gain `nutrition:write` automatically.
- Every write is user-scoped, account-erasure fenced, idempotent by request UUID, and optimistic-concurrency checked.
- Report unexpected caught errors to Sentry and return actionable domain errors.
- Use real PostgreSQL integration tests for migration, view, concurrency, null/clear, and aggregation semantics.
- Do not add web or mobile food editing controls in this MCP transport slice.
- Do not add dependencies, retries, timeouts, fallbacks, or compatibility mutation paths.

---

### Task 1: Normalized Food Nutrient Decisions

**Files:**
- Create: `drizzle/0112_human_food_nutrient_decisions.sql`
- Modify: `drizzle/meta/_journal.json`
- Modify: `src/db/schema/record-modifications.ts`
- Create: `src/db/food-record-modifications.integration.test.ts`

**Interfaces:**
- Consumes: `fitness.human_record_target`, `fitness.nutrient`, and `fitness.reject_human_record_mutation()` from migrations 0110–0111.
- Produces: `fitness.human_food_nutrient_decision` and `fitness.v_human_food_nutrient_decision`, keyed by target and nutrient.

- [ ] **Step 1: Write the failing database tests**

Add fixtures using `setupTestDatabase()` and test these executable cases:

```ts
it("stores set, explicit-null, and clear nutrient decisions", async () => {
  await insertDecision(firstTarget, "protein", "set", 30);
  await insertDecision(secondTarget, "protein", "set", null);
  await insertDecision(thirdTarget, "protein", "clear", null);
  expect(await effectiveNutrient(identityId, "protein")).toEqual({
    operation: "clear",
    amount: null,
    targetId: thirdTarget,
  });
});

it("rejects negative amounts, clear-with-value, duplicate nutrients, and cross-user targets", async () => {
  await expect(insertDecision(targetId, "protein", "set", -1)).rejects.toMatchObject({
    cause: { code: "23514" },
  });
  await expect(insertDecision(targetId, "protein", "clear", 1)).rejects.toMatchObject({
    cause: { code: "23514" },
  });
});

it("keeps nutrient decisions append-only except during verified account erasure", async () => {
  await expect(db.execute(sql`DELETE FROM fitness.human_food_nutrient_decision`)).rejects.toMatchObject({
    cause: { code: "55000" },
  });
  await erasePostgresAccount(db, userId);
  expect(await decisionsFor(userId)).toEqual([]);
});
```

- [ ] **Step 2: Run the test and verify the missing-table failure**

Run:

```bash
pnpm vitest run --project integration src/db/food-record-modifications.integration.test.ts
```

Expected: FAIL because `fitness.human_food_nutrient_decision` does not exist.

- [ ] **Step 3: Add the Drizzle schema**

Add this production table shape to `record-modifications.ts`:

```ts
export const humanFoodNutrientDecision = fitness.table(
  "human_food_nutrient_decision",
  {
    targetId: uuid("target_id").notNull(),
    identityId: uuid("identity_id").notNull(),
    userId: uuid("user_id").notNull().$defaultFn(resolveImplicitUserId),
    nutrientId: text("nutrient_id").notNull().references(() => nutrient.id),
    operation: text("operation", { enum: ["set", "clear"] }).notNull(),
    amount: real("amount"),
  },
  (table) => [
    primaryKey({ columns: [table.targetId, table.nutrientId] }),
    foreignKey({
      name: "human_food_nutrient_decision_target_fk",
      columns: [table.targetId, table.identityId, table.userId],
      foreignColumns: [humanRecordTarget.id, humanRecordTarget.identityId, humanRecordTarget.userId],
    }),
    check(
      "human_food_nutrient_decision_value_valid",
      sql`(${table.operation} = 'clear' AND ${table.amount} IS NULL)
          OR (${table.operation} = 'set' AND (${table.amount} IS NULL OR ${table.amount} >= 0))`,
    ),
  ],
);
```

Import `real`, `primaryKey`, and `nutrient` in the production schema. The table includes user and identity columns so ownership is enforced by the existing composite target key and account erasure can identify the owner.

- [ ] **Step 4: Write migration 0112**

Create the matching table, constraints, and append-only trigger. Add a nearest-decision view that walks each identity's target chain and ranks one decision per nutrient by depth:

```sql
CREATE VIEW fitness.v_human_food_nutrient_decision AS
SELECT head.user_id, head.identity_id, decision.nutrient_id,
       decision.operation, decision.amount, decision.target_id
FROM fitness.v_human_record_head AS head
CROSS JOIN LATERAL (
  WITH RECURSIVE history AS (
    SELECT target.id, target.predecessor_id, 0 AS depth
    FROM fitness.human_record_target AS target
    WHERE target.id = head.target_id
    UNION ALL
    SELECT predecessor.id, predecessor.predecessor_id, history.depth + 1
    FROM history
    JOIN fitness.human_record_target AS predecessor
      ON predecessor.id = history.predecessor_id
      AND predecessor.identity_id = head.identity_id
      AND predecessor.user_id = head.user_id
  ), ranked AS (
    SELECT nutrient.*, history.depth,
           row_number() OVER (PARTITION BY nutrient.nutrient_id ORDER BY history.depth) AS decision_rank
    FROM history
    JOIN fitness.human_food_nutrient_decision AS nutrient ON nutrient.target_id = history.id
  )
  SELECT * FROM ranked WHERE decision_rank = 1
) AS decision;
```

Attach `fitness.reject_human_record_mutation()` for update/delete and finish with `SELECT fitness.refresh_account_erasure_write_fences();`. Add journal entry index 114 with tag `0112_human_food_nutrient_decisions` and a timestamp greater than 0111.

- [ ] **Step 5: Run the focused integration test**

Run the Task 1 Vitest command again. Expected: PASS for set, explicit-null, clear, constraints, projection, and erasure.

- [ ] **Step 6: Commit Task 1**

```bash
git add drizzle/0112_human_food_nutrient_decisions.sql drizzle/meta/_journal.json src/db/schema/record-modifications.ts src/db/food-record-modifications.integration.test.ts
git commit -m "feat(nutrition): store food nutrient decisions"
```

---

### Task 2: Effective Food and Canonical Nutrition Views

**Files:**
- Create: `drizzle/0113_effective_food_records.sql`
- Modify: `drizzle/meta/_journal.json`
- Modify: `src/db/food-record-modifications.integration.test.ts`
- Modify: `packages/server/src/repositories/nutrition-canonical.integration.test.ts`
- Modify: `docs/schema.dbml`
- Modify: `docs/schema.puml`

**Interfaces:**
- Consumes: `v_human_record_field`, `v_human_record_visibility`, and `v_human_food_nutrient_decision`.
- Produces: `v_food_entry_effective`, `v_food_entry_effective_nutrient`, and canonical nutrition views that consume effective rows.

- [ ] **Step 1: Add failing effective-view tests**

Extend the real-database fixture with a provider entry and stable identity, then assert:

```ts
it("applies scalar and nutrient decisions without changing raw source rows", async () => {
  await appendUpdate({
    identityId,
    fields: { meal: { operation: "set", value: "dinner" } },
    nutrients: { protein: { operation: "set", amount: 30 } },
  });
  expect(await effectiveFood(identityId)).toMatchObject({ meal: "dinner", protein_g: 30 });
  expect(await rawFood(sourceRowId)).toMatchObject({ meal: "lunch", protein_g: 20 });
});

it("distinguishes explicit null from clearing a nutrient override", async () => {
  await appendNutrient(identityId, "protein", "set", null);
  expect((await effectiveFood(identityId)).protein_g).toBeNull();
  await appendNutrient(identityId, "protein", "clear", null);
  expect((await effectiveFood(identityId)).protein_g).toBe(20);
});

it("keeps decisions after replacement under the same provider external key", async () => {
  await replaceSourceRowWithSameExternalId(sourceRowId);
  expect(await effectiveFood(identityId)).toMatchObject({ record_id: identityId, meal: "dinner" });
});
```

Add canonical total assertions that deletion removes the entry, restoration adds it back, and corrected nutrients contribute exactly once under existing source-resolution rules.

- [ ] **Step 2: Run both integration files and verify view failures**

```bash
pnpm vitest run --project integration src/db/food-record-modifications.integration.test.ts packages/server/src/repositories/nutrition-canonical.integration.test.ts
```

Expected: FAIL because the effective views do not exist and canonical totals still read raw nutrients.

- [ ] **Step 3: Implement migration 0113**

Create `v_food_entry_effective` with one row per source food entry. Resolve identities on `(user_id, domain = 'nutrition.food', namespace = provider_id, source_key)`, where source key is `external:<external_id>` when present and `row:<food_entry.id>` otherwise. Overlay the supported scalar fields with typed casts from `v_human_record_field`, retain raw and effective values separately where provenance requires them, and expose:

```text
record_id, source_entry_id, user_id, provider_id, external_id,
date, meal, food_name, food_description, category, number_of_units,
serving_unit, serving_weight_grams, deleted, version,
modifiable, modification_unavailable_reason
```

Create `v_food_entry_effective_nutrient` by combining source nutrient rows with nearest decisions. A `clear` decision selects the source value, a `set NULL` decision emits an explicit null effective value, and a numeric set emits the corrected amount.

Recreate dependent views in dependency order so:

- `v_nutrition_provider_daily` remains the raw provider projection.
- `v_nutrition_entry_classification` reads effective visible rows.
- `v_nutrition_daily_resolution` keeps current source selection.
- `v_nutrition_canonical_nutrient` reads effective nutrients.
- `v_nutrition_daily`, `v_food_entry_with_nutrition`, and `v_nutrition_display_entry` expose effective values.

Use the complete current definitions from migrations 0006, 0060, 0061, and 0065; change only their food input relations and effective field names. Add journal entry index 115 tagged `0113_effective_food_records`.

- [ ] **Step 4: Run effective-view and canonical nutrition tests**

Run the Task 2 Vitest command again. Expected: PASS with unchanged raw rows and corrected effective totals.

- [ ] **Step 5: Regenerate and verify schema diagrams**

```bash
pnpm schema:diagram
git diff --check
```

Expected: DBML and PlantUML include the nutrient decision table and its foreign keys; no unrelated schema changes appear.

- [ ] **Step 6: Commit Task 2**

```bash
git add drizzle/0113_effective_food_records.sql drizzle/meta/_journal.json src/db/food-record-modifications.integration.test.ts packages/server/src/repositories/nutrition-canonical.integration.test.ts docs/schema.dbml docs/schema.puml
git commit -m "feat(nutrition): project effective food records"
```

---

### Task 3: Food Record Read Repository

**Files:**
- Create: `packages/server/src/repositories/food-record-repository.ts`
- Create: `packages/server/src/repositories/food-record-repository.test.ts`
- Create: `packages/server/src/repositories/food-record-repository.integration.test.ts`
- Create: `packages/server/src/repositories/food-record-types.ts`

**Interfaces:**
- Consumes: effective views from Task 2 and `executeWithSchema()`.
- Produces: `FoodRecordRepository.search()`, `.get()`, `.history()`, and `.resolveStableIdentity()` plus shared food record types.

- [ ] **Step 1: Define production-facing record types**

Create Zod-backed types used by the repository, service, and MCP adapter:

```ts
export const foodRecordVisibilitySchema = z.enum(["visible", "deleted", "all"]);
export const foodRecordCursorSchema = z.object({ date: dateStringSchema, recordId: z.uuid() });

export interface EffectiveFoodRecord {
  recordId: string;
  sourceEntryId: string;
  version: string | null;
  deleted: boolean;
  modifiable: boolean;
  modificationUnavailableReason: string | null;
  date: string;
  meal: string | null;
  foodName: string | null;
  foodDescription: string | null;
  category: string | null;
  numberOfUnits: number | null;
  servingUnit: string | null;
  servingWeightGrams: number | null;
  nutrients: Record<string, number | null>;
  sourceProvider: string;
  provenance: Record<string, { origin: "source" | "human"; changeId: string | null }>;
}
```

Use concrete Zod row schemas for every raw SQL result. Do not export a type solely for a test.

- [ ] **Step 2: Write failing repository unit tests**

Mock only the database boundary and verify query parameters, row-to-domain mapping, cursor behavior, deleted filters, and user scoping. Test one source file in `food-record-repository.test.ts`.

```ts
expect(await repository.search({
  startDate: "2026-09-01",
  endDate: "2026-09-07",
  query: "oats",
  visibility: "visible",
  cursor: null,
  limit: 20,
})).toEqual({ items: [expectedRecord], nextCursor: null });
```

- [ ] **Step 3: Run the unit test and verify missing implementation**

```bash
pnpm vitest run --project unit packages/server/src/repositories/food-record-repository.test.ts
```

Expected: FAIL because `FoodRecordRepository` is not implemented.

- [ ] **Step 4: Implement the read repository**

Use this public interface:

```ts
export class FoodRecordRepository {
  constructor(database: Pick<Database, "execute" | "transaction">, userId: string) {}
  search(input: FoodRecordSearchInput): Promise<FoodRecordSearchResult>;
  get(recordId: string): Promise<EffectiveFoodRecord | null>;
  history(recordId: string, cursor: string | null, limit: number): Promise<FoodRecordHistoryPage>;
  resolveStableIdentity(sourceEntryId: string): Promise<{ identityId: string; sourceEntryId: string }>;
}
```

`search()` first inserts missing structural identities for its matching user-owned rows with `ON CONFLICT DO NOTHING`, then reads the effective view in the same transaction. External-key identities are modifiable; row-key identities are readable with `modifiable: false`. This internal structural write is idempotent and does not change effective user data.

`resolveStableIdentity()` selects a user-owned confirmed source row, requires a non-empty external ID, inserts `(nutrition.food, provider_id, external:<external_id>)` with `ON CONFLICT DO NOTHING`, and selects the canonical identity. Return a typed `FoodRecordPreconditionError` for a row-key identity.

- [ ] **Step 5: Add and run real-database repository tests**

Cover user isolation, text/date search, `visible`/`deleted`/`all`, stable cursor pagination, detail of a deleted record, provenance, history ordering, idempotent identity resolution, and the unstable-source precondition.

```bash
pnpm vitest run --project integration packages/server/src/repositories/food-record-repository.integration.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

```bash
git add packages/server/src/repositories/food-record-types.ts packages/server/src/repositories/food-record-repository.ts packages/server/src/repositories/food-record-repository.test.ts packages/server/src/repositories/food-record-repository.integration.test.ts
git commit -m "feat(server): read effective food records"
```

---

### Task 4: Food Record Command Service

**Files:**
- Create: `packages/server/src/services/food-record-service.ts`
- Create: `packages/server/src/services/food-record-service.test.ts`
- Create: `packages/server/src/services/food-record-service.integration.test.ts`
- Modify: `packages/server/src/repositories/food-record-repository.ts`
- Modify: `packages/server/src/repositories/food-record-repository.test.ts`

**Interfaces:**
- Consumes: `FoodRecordRepository`, existing account-erasure fences, `FoodRepository.create()`, and `invalidateNutritionCaches()`.
- Produces: `FoodRecordService.create()`, `.update()`, `.delete()`, and `.restore()` with typed commands and domain errors.

- [ ] **Step 1: Write failing service tests**

Use repository fakes through constructor injection and cover validation, canonical request hashing, replay, changed-body conflict, stale versions, source ownership, client attribution, and affected-date cache invalidation.

```ts
const service = new FoodRecordService({
  database,
  userId: "user-id",
  actor: { channel: "mcp", clientId: "token:token-id" },
  invalidateNutritionCaches,
});

await expect(service.delete({
  recordId,
  expectedVersion,
  requestId,
})).resolves.toMatchObject({ record: { recordId, deleted: true } });

await expect(service.update({
  recordId,
  expectedVersion: staleVersion,
  requestId: randomUUID(),
  set: { meal: "dinner" },
  clear: [],
  nutrientSet: {},
  nutrientClear: [],
})).rejects.toMatchObject({ code: "CONFLICT" });
```

- [ ] **Step 2: Run the unit test and verify missing service failure**

```bash
pnpm vitest run --project unit packages/server/src/services/food-record-service.test.ts
```

Expected: FAIL because `FoodRecordService` does not exist.

- [ ] **Step 3: Add append-command repository operations**

Extend `FoodRecordRepository` with production methods used by the service:

```ts
findRequest(requestId: string): Promise<StoredFoodRecordRequest | null>;
createSourceAndIdentity(input: CreateFoodRecordInput, requestId: string): Promise<FoodRecordHead>;
appendChange(input: {
  identityId: string;
  expectedVersion: string;
  requestId: string;
  requestHash: string;
  kind: "update" | "delete" | "restore";
  actor: { channel: "mcp"; clientId: string };
  fields: Record<string, HumanRecordFieldDecision>;
  nutrients: Record<string, { operation: "set" | "clear"; amount: number | null }>;
  deleted: boolean | null;
}): Promise<FoodRecordHead>;
```

`appendChange()` runs in the caller's transaction, locks the current head, compares `expectedVersion`, inserts the change and successor target, inserts normalized nutrient decisions, and maps unique predecessor violations to `FoodRecordConflictError`. It never calls legacy `FoodRepository.update()` or `.delete()`.

- [ ] **Step 4: Implement the command service**

Define Zod command schemas and these error codes:

```ts
type FoodRecordErrorCode =
  | "NOT_FOUND"
  | "PRECONDITION_FAILED"
  | "CONFLICT"
  | "INVALID_ARGUMENT"
  | "ACCOUNT_ERASURE_ACTIVE";
```

Canonicalize validated commands with stable object-key and nutrient-key ordering before SHA-256 hashing. On replay, return the stored operation only when hashes match. Wrap create and append operations with `withAccountErasureUserWriteFence()`. Invalidate the user's nutrition caches after commit; date-moving updates carry both old and new dates in the result for verification even though the existing invalidator clears all user nutrition prefixes.

Create generates `externalId = mcp:${requestId}`, stores initial itemized facts once through `FoodRepository.create()`, resolves the Dofek identity, and appends a `create` change with an empty target. Update represents nullable values as `set` decisions and uses explicit `clear` arrays to follow source values. Delete appends `deleted: true`; restore appends `deleted: false` and no field decisions.

- [ ] **Step 5: Run service unit tests**

Run the Task 4 unit command again. Expected: PASS.

- [ ] **Step 6: Add real-database command tests**

Cover create, update, null/clear, delete, restore, history, replay, request-ID conflict, concurrent expected-version conflict, raw-row preservation, cross-user access, provider replacement, daily totals, and account erasure.

```bash
pnpm vitest run --project integration packages/server/src/services/food-record-service.integration.test.ts
```

Expected: PASS without retries or arbitrary waits.

- [ ] **Step 7: Commit Task 4**

```bash
git add packages/server/src/repositories/food-record-repository.ts packages/server/src/repositories/food-record-repository.test.ts packages/server/src/services/food-record-service.ts packages/server/src/services/food-record-service.test.ts packages/server/src/services/food-record-service.integration.test.ts
git commit -m "feat(server): modify food through record ledger"
```

---

### Task 5: Typed MCP Food Tools

**Files:**
- Create: `packages/server/src/mcp/food-record-tools.ts`
- Create: `packages/server/src/mcp/food-record-tools.test.ts`
- Modify: `packages/server/src/mcp/context.ts`
- Modify: `packages/server/src/mcp/route.ts`
- Modify: `packages/server/src/mcp/route.test.ts`
- Modify: `packages/server/src/mcp/tools.ts`
- Modify: `packages/server/src/mcp/tool-output.ts`
- Modify: `packages/server/src/mcp/tool-result.ts`
- Modify: `packages/server/src/mcp/tool-result.test.ts`

**Interfaces:**
- Consumes: `FoodRecordService` and read repository from Tasks 3–4.
- Produces: seven MCP tools and typed success/error results.

- [ ] **Step 1: Write failing tool-result tests**

Add a production `jsonToolError()` helper contract:

```ts
expect(jsonToolError("CONFLICT", "The food record changed. Read it again.", {
  current_version: "target-2",
})).toEqual({
  content: [{
    type: "text",
    text: JSON.stringify({
      error: {
        code: "CONFLICT",
        message: "The food record changed. Read it again.",
        details: { current_version: "target-2" },
      },
    }, null, 2),
  }],
  isError: true,
});
```

- [ ] **Step 2: Write failing MCP tool tests**

Mock `FoodRecordService` at the module boundary and verify all seven names, concrete input/output schemas, annotations, scope checks, snake-case mapping, client identity, success results, and each domain error mapping.

```ts
expect(tool("delete_food_entry").annotations).toEqual({
  readOnlyHint: false,
  openWorldHint: false,
  destructiveHint: true,
  idempotentHint: true,
});

expect(deleteFood).toHaveBeenCalledWith({
  recordId: "11111111-1111-4111-8111-111111111111",
  expectedVersion: "22222222-2222-4222-8222-222222222222",
  requestId: "33333333-3333-4333-8333-333333333333",
});
```

- [ ] **Step 3: Run MCP unit tests and verify missing-tool failures**

```bash
pnpm vitest run --project unit packages/server/src/mcp/tool-result.test.ts packages/server/src/mcp/food-record-tools.test.ts
```

Expected: FAIL because the helper and registrations do not exist.

- [ ] **Step 4: Add MCP client attribution to context**

Extend `DofekMcpContext` with `clientId: string`. Populate it in `route.ts` as:

```ts
clientId: validatedToken.oauthClientId
  ? `oauth:${validatedToken.oauthClientId}`
  : `token:${validatedToken.tokenId}`,
```

Update existing context fixtures in `route.test.ts` and any direct `createDofekMcpServer()` calls.

- [ ] **Step 5: Implement output schemas and error helper**

Add reusable food-record, provenance, history-page, mutation-result, and search-page Zod output schemas to `tool-output.ts`. Add `jsonToolError()` to `tool-result.ts`; error text contains only code, actionable message, and safe details.

- [ ] **Step 6: Register the seven tools**

Implement `registerFoodRecordTools(server, context)` with:

```text
search_food_entries
get_food_entry
create_food_entry
update_food_entry
delete_food_entry
restore_food_entry
get_food_entry_history
```

Each read handler calls `requireMcpScope(scopes, "nutrition:read")`. Each mutation calls it for both `nutrition:read` and `nutrition:write`, constructs `FoodRecordService` with the authenticated user/client, and maps `FoodRecordError` to `jsonToolError()`. Unexpected errors call `captureException()` before returning a safe internal error. Register the module once from `createDofekMcpServer()`.

- [ ] **Step 7: Run focused MCP tests**

```bash
pnpm vitest run --project unit packages/server/src/mcp/tool-result.test.ts packages/server/src/mcp/food-record-tools.test.ts packages/server/src/mcp/route.test.ts
```

Expected: PASS, including destructive annotations, read/write scope combinations, and client attribution.

- [ ] **Step 8: Commit Task 5**

```bash
git add packages/server/src/mcp/food-record-tools.ts packages/server/src/mcp/food-record-tools.test.ts packages/server/src/mcp/context.ts packages/server/src/mcp/route.ts packages/server/src/mcp/route.test.ts packages/server/src/mcp/tools.ts packages/server/src/mcp/tool-output.ts packages/server/src/mcp/tool-result.ts packages/server/src/mcp/tool-result.test.ts
git commit -m "feat(mcp): add food record lifecycle tools"
```

---

### Task 6: Nutrition Write Authorization and Consent

**Files:**
- Modify: `packages/server/src/mcp/token-repository.ts`
- Modify: `packages/server/src/mcp/token-repository.test.ts`
- Modify: `packages/server/src/mcp/token-repository.integration.test.ts`
- Modify: `packages/server/src/mcp/oauth-provider.ts`
- Modify: `packages/server/src/mcp/oauth-provider.test.ts`
- Modify: `packages/server/src/mcp/oauth-route.test.ts`
- Modify: `packages/server/src/mcp/oauth.integration.test.ts`
- Modify: `packages/server/src/routers/mcp.test.ts`
- Modify: `packages/web/src/pages/McpTokensPanel.tsx`
- Modify: `packages/web/src/pages/McpTokensPanel.test.tsx`

**Interfaces:**
- Consumes: existing MCP token and OAuth scope infrastructure.
- Produces: explicit `nutrition:write` grants for new credentials only.

- [ ] **Step 1: Add failing scope and consent tests**

Assert the schema accepts `nutrition:write`, OAuth metadata advertises it, consent renders `Modify your food records`, and a newly created manual token can contain it. Preserve this regression:

```ts
it("does not add nutrition write to existing tokens", async () => {
  const token = await createMcpToken(db, {
    userId,
    name: "Read only",
    scopes: ["nutrition:read"],
    expiresAt: null,
  });
  expect((await validateMcpToken(db, token.token))?.scopes).toEqual(["nutrition:read"]);
});
```

For the web token panel, assert the new checkbox is available but toggling it does not silently alter an existing token; rotation copies only that token's stored scopes.

- [ ] **Step 2: Run focused tests and verify unsupported-scope failures**

```bash
pnpm vitest run --project unit packages/server/src/mcp/token-repository.test.ts packages/server/src/mcp/oauth-provider.test.ts packages/server/src/mcp/oauth-route.test.ts packages/server/src/routers/mcp.test.ts packages/web/src/pages/McpTokensPanel.test.tsx
```

Expected: FAIL because `nutrition:write` is absent from the MCP scope enum and UI.

- [ ] **Step 3: Restore the explicit write scope**

Add `nutrition:write` to `mcpScopeSchema`, `MCP_OAUTH_SCOPES`, and `MCP_SCOPE_LABELS`. Use the consent label `Modify your food records`. Add the web scope option `{ value: "nutrition:write", label: "Modify food records" }`.

Do not add a migration that updates stored token or grant arrays. Migration 0098's historical removal remains intact; only newly authorized credentials obtain write scope.

- [ ] **Step 4: Run unit and OAuth integration tests**

```bash
pnpm vitest run --project unit packages/server/src/mcp/token-repository.test.ts packages/server/src/mcp/oauth-provider.test.ts packages/server/src/mcp/oauth-route.test.ts packages/server/src/routers/mcp.test.ts packages/web/src/pages/McpTokensPanel.test.tsx
pnpm vitest run --project integration packages/server/src/mcp/token-repository.integration.test.ts packages/server/src/mcp/oauth.integration.test.ts
```

Expected: PASS, with old credentials unchanged and explicit new grants accepted.

- [ ] **Step 5: Commit Task 6**

```bash
git add packages/server/src/mcp/token-repository.ts packages/server/src/mcp/token-repository.test.ts packages/server/src/mcp/token-repository.integration.test.ts packages/server/src/mcp/oauth-provider.ts packages/server/src/mcp/oauth-provider.test.ts packages/server/src/mcp/oauth-route.test.ts packages/server/src/mcp/oauth.integration.test.ts packages/server/src/routers/mcp.test.ts packages/web/src/pages/McpTokensPanel.tsx packages/web/src/pages/McpTokensPanel.test.tsx
git commit -m "feat(mcp): authorize nutrition record writes"
```

---

### Task 7: Documentation and Complete Verification

**Files:**
- Modify: `docs/mcp.md`
- Modify: `docs/schema.md`
- Modify: `packages/server/README.md`
- Modify: `docs/superpowers/plans/2026-09-07-mcp-food-records.md`

**Interfaces:**
- Consumes: final tool names, scope behavior, schema, and commands from Tasks 1–6.
- Produces: current human-facing documentation and recorded validation evidence.

- [ ] **Step 1: Update current documentation**

Document all seven tools in `docs/mcp.md`, including read/write scope combinations, destructive deletion, request IDs, expected versions, deleted search, and reauthorization. Update `docs/schema.md` with effective food projections and normalized nutrient decisions. Update `packages/server/README.md` to name `FoodRecordService` as the single mutation boundary for MCP and future clients.

Support third-party protocol claims with the existing official MCP tool-specification citation. Describe repository behavior directly and link to the schema and service source.

- [ ] **Step 2: Run focused database and MCP verification**

```bash
pnpm vitest run --project integration src/db/food-record-modifications.integration.test.ts packages/server/src/repositories/nutrition-canonical.integration.test.ts packages/server/src/repositories/food-record-repository.integration.test.ts packages/server/src/services/food-record-service.integration.test.ts packages/server/src/mcp/token-repository.integration.test.ts packages/server/src/mcp/oauth.integration.test.ts
pnpm vitest run --project unit packages/server/src/repositories/food-record-repository.test.ts packages/server/src/services/food-record-service.test.ts packages/server/src/mcp/food-record-tools.test.ts packages/server/src/mcp/tool-result.test.ts packages/server/src/mcp/route.test.ts packages/server/src/mcp/token-repository.test.ts packages/server/src/mcp/oauth-provider.test.ts packages/server/src/mcp/oauth-route.test.ts packages/server/src/routers/mcp.test.ts packages/web/src/pages/McpTokensPanel.test.tsx
```

Expected: all focused tests PASS.

- [ ] **Step 3: Run schema, migration, type, lint, and changed-test gates**

```bash
pnpm schema:diagram
pnpm lint:migrations
pnpm typecheck
pnpm --dir packages/server typecheck
pnpm --dir packages/web typecheck
pnpm lint
pnpm test:changed:all
git diff --check
```

Expected: every command exits 0 without new retries, waits, ignores, threshold changes, or skipped gates.

- [ ] **Step 4: Record exact validation evidence in this plan**

Append a dated `## Validation Results` section containing each command, exit status, test counts, and any environment limitation. If a required check fails, fix the root cause and rerun that check before recording success.

- [ ] **Step 5: Commit documentation and generated schema output**

```bash
git add docs/mcp.md docs/schema.md docs/schema.dbml docs/schema.puml packages/server/README.md docs/superpowers/plans/2026-09-07-mcp-food-records.md
git commit -m "docs: document MCP food record lifecycle"
```

- [ ] **Step 6: Review the complete branch diff**

```bash
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
git status --short
```

Expected: only the approved food lifecycle, its shared server foundation, tests, schema output, and docs are present; the worktree is clean.
