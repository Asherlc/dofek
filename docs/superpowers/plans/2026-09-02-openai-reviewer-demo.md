# OpenAI Reviewer Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a deterministic synthetic production fixture and truthful Apps SDK/MCP demonstration for the OpenAI reviewer account.

**Architecture:** A narrowly scoped TypeScript operational fixture resolves exactly `asherlc+openai-review@asherlc.com` and writes only rows with dedicated synthetic-review provenance. It writes relational records to Postgres and HRV/steps samples through the canonical ClickHouse ingestion path, then verifies the deduped analytics series. The MCP explorer uses the existing server-side health-series service, but returns the Apps SDK envelope expected by the registered UI resource. Focused route tests cover the public tool contracts; authenticated production calls provide final evidence.

**Tech Stack:** TypeScript, Postgres/Drizzle tagged query client, ClickHouse sensor store, Express MCP SDK, Zod, Vitest, Apps SDK.

**Spec:** `docs/superpowers/specs/2026-09-02-openai-reviewer-demo-design.md`

## Global Constraints

- Never query, copy, expose, or mutate real health data; resolve only the exact reviewer email.
- Seed canonical provider-attributed raw records; HRV/steps must enter the canonical ClickHouse ingestion path and no provider-estimated energy data may be introduced.
- Health values remain computed on the server; the Explorer only renders server-provided series.
- The fixture must be deterministic, idempotent, and fail loudly when the reviewer account is absent.
- Apps SDK results use `structuredContent` matching the output contract, visible `content`, and component-only `_meta` ([OpenAI guidance](https://developers.openai.com/plugins/reference#tool-results)).
- Test first, observe each test fail for the named missing behavior, then implement the minimum change.
- Deploy through the normal repository path and validate only through `https://dofek.fit/api/mcp`.

---

### Task 1: Make Explorer results Apps SDK-compatible

**Files:**
- Modify: `packages/server/src/mcp/tools.ts:504-520`
- Modify: `packages/server/src/mcp/route.test.ts:1460-1515`

**Interfaces:**
- Consumes: `HealthExplorerService.snapshot(input): Promise<HealthExplorerSnapshot>`.
- Produces: `render_health_explorer` result with `structuredContent`, visible text `content`, and `_meta.ui.resourceUri` equal to `healthExplorerResourceUri`.

- [ ] **Step 1: Write the failing route-contract test**

Extend the existing Explorer test to require this observable result envelope:

```ts
expect(parsedResponse.result).toMatchObject({
  content: [{ type: "text", text: expect.stringContaining("Dofek Analytics Explorer") }],
  structuredContent: {
    range: { start_date: "2026-05-18", end_date: "2026-05-19" },
    series: [expect.objectContaining({ metric: "hrv" })],
  },
  _meta: { ui: { resourceUri: "ui://dofek/health-explorer.html" } },
});
```

The production mutation this catches is returning only the snapshot (or `null`) without a valid Apps SDK UI result.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm vitest packages/server/src/mcp/route.test.ts -t "returns a structured analytics snapshot for the interactive explorer"`

Expected: FAIL because the result lacks `_meta` and the user-facing Explorer content.

- [ ] **Step 3: Implement the minimal result adapter**

In the `render_health_explorer` handler, build the existing snapshot once and return:

```ts
{
  structuredContent: snapshot,
  content: [{ type: "text", text: "Dofek Analytics Explorer is ready for the requested HRV and steps range." }],
  _meta: { ui: { resourceUri: healthExplorerResourceUri } },
}
```

Keep raw chart data in `structuredContent`; do not alter `HealthExplorerService` calculations.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `pnpm vitest packages/server/src/mcp/route.test.ts -t "returns a structured analytics snapshot for the interactive explorer"`

Expected: PASS.

- [ ] **Step 5: Commit and push Task 1**

```bash
git add packages/server/src/mcp/tools.ts packages/server/src/mcp/route.test.ts
git commit -m "fix: return Apps SDK Explorer result"
git push
```

### Task 2: Make the five tool descriptors unambiguous

**Files:**
- Modify: `packages/server/src/mcp/tools.ts:436-867`
- Modify: `packages/server/src/mcp/route.test.ts:520-700`

**Interfaces:**
- Produces exact-purpose descriptions for `get_health_trends`, `render_health_explorer`, `get_sleep_summary`, `search_activities`, and `list_providers`.
- Preserves current input schemas and read-only annotations.

- [ ] **Step 1: Write failing descriptor tests**

Add a tools/list assertion that each descriptor visibly distinguishes its intended user-facing outcome, for example:

```ts
expect(findListedTool(tools, "get_health_trends").description).toContain("HRV, steps");
expect(findListedTool(tools, "render_health_explorer").description).toContain("interactive Explorer");
expect(findListedTool(tools, "get_sleep_summary").description).toContain("sleep");
expect(findListedTool(tools, "search_activities").description).toContain("date range");
expect(findListedTool(tools, "list_providers").description).toContain("last-sync");
```

The production mutation this catches is an ambiguous descriptor that lets a prompt select a similarly scoped but incorrect tool.

- [ ] **Step 2: Run descriptor tests to verify they fail**

Run: `pnpm vitest packages/server/src/mcp/route.test.ts -t "lists the expected MCP tools"`

Expected: FAIL on the missing specificity in current descriptions.

- [ ] **Step 3: Make descriptions direct and prompt-aligned**

Set the descriptions to describe only their user intent: daily HRV/steps trends, opening the interactive Explorer, nightly sleep summary, activity date-range search, and connected-provider last-sync status. Do not change schemas or tool names.

- [ ] **Step 4: Run descriptor tests to verify they pass**

Run: `pnpm vitest packages/server/src/mcp/route.test.ts -t "lists the expected MCP tools"`

Expected: PASS.

- [ ] **Step 5: Commit and push Task 2**

```bash
git add packages/server/src/mcp/tools.ts packages/server/src/mcp/route.test.ts
git commit -m "docs: clarify MCP tool selection"
git push
```

### Task 3: Add a safe production reviewer fixture

**Files:**
- Create: `scripts/seed-openai-reviewer-demo.ts`
- Create: `scripts/seed-openai-reviewer-demo.integration.test.ts`
- Modify: `package.json`
- Modify: `scripts/README.md`

**Interfaces:**
- Consumes: `DATABASE_URL`, the exact reviewer email, and the configured ClickHouse ingestion/analytics clients.
- Produces: deterministic HRV/step samples in ClickHouse for 2026-08-18 through 2026-08-31, seven Postgres sleep sessions for 2026-08-25 through 2026-08-31, several Postgres activities in the range, and connected providers with fixed last-sync timestamps.
- Fails: reviewer account absent or a target record cannot be marked as synthetic reviewer data.

- [ ] **Step 1: Write a real-Postgres integration test**

Create a fixture account with the exact reviewer email in the isolated test database, run the new seeder, then assert literal expected records:

```ts
expect(await dailyMetricDates(sql, reviewerId)).toEqual([
  "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21", "2026-08-22", "2026-08-23", "2026-08-24",
  "2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28", "2026-08-29", "2026-08-30", "2026-08-31",
]);
expect(await dedupedSensorDates(clickhouse, reviewerId, ["hrv", "steps"])).toEqual([
  "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21", "2026-08-22", "2026-08-23", "2026-08-24",
  "2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28", "2026-08-29", "2026-08-30", "2026-08-31",
]);
expect(await sleepDates(sql, reviewerId)).toEqual([
  "2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28", "2026-08-29", "2026-08-30", "2026-08-31",
]);
expect(await activitiesInRange(sql, reviewerId)).toHaveLength(4);
expect(await connectedProviderLastSyncs(sql, reviewerId)).toEqual([
  { provider_id: "apple_health", last_synced: "2026-08-31T17:15:00.000Z" },
  { provider_id: "whoop", last_synced: "2026-08-31T17:00:00.000Z" },
]);
```

Run the seeder twice and assert that the same account has the same record counts, while a second account remains untouched. The production mutation this catches is accidentally widening the cleanup/insert scope beyond the reviewer account.

- [ ] **Step 2: Run the integration test to verify it fails**

Run: `pnpm test:integration -- scripts/seed-openai-reviewer-demo.integration.test.ts`

Expected: FAIL because the reviewer-only operational seeder does not exist.

- [ ] **Step 3: Implement a narrow, idempotent TypeScript seeder**

Implement `seedOpenAiReviewerDemo(sql)` with these invariants:

```ts
const REVIEWER_EMAIL = "asherlc+openai-review@asherlc.com";
const SYNTHETIC_PROVENANCE = "openai_reviewer_demo_2026_08";
const START_DATE = "2026-08-18";
const END_DATE = "2026-08-31";
```

Resolve one `fitness.user_profile` record by the exact email. Delete or upsert only Postgres rows joined to that user and carrying `SYNTHETIC_PROVENANCE`; write HRV/steps through the existing canonical ClickHouse ingest writer using synthetic provider attribution. Verify the corresponding `analytics.deduped_sensor` rows before reporting success. Store synthetic provenance in existing appropriate source/reference fields—do not add schema fields or use provider-specific food columns. Emit record counts only, never row payloads or health values.

Add a package script that executes it with `pnpm tsx`, document the exact required environment and the account-only safety boundary in `scripts/README.md`.

- [ ] **Step 4: Run the integration test to verify it passes**

Run: `pnpm test:integration -- scripts/seed-openai-reviewer-demo.integration.test.ts`

Expected: PASS, including the second-run idempotency and untouched-control-account assertions.

- [ ] **Step 5: Commit and push Task 3**

```bash
git add scripts/seed-openai-reviewer-demo.ts scripts/seed-openai-reviewer-demo.integration.test.ts package.json scripts/README.md
git commit -m "feat: seed OpenAI reviewer demo data"
git push
```

### Task 4: Deploy and collect production-only synthetic evidence

**Files:**
- Modify: `docs/mcp.md`

**Interfaces:**
- Consumes: deployed production version, synthetic reviewer authentication, and `https://dofek.fit/api/mcp`.
- Produces: a concise evidence table with exact prompt, invoked tool, successful status, and synthetic result coverage.

- [ ] **Step 1: Deploy through the existing production workflow**

Use the repository’s normal deploy mechanism for the pushed branch. Do not run ad-hoc database SQL on the production host.

- [ ] **Step 2: Run the reviewer-only fixture through the approved production operation**

Use the documented TypeScript fixture command with production environment credentials. Verify only its printed counts and the exact reviewer-account identifier; do not inspect unrelated users or raw result rows.

- [ ] **Step 3: Verify all exact prompts through production MCP**

Authenticate as the synthetic reviewer, then submit the following prompts and capture the selected tool and response status:

| Prompt | Expected tool | Successful synthetic evidence |
|---|---|---|
| Show my HRV and step trend from August 18 through August 31, 2026. | `get_health_trends` | Both daily series have 14 observed days. |
| Open the Dofek Analytics Explorer for HRV and steps from August 18 through August 31, 2026. | `render_health_explorer` | Apps SDK envelope has Explorer resource metadata and HRV/steps series. |
| Summarize my sleep from August 25 through August 31, 2026. | `get_sleep_summary` | Seven nightly records. |
| Show my activities from August 18 through August 31, 2026. | `search_activities` | Four synthetic activities. |
| Which Dofek providers are connected, and when did they last sync? | `list_providers` | Connected synthetic providers with non-null last-sync timestamps. |

- [ ] **Step 4: Document the stable contract, not credentials or data values**

Update `docs/mcp.md` with a brief reviewer-demo verification section that names the synthetic-only fixture, the coverage dates, endpoint, and no-real-data requirement. Cite the Apps SDK contract link already used in this plan.

- [ ] **Step 5: Run final verification and commit/push documentation**

Run: `pnpm lint && pnpm typecheck && pnpm test:changed:all`

Then commit:

```bash
git add docs/mcp.md
git commit -m "docs: record MCP reviewer demo verification"
git push
```
