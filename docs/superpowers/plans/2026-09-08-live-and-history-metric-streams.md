# Live and Historical Metric Streams Implementation Plan

**Goal:** Route normal and initial-history metric writes through independent
Redpanda topics and sinks, while preserving the legacy drain and increasing
ClickHouse capacity for sustained ingestion.

**Architecture:** A route resolver maps an initial full provider sync to the
history route and every other producer to the live route. Each route has an
independent topic, Kafka consumer group, ClickHouse sink, and R2 archive
consumer; the old topic and sink remain intact until drained. All routes write
the same versioned ClickHouse table and processing acknowledgement table.

**Tech Stack:** TypeScript, Vitest, KafkaJS/Redpanda, ClickHouse, Docker Swarm,
Redpanda Connect, Infisical.

**Spec:** `docs/superpowers/specs/2026-09-08-live-and-history-metric-streams-design.md`

## Global Constraints

- Keep raw metric data provider-agnostic and in the canonical ClickHouse table.
- Do not move, skip, replay, or reorder legacy-topic offsets.
- Full history uses the history route; ordinary, range, and days-based syncs use
  the live route.
- Missing route configuration must fail startup with the required key name.
- New configuration keys must exist in Infisical before deployment.
- Keep delete, replacement, and processing-marker sequences ordered within a
  route; prove version resolution preserves newer live writes.
- Do not add historical rate limiting or alter client status behavior.

---

### Task 1: Define metric-stream routes and configuration

**Files:**
- Create: `src/metric-stream/routes.ts`
- Test: `src/metric-stream/routes.test.ts`

**Interfaces:**
- Consumes: `SyncJobData["targetRefreshWindow"]` from `src/jobs/queues.ts`.
- Produces: `MetricStreamRoute`, `metricStreamRouteForSyncJob`, and
  `metricStreamTopicForRoute` for publishers and service startup.

- [ ] **Step 1: Write the failing route-selection tests**

```ts
expect(metricStreamRouteForSyncJob({ type: "full" })).toBe("history");
expect(metricStreamRouteForSyncJob({ type: "days", days: 7 })).toBe("live");
expect(metricStreamRouteForSyncJob(undefined)).toBe("live");
expect(() => metricStreamTopicForRoute("live", {})).toThrow(
  "METRIC_STREAM_LIVE_TOPIC is required",
);
```

- [ ] **Step 2: Run the route test to verify it fails**

Run: `pnpm vitest src/metric-stream/routes.test.ts`

Expected: FAIL because the route module does not exist.

- [ ] **Step 3: Implement the minimal route module**

```ts
export type MetricStreamRoute = "live" | "history";

export function metricStreamRouteForSyncJob(
  targetRefreshWindow: SyncJobData["targetRefreshWindow"],
): MetricStreamRoute {
  return targetRefreshWindow?.type === "full" ? "history" : "live";
}

export function metricStreamTopicForRoute(
  route: MetricStreamRoute,
  env = process.env,
): string {
  const key = route === "live" ? "METRIC_STREAM_LIVE_TOPIC" : "METRIC_STREAM_HISTORY_TOPIC";
  const topic = env[key];
  if (!topic) throw new Error(`${key} is required`);
  return topic;
}
```

- [ ] **Step 4: Run the route test to verify it passes**

Run: `pnpm vitest src/metric-stream/routes.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the route contract**

```bash
git add src/metric-stream/routes.ts src/metric-stream/routes.test.ts
git commit -m "Add metric stream route selection"
```

### Task 2: Make publishers explicitly route-aware

**Files:**
- Modify: `src/metric-stream/redpanda-producer.ts`
- Modify: `src/metric-stream/redpanda-producer.test.ts`

**Interfaces:**
- Consumes: `MetricStreamRoute` and `metricStreamTopicForRoute` from Task 1.
- Produces: a route-specific `MetricStreamEventPublisher`; existing callers
  without a route continue to receive the live publisher.

- [ ] **Step 1: Write failing publisher tests**

```ts
const publisher = await createKafkaMetricStreamEventPublisherForRoute("history", {
  METRIC_STREAM_HISTORY_TOPIC: "metric-stream-history-v1",
  REDPANDA_BROKERS: "redpanda:9092",
});
await publisher.publishRows([metricStreamRow], { operationRevision });
expect(kafkaProducerSend).toHaveBeenCalledWith(
  expect.objectContaining({ topic: "metric-stream-history-v1" }),
);
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `pnpm vitest src/metric-stream/redpanda-producer.test.ts`

Expected: FAIL because route-specific publisher creation is absent.

- [ ] **Step 3: Implement route-specific publisher creation**

