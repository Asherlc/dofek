# Dofek MCP Analytics Explorer Implementation Plan

**Goal:** Ship a secure, read-only Dofek Analytics Explorer MCP App and make `https://dofek.fit/api/mcp` the sole production MCP/OAuth origin.

**Architecture:** The existing Streamable HTTP MCP service remains the authenticated, user-scoped data boundary. A new server analytics snapshot contract powers a dedicated MCP App resource; the React/ECharts resource renders only server-provided values and requests subsequent snapshots through the MCP Apps bridge. Deploy configuration and OAuth metadata use `dofek.fit` consistently.

**Tech Stack:** TypeScript, Express, `@modelcontextprotocol/sdk`, current stable MCP Apps extension package, React 19, ECharts 6, Vite 8, Zod 4, Vitest 4, Docker, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-30-dofek-mcp-plugin-ecosystems-design.md`

## Global Constraints

- Canonical public origin and MCP endpoint are `https://dofek.fit` and `https://dofek.fit/api/mcp`; do not retain a parallel `dofek.asherlc.com` MCP/OAuth identity.
- Health values, aggregates, coverage, and chart-ready series are server-computed; the MCP App only renders and formats them.
- All existing query tools and `render_health_explorer` declare `readOnlyHint: true`; `start_provider_sync` remains non-read-only.
- The Explorer uses the existing ECharts stack; do not add another charting library.
- Do not expose diagnoses, treatment advice, real-user data, or direct browser requests to a Dofek health API.
- Follow TDD: write and observe each failing test before the matching implementation.
- Verify the current stable dependency version from its official source before adding or updating it, then pin the exact version.
- This is a ChatGPT/MCP-App surface, not a new Dofek product screen; the existing mobile app needs no duplicate UI.

---

## Planned file structure

| File | Responsibility |
| --- | --- |
| `packages/server/src/mcp/tool-result.ts` | Build consistent text plus `structuredContent` MCP results. |
| `packages/mcp-contracts/src/health-explorer.ts` | Shared Zod wire contract used by server and MCP App. |
| `packages/server/src/mcp/health-explorer-service.ts` | Compose a user-scoped, chart-ready analytics snapshot from existing repositories. |
| `packages/server/src/mcp/app-resource.ts` | Register the MCP App HTML resource with strict CSP metadata. |
| `packages/server/src/mcp/tools.ts` | Add annotations, structured results, Explorer tool, and resource registration. |
| `packages/server/src/mcp/*.test.ts` | Focused unit tests next to each server source file. |
| `packages/mcp-app/` | Vite/React bundle that speaks the MCP Apps bridge and renders Explorer data. |
| `Dockerfile` | Build and copy the resource bundle into the server image. |
| `deploy/stack.yml`, deployment workflows | Make `dofek.fit` the canonical app/MCP public URL. |
| `docs/mcp.md` | Correct connection and capability documentation. |

### Task 1: Establish a testable MCP result and Explorer contract

**Files:**
- Create: `packages/server/src/mcp/tool-result.ts`
- Create: `packages/server/src/mcp/tool-result.test.ts`
- Create: `packages/mcp-contracts/package.json`
- Create: `packages/mcp-contracts/tsconfig.json`
- Create: `packages/mcp-contracts/src/health-explorer.ts`
- Create: `packages/mcp-contracts/src/health-explorer.test.ts`
- Modify: `packages/server/package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`

**Interfaces:**
- Produces `jsonToolResult<T>(value: T): { content: [{ type: "text"; text: string }]; structuredContent: T }`.
- Produces `healthExplorerInputSchema` with `start_date`, `end_date`, `metrics`, `granularity`, and optional `timezone`.
- Produces `HealthExplorerSnapshot` with `range`, `series`, `summary`, and `coverage` fields; absent observations are `null`.

- [ ] **Step 1: Write the failing result-contract test**