Add `createKafkaMetricStreamEventPublisherForRoute(route, env)` and cache
publishers by route, not in one global promise. Resolve each route's topic via
Task 1. Keep `getDefaultMetricStreamEventPublisher()` as the live-route
compatibility entrypoint for imports and mobile writers.

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `pnpm vitest src/metric-stream/redpanda-producer.test.ts src/processing/metric-stream-processing-publisher.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the publisher routing change**

```bash
git add src/metric-stream/redpanda-producer.ts src/metric-stream/redpanda-producer.test.ts
git commit -m "Route metric publishers by sync type"
```

### Task 3: Route provider sync jobs and retain processing evidence

**Files:**
- Modify: `src/jobs/process-sync-job.ts`
- Modify: `src/jobs/process-sync-job.test.ts`

**Interfaces:**
- Consumes: `metricStreamRouteForSyncJob(job.data.targetRefreshWindow)` from
  Task 1 and the publisher factory from Task 2.
- Produces: a `MetricStreamProcessingPublisher` backed by the selected topic;
  its existing `recordPublishedBatch` callback is unchanged.

- [ ] **Step 1: Write failing live/history sync tests**

```ts
await processSyncJob(makeJob({ targetRefreshWindow: { type: "full" } }), database);
expect(mockCreateMetricStreamEventPublisherForRoute).toHaveBeenCalledWith("history");

await processSyncJob(makeJob({ targetRefreshWindow: { type: "days", days: 7 } }), database);
expect(mockCreateMetricStreamEventPublisherForRoute).toHaveBeenCalledWith("live");
```

Keep the current assertion that the published batch is recorded in the
processing event store; route selection must not bypass acknowledgement
tracking.

- [ ] **Step 2: Run the process-sync unit test to verify it fails**

Run: `pnpm vitest src/jobs/process-sync-job.test.ts`

Expected: FAIL because `processSyncJob` still calls the default publisher.

- [ ] **Step 3: Implement the minimal selection at publisher construction**

Replace `createLazyDefaultMetricStreamEventPublisher()` in the provider-sync
path with the Task 2 factory using the route derived from `job.data`. Do not
change provider APIs, checkpointing, queue concurrency, operation IDs, or
batch-recording semantics.

- [ ] **Step 4: Run the process-sync unit test to verify it passes**

Run: `pnpm vitest src/jobs/process-sync-job.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit provider-sync routing**

```bash
git add src/jobs/process-sync-job.ts src/jobs/process-sync-job.test.ts
git commit -m "Route full provider syncs to history stream"
```

### Task 4: Parameterize consumer groups and prove newer live writes win

**Files:**
- Modify: `src/metric-stream/redpanda-consumer.ts`
- Modify: `src/metric-stream/redpanda-consumer.test.ts`
- Modify: `src/metric-stream/clickhouse-sink.ts`
- Modify: `src/metric-stream/clickhouse-sink.test.ts`
- Modify: `src/metric-stream/clickhouse-sink.integration.test.ts`

**Interfaces:**
- Consumes: required `METRIC_STREAM_TOPIC` and `METRIC_STREAM_CONSUMER_GROUP`
  for each sink service.
- Produces: independent route consumers that preserve existing sink behavior and
  correctly resolve an older late history write below a newer live revision.

- [ ] **Step 1: Write failing configuration and integration tests**

```ts
expect(() => createKafkaMetricStreamConsumerFromEnv({
  METRIC_STREAM_CONSUMER_GROUP: "history-sink",
  REDPANDA_BROKERS: "redpanda:9092",
})).toThrow(
  "METRIC_STREAM_TOPIC is required",
);

await applyMetricStreamEventsToClickHouse(client, [historyReplacement]);
await applyMetricStreamEventsToClickHouse(client, [liveReplacement]);
await applyMetricStreamEventsToClickHouse(client, [lateHistoryReplacement]);
expect(await currentRow(client, eventId)).toMatchObject({ scalar: 75, version: liveVersion });
```

The integration fixture uses the same metric identity, an older history
operation revision, and a newer live operation revision; it never uses a mock
to simulate ClickHouse version resolution.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `pnpm vitest src/metric-stream/redpanda-consumer.test.ts src/metric-stream/clickhouse-sink.test.ts && pnpm test:integration -- src/metric-stream/clickhouse-sink.integration.test.ts`

Expected: unit tests fail for the new required consumer configuration; the
integration case fails until the intended version-ordering behavior is covered.

- [ ] **Step 3: Implement explicit consumer identity and preserve sink logic**