~~~ts
it("returns the exact value as structuredContent and readable JSON text", () => {
  const value = { range: { start_date: "2026-08-01", end_date: "2026-08-07" } };
  expect(jsonToolResult(value)).toEqual({
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  });
});
~~~

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/server/src/mcp/tool-result.test.ts`  
Expected: FAIL because `tool-result.ts` does not exist.

- [ ] **Step 3: Implement the generic tool-result helper**

~~~ts
export function jsonToolResult<T>(value: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}
~~~

- [ ] **Step 4: Write failing Explorer input and snapshot tests**

~~~ts
it("rejects reversed ranges and ranges longer than 366 days", () => {
  expect(() => healthExplorerInputSchema.parse({
    start_date: "2026-08-08", end_date: "2026-08-01", metrics: ["hrv"], granularity: "daily",
  })).toThrow("start_date must be on or before end_date");
});
it("accepts a snapshot with missing observations represented as null", () => {
  expect(healthExplorerSnapshotSchema.parse(fixture)).toEqual(fixture);
});
~~~

- [ ] **Step 5: Run the tests to verify they fail**

Run: `pnpm vitest run packages/mcp-contracts/src/health-explorer.test.ts`  
Expected: FAIL because schemas do not exist.

- [ ] **Step 6: Implement Zod schemas and shared types**

~~~ts
export const healthExplorerInputSchema = z.object({
  start_date: dateSchema,
  end_date: dateSchema,
  metrics: z.array(healthMetricSchema).min(1).max(4).default(["hrv", "resting_hr"]),
  granularity: z.enum(["daily", "weekly"]).default("daily"),
  timezone: z.string().min(1).optional(),
}).superRefine((value, context) => {
  if (value.start_date > value.end_date) {
    context.addIssue({ code: "custom", message: "start_date must be on or before end_date" });
  }
});
export type HealthExplorerSnapshot = z.infer<typeof healthExplorerSnapshotSchema>;
~~~

Factor the existing health metric definition into this contract rather than duplicating it. The final snapshot schema includes display-ready labels/units, date/week keys, values, server-calculated range summaries, and coverage counts.

- [ ] **Step 7: Run focused tests to verify they pass**

Run: `pnpm vitest run packages/server/src/mcp/tool-result.test.ts packages/mcp-contracts/src/health-explorer.test.ts`  
Expected: PASS.

- [ ] **Step 8: Commit**

~~~bash
git add packages/server/src/mcp/tool-result.ts packages/server/src/mcp/tool-result.test.ts packages/mcp-contracts packages/server/package.json pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat: define MCP explorer contracts"
~~~

### Task 2: Compose server-owned analytics snapshots and register safe tool metadata

**Files:**
- Create: `packages/server/src/mcp/health-explorer-service.ts`
- Create: `packages/server/src/mcp/health-explorer-service.test.ts`
- Modify: `packages/server/src/mcp/tools.ts`
- Create: `packages/server/src/mcp/tools.test.ts` if absent

**Interfaces:**
- Consumes `HealthExplorerInput` and `HealthExplorerSnapshot` from `@dofek/mcp-contracts`.
- Produces `createHealthExplorerSnapshot(context, input): Promise<HealthExplorerSnapshot>`.
- Produces query tool descriptors with `annotations: { readOnlyHint: true }`.

- [ ] **Step 1: Write the failing service test**

~~~ts
it("returns sorted chart points, server-calculated summary, and coverage", async () => {
  const snapshot = await createHealthExplorerSnapshot(context, {
    start_date: "2026-08-01", end_date: "2026-08-03", metrics: ["hrv"], granularity: "daily",
  });
  expect(snapshot.series).toEqual([{ metric: "hrv", unit: "ms", points: [
    { key: "2026-08-01", value: 51 }, { key: "2026-08-02", value: null }, { key: "2026-08-03", value: 56 },
  ] }]);
  expect(snapshot.summary).toEqual([{ metric: "hrv", average: 53.5, min: 51, max: 56 }]);
  expect(snapshot.coverage).toEqual({ observed_days: 2, requested_days: 3 });
});
~~~

- [ ] **Step 2: Run the service test to verify it fails**

Run: `pnpm vitest run packages/server/src/mcp/health-explorer-service.test.ts`  
Expected: FAIL because `createHealthExplorerSnapshot` does not exist.

- [ ] **Step 3: Implement the smallest server-side composition service**

Extract the shared data-query portion of `get_health_trends` if necessary, then use the identical query semantics for the Explorer. Build missing-day points, average/min/max, and coverage in the service. Keep derived display values such as body lean mass on the server.

- [ ] **Step 4: Run the service test to verify it passes**

Run: `pnpm vitest run packages/server/src/mcp/health-explorer-service.test.ts`  
Expected: PASS.

- [ ] **Step 5: Write failing MCP descriptor and result tests**

~~~ts
it("marks all query and Explorer tools read-only while sync remains mutable", async () => {
  const tools = await listTools(createDofekMcpServer(context));
  expect(tools.get("get_health_trends")?.annotations).toMatchObject({ readOnlyHint: true });
  expect(tools.get("render_health_explorer")?.annotations).toMatchObject({ readOnlyHint: true });
  expect(tools.get("start_provider_sync")?.annotations?.readOnlyHint).not.toBe(true);
});
it("returns Explorer structured content and its resource URI", async () => {
  const result = await callTool("render_health_explorer", input);
  expect(result.structuredContent).toMatchObject({ range: input });
  expect(result._meta).toMatchObject({ "openai/outputTemplate": "ui://dofek/health-explorer.html" });
});
~~~

- [ ] **Step 6: Run descriptor tests to verify they fail**

Run: `pnpm vitest run packages/server/src/mcp/tools.test.ts`  
Expected: FAIL because annotations and Explorer registration are absent.

- [ ] **Step 7: Implement descriptors and `render_health_explorer`**

Confirm the installed SDK's descriptor type. Mark every current read query tool with `readOnlyHint: true`; preserve `start_provider_sync` as non-read-only. Register the Explorer with `health:read`, `healthExplorerInputSchema`, the composition service, `jsonToolResult(snapshot)`, and the current MCP Apps output-template metadata key.

- [ ] **Step 8: Run focused server validation**

Run: `pnpm vitest run packages/server/src/mcp/health-explorer-service.test.ts packages/server/src/mcp/tools.test.ts && pnpm --filter dofek-server typecheck`  
Expected: PASS.

- [ ] **Step 9: Commit**

~~~bash
git add packages/server/src/mcp/health-explorer-service.ts packages/server/src/mcp/health-explorer-service.test.ts packages/server/src/mcp/tools.ts packages/server/src/mcp/tools.test.ts
git commit -m "feat: add read-only MCP health explorer"
~~~

### Task 3: Build and register the MCP App resource

**Files:**
- Create: `packages/mcp-app/package.json`, `tsconfig.json`, `vite.config.ts`
- Create: `packages/mcp-app/src/main.tsx`, `mcp-bridge.ts`, `health-explorer.tsx`, `health-explorer.test.tsx`
- Create: `packages/server/src/mcp/app-resource.ts`, `app-resource.test.ts`
- Modify: `packages/mcp-app/package.json`, `pnpm-workspace.yaml`, root `package.json`, `pnpm-lock.yaml`, `Dockerfile`

**Interfaces:**
- Consumes `HealthExplorerSnapshot` from `@dofek/mcp-contracts`, tool structured content, and MCP Apps bridge calls.
- Produces `HealthExplorer` and `requestExplorerSnapshot(input)`.
- Produces `registerDofekAppResources(server, resourceHtml)` for `ui://dofek/health-explorer.html`.

- [ ] **Step 1: Verify and pin the current stable MCP Apps bridge dependency**

Use official MCP Apps/OpenAI documentation and the package registry. Add only the bridge package plus workspace dependencies; ECharts remains the sole charting dependency. Record the selected version in the commit or PR description.

- [ ] **Step 2: Write failing Explorer component tests**

~~~tsx
it("renders server-provided KPI values and null coverage without deriving values", () => {
  render(<HealthExplorer snapshot={fixture} onRequest={vi.fn()} />);
  expect(screen.getByText("53.5 ms")).toBeVisible();
  expect(screen.getByText("2 of 3 days observed")).toBeVisible();
});
it("sends selected filter input to the MCP bridge", async () => {
  const onRequest = vi.fn().mockResolvedValue(nextFixture);
  render(<HealthExplorer snapshot={fixture} onRequest={onRequest} />);
  await userEvent.selectOptions(screen.getByLabelText("Metric"), "resting_hr");
  expect(onRequest).toHaveBeenCalledWith(expect.objectContaining({ metrics: ["resting_hr"] }));
});
~~~

- [ ] **Step 3: Run component tests to verify they fail**

Run: `pnpm --filter dofek-mcp-app vitest run src/health-explorer.test.tsx`  
Expected: FAIL because the package and component do not exist.

- [ ] **Step 4: Implement the bridge and component**

The bridge validates incoming structured content, reads the initial tool result, and invokes only `render_health_explorer` for filter changes. Render selector controls, KPI cards, source coverage, and ECharts series from supplied values. Do not fetch Dofek endpoints, derive averages, or use medical language; surface bridge failures as explicit UI text.

- [ ] **Step 5: Run component tests to verify they pass**

Run: `pnpm --filter dofek-mcp-app vitest run src/health-explorer.test.tsx`  
Expected: PASS.

- [ ] **Step 6: Write failing MCP resource tests**

~~~ts
it("registers the Explorer with MCP App MIME type and restrictive CSP", async () => {
  const resource = await getRegisteredResource(server, "ui://dofek/health-explorer.html");
  expect(resource.mimeType).toBe("text/html;profile=mcp-app");
  expect(resource._meta?.["openai/widgetCSP"]).toEqual({
    connect_domains: [], resource_domains: [],
  });
});
~~~

- [ ] **Step 7: Run resource tests to verify they fail**

Run: `pnpm vitest run packages/server/src/mcp/app-resource.test.ts`  
Expected: FAIL because no resource is registered.

- [ ] **Step 8: Implement deterministic resource packaging and registration**

Configure Vite to output deterministic single-resource HTML. Build it before the server image, read the fixed packaged artifact in the server image, and register that exact HTML. Use MIME `text/html;profile=mcp-app`, title/description metadata, and a CSP with no direct network connections unless an officially documented asset origin is proven necessary.