Pass a consumer-group identifier into `createKafkaMetricStreamConsumerFromEnv`
instead of hard-coding it in the sink startup path. Read the group from
`METRIC_STREAM_CONSUMER_GROUP`, fail loudly when absent, and leave parsing,
quarantine, acknowledgement insertion, heartbeats, and offset commits intact.

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `pnpm vitest src/metric-stream/redpanda-consumer.test.ts src/metric-stream/clickhouse-sink.test.ts && pnpm test:integration -- src/metric-stream/clickhouse-sink.integration.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the consumer isolation change**

```bash
git add src/metric-stream/redpanda-consumer.ts src/metric-stream/redpanda-consumer.test.ts src/metric-stream/clickhouse-sink.ts src/metric-stream/clickhouse-sink.test.ts src/metric-stream/clickhouse-sink.integration.test.ts
git commit -m "Isolate metric stream sink consumers"
```

### Task 5: Deploy legacy, live, and history routes with sufficient capacity

**Files:**
- Modify: `deploy/stack.yml`
- Modify: `deploy/redpanda/metric-stream-r2-archive.connect.yml` only if it
  cannot receive one topic through `METRIC_STREAM_TOPIC`
- Modify: `.github/templates/infisical-dotenv.tmpl`
- Modify: `scripts/render-deploy-service-env.ts`
- Modify: `scripts/deploy-service-environment.test.ts`
- Modify: `deploy/README.md`
- Modify: `docs/metric-stream-redpanda-r2-runbook.md`

**Interfaces:**
- Consumes: `METRIC_STREAM_LIVE_TOPIC`, `METRIC_STREAM_HISTORY_TOPIC`, and
  existing `METRIC_STREAM_TOPIC` legacy configuration.
- Produces: one legacy sink/archive pair, one live sink/archive pair, one
  history sink/archive pair, and a ClickHouse service limited to `cpus: "1.5"`.

- [ ] **Step 1: Write failing deployment-environment tests**

```ts
expect(rendered["metric-stream-live-clickhouse-sink"])
  .toContain("METRIC_STREAM_TOPIC=metric-stream-live-v1");
expect(rendered["metric-stream-history-clickhouse-sink"])
  .toContain("METRIC_STREAM_TOPIC=metric-stream-history-v1");
expect(rendered["metric-stream-clickhouse-sink"])
  .toContain("METRIC_STREAM_TOPIC=metric-stream-v1");
```

Also assert that every sink receives a distinct `METRIC_STREAM_CONSUMER_GROUP`.

- [ ] **Step 2: Run deployment-environment tests to verify they fail**

Run: `pnpm vitest scripts/deploy-service-environment.test.ts`

Expected: FAIL because only the legacy service and one topic are rendered.

- [ ] **Step 3: Implement the stack and environment changes**

Keep `metric-stream-clickhouse-sink` as the legacy consumer with its current
topic/group. Add live and history sink services using the same image and
command, but their route-specific topic/group environment. Add matching R2
archive services, each with its own consumer group and the existing archive
configuration. Increase the ClickHouse Swarm CPU limit from `"1"` to `"1.5"`.
Update the environment renderer/template allowlist so every required key is
passed only to the producer, sink, and archive services that need it.

- [ ] **Step 4: Update Infisical before deployment**

Create `METRIC_STREAM_LIVE_TOPIC=metric-stream-live-v1` and
`METRIC_STREAM_HISTORY_TOPIC=metric-stream-history-v1` in the relevant
environments. Redirect command output away from logs, then perform a
names-only export check; never print secret values.

- [ ] **Step 5: Run static deployment verification**

Run: `pnpm vitest scripts/deploy-service-environment.test.ts && pnpm lint && pnpm typecheck`

Expected: PASS.

- [ ] **Step 6: Commit deployment configuration and runbook**

```bash
git add deploy/stack.yml deploy/redpanda/metric-stream-r2-archive.connect.yml .github/templates/infisical-dotenv.tmpl scripts/render-deploy-service-env.ts scripts/deploy-service-environment.test.ts deploy/README.md docs/metric-stream-redpanda-r2-runbook.md
git commit -m "Separate live and history metric stream routes"
```

### Task 6: Roll out and verify recovery in production

**Files:**
- Modify: `docs/production-incident-baseline.md`

**Interfaces:**
- Consumes: deployed routes from Task 5 and production processing status.
- Produces: recorded evidence that live readiness no longer waits for the
  legacy backlog, plus the legacy-drain status.

- [ ] **Step 1: Deploy through the normal CI release workflow**

Run the repository's normal deploy workflow; do not manually alter Redpanda
offsets or Docker service environments on the host.

- [ ] **Step 2: Verify service readiness and each consumer group**

Run:

```bash
ssh dofek-server 'docker service ps dofek_metric-stream-clickhouse-sink --no-trunc; docker service ps dofek_metric-stream-live-clickhouse-sink --no-trunc; docker service ps dofek_metric-stream-history-clickhouse-sink --no-trunc'
ssh dofek-server 'docker exec "$(docker ps -q --filter name=dofek_redpanda | head -n1)" rpk group describe metric-stream-clickhouse-sink metric-stream-live-clickhouse-sink metric-stream-history-clickhouse-sink'
```

Expected: all services have one running task; each group reports its assigned
topic, and the legacy group remains present.

- [ ] **Step 3: Verify a fresh live processing operation reaches ready**

Trigger one bounded non-full provider sync, record its processing operation ID,
then use the processing-status runbook queries to verify its exact batch
acknowledgement and final ready event. Confirm the legacy consumer still
advances independently.

- [ ] **Step 4: Verify archive freshness for both new routes**

Inspect the live and history archive consumer lags and newest route-specific R2
object timestamps. Both must advance without archive write errors.

- [ ] **Step 5: Record final incident outcome and commit**

Append the deployment timestamp, pre/post consumer lag, live-operation ready
evidence, and any remaining legacy backlog to
`docs/production-incident-baseline.md`.

```bash
git add docs/production-incident-baseline.md
git commit -m "Record metric stream recovery verification"
```