- [ ] **Step 9: Run app build and resource validation**

Run: `pnpm --filter dofek-mcp-app build && pnpm vitest run packages/server/src/mcp/app-resource.test.ts && pnpm --filter dofek-server typecheck`  
Expected: PASS.

- [ ] **Step 10: Commit**

~~~bash
git add packages/mcp-app packages/server/src/mcp/app-resource.ts packages/server/src/mcp/app-resource.test.ts pnpm-workspace.yaml package.json pnpm-lock.yaml Dockerfile
git commit -m "feat: add Dofek MCP analytics explorer app"
~~~

### Task 4: Canonicalize production origin and OAuth discovery

**Files:**
- Modify: `deploy/stack.yml`, `.github/workflows/deploy.yml`, `.github/workflows/deploy-web-environment.yml`, `.github/workflows/deploy-web-stack.yml`
- Modify: `packages/server/src/routes/webhooks.ts`, `webhooks.test.ts`
- Modify: `packages/server/src/mcp/oauth-route.test.ts`

**Interfaces:**
- Consumes `PUBLIC_URL=https://dofek.fit` in production deployment entry points.
- Produces discovery metadata that names `https://dofek.fit/api/mcp` and issuer `https://dofek.fit/`.

- [ ] **Step 1: Write failing origin-default and discovery tests**

~~~ts
it("uses Dofek's canonical URL for a webhook callback fallback", () => {
  delete process.env.PUBLIC_URL;
  expect(buildCallbackUrl("test-provider")).toBe("https://dofek.fit/api/webhooks/test-provider");
});
it("publishes canonical protected-resource metadata", async () => {
  expect((await getProtectedResourceMetadata()).resource).toBe("https://dofek.fit/api/mcp");
});
~~~

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `pnpm vitest run packages/server/src/routes/webhooks.test.ts packages/server/src/mcp/oauth-route.test.ts`  
Expected: FAIL because fallbacks and production defaults name `dofek.asherlc.com`.

- [ ] **Step 3: Implement the single canonical production configuration**

Change only the primary Dofek app public URL and host defaults. Preserve separate operational hosts such as `ota` and `peerdb`, but do not preserve `dofek.asherlc.com` as an MCP/OAuth identity.

- [ ] **Step 4: Run tests and lint**

Run: `pnpm vitest run packages/server/src/routes/webhooks.test.ts packages/server/src/mcp/oauth-route.test.ts && pnpm lint`  
Expected: PASS.

- [ ] **Step 5: Deploy and verify live discovery**

Use the existing deployment workflow with `PUBLIC_URL=https://dofek.fit`, then run:

~~~bash
curl --fail-with-body https://dofek.fit/.well-known/oauth-protected-resource/api/mcp
curl --fail-with-body https://dofek.fit/.well-known/oauth-authorization-server
~~~

Expected: metadata advertises only canonical resource and issuer URLs.

- [ ] **Step 6: Commit**

~~~bash
git add deploy/stack.yml .github/workflows/deploy.yml .github/workflows/deploy-web-environment.yml .github/workflows/deploy-web-stack.yml packages/server/src/routes/webhooks.ts packages/server/src/routes/webhooks.test.ts packages/server/src/mcp/oauth-route.test.ts
git commit -m "fix: canonicalize Dofek public MCP origin"
~~~

### Task 5: Document and validate the shipped MCP App

**Files:**
- Modify: `docs/mcp.md`
- Modify: `README.md` only if its integration overview requires the canonical endpoint
- Create: `docs/mcp-app-validation.md`

**Interfaces:**
- Produces first-party client setup using exactly `https://dofek.fit/api/mcp`.
- Produces a repeatable Inspector, ChatGPT developer-mode, and Claude connector validation record.

- [ ] **Step 1: Write cited connection and capability documentation**

Document OAuth connection, tool scopes, read-only Explorer behavior, full-UI host requirements, manual setup, revocation, support, and validation commands. Cite the official OpenAI MCP App/plugin, Anthropic connector, and MCP Registry documents named in the spec.

- [ ] **Step 2: Build and run the appropriate test tier**

Run: `pnpm --filter dofek-mcp-app build && pnpm --filter dofek-server typecheck && pnpm test:changed`  
Expected: PASS.

- [ ] **Step 3: Perform manual protocol/client acceptance**

Using only the synthetic review account, verify in MCP Inspector, ChatGPT developer mode, and a Claude custom connector that OAuth is user-scoped, Explorer opens in ChatGPT, filter changes invoke the render tool, and non-UI hosts receive readable JSON text.

- [ ] **Step 4: Commit**

~~~bash
git add docs/mcp.md README.md docs/mcp-app-validation.md
git commit -m "docs: publish Dofek MCP connection guide"
~~~
