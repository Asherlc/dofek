import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { type Admin, Kafka, logLevel, type Producer } from "kafkajs";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  eraseClickHouseAccount,
  fenceClickHouseAccount,
  prepareClickHouseAccountErasure,
} from "../account-erasure/clickhouse-erasure.ts";
import { AccountErasureIdentifierStore } from "../account-erasure/identifier-store.ts";
import {
  ANALYTICS_PUBLICATION_RESOURCE,
  withAnalyticsQueryOwner,
} from "../analytics/analytics-query-owner.ts";
import { initiateAccountErasure } from "../db/account-erasure.ts";
import { claimAccountErasureRequest } from "../db/account-erasure-processing.ts";
import { createClickHouseClientFromEnv } from "../db/clickhouse.ts";
import { buildClickHouseBootstrapStatementsForNativeMetricStream } from "../db/clickhouse-metric-stream-bootstrap.ts";
import {
  createTestBarrier,
  hasDatabaseLockWaiter,
  setupTestDatabase,
  type TestContext,
} from "../db/test-helpers.ts";
import { startPublicationSink } from "./clickhouse-sink-publication-test-helpers.ts";
import {
  METRIC_STREAM_PROCESSING_ACKNOWLEDGEMENT_TABLE,
  METRIC_STREAM_TABLE,
} from "./clickhouse-table.ts";
import { createMetricStreamBatchCompletedEvent, createMetricStreamEvent } from "./events.ts";

describe("production ClickHouse sink publication boundary", () => {
  let client: ReturnType<typeof createClickHouseClientFromEnv>;
  let clickHouse: StartedTestContainer | undefined;
  const topic = `erasure-publication-${randomUUID()}`;
  const groupId = `erasure-publication-${randomUUID()}`;
  const userId = randomUUID(),
    survivor = randomUUID(),
    operationId = randomUUID();
  let context: TestContext;
  let admin: Admin, producer: Producer;

  beforeAll(async () => {
    const configured = createClickHouseClientFromEnv();
    let version: string;
    try {
      const rows = await (
        await configured.query<{ version: string }>({
          query: "SELECT version() AS version",
          format: "JSONEachRow",
        })
      ).json();
      version = rows[0]?.version ?? "";
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(version))
        throw new Error("ClickHouse fixture requires an exact server version");
    } finally {
      await configured.close?.();
    }
    clickHouse = await new GenericContainer(`clickhouse/clickhouse-server:${version}-alpine`)
      .withEnvironment({ CLICKHOUSE_USER: "default", CLICKHOUSE_PASSWORD: "health" })
      .withExposedPorts(8123)
      .withResourcesQuota({ memory: 1536 * 1024 * 1024 })
      .withBindMounts(
        [
          ["users.d/default-query-guardrails.xml", "users.d/default-query-guardrails.xml"],
          ["config.d/memory-limits.xml", "config.d/memory-limits.xml"],
          ["config.d/system-log-ttl.xml", "config.d/system-log-ttl.xml"],
        ].map(([source, target]) => ({
          source: fileURLToPath(new URL(`../../deploy/clickhouse/${source}`, import.meta.url)),
          target: `/etc/clickhouse-server/${target}`,
          mode: "ro" as const,
        })),
      )
      .withWaitStrategy(Wait.forHttp("/ping", 8123).forStatusCode(200))
      .start();
    vi.stubEnv(
      "CLICKHOUSE_URL",
      `http://default:health@${clickHouse.getHost()}:${clickHouse.getMappedPort(8123)}`,
    );
    client = createClickHouseClientFromEnv();
    context = await setupTestDatabase();
    const brokers = process.env.REDPANDA_BROKERS?.split(",");
    if (!brokers?.length)
      throw new Error("REDPANDA_BROKERS is required for sink publication tests");
    const kafka = new Kafka({
      brokers,
      clientId: "erasure-publication-fixture",
      logLevel: logLevel.ERROR,
    });
    admin = kafka.admin();
    producer = kafka.producer();
    await admin.connect();
    await admin.createTopics({
      topics: [{ topic, numPartitions: 1, replicationFactor: 1 }],
      waitForLeaders: true,
    });
    await producer.connect();
    for (const query of buildClickHouseBootstrapStatementsForNativeMetricStream(""))
      await client.command({ query, clickhouse_settings: { log_queries: 0 } });
    for (const table of [METRIC_STREAM_TABLE, METRIC_STREAM_PROCESSING_ACKNOWLEDGEMENT_TABLE])
      await client.command({
        query: `ALTER TABLE ${table} MODIFY SETTING old_parts_lifetime=1,cleanup_delay_period=1,cleanup_delay_period_random_add=0,max_cleanup_delay_period=1`,
      });
    await context.db.execute(sql`INSERT INTO fitness.user_profile(id,name) VALUES
      (${userId}::uuid,'Publication target'),(${survivor}::uuid,'Publication survivor')`);
    await context.db.execute(sql`INSERT INTO fitness.processing_operation(id,user_id,kind,dataset_keys)
      VALUES (${operationId}::uuid,${userId}::uuid,'provider_sync',ARRAY['heart_rate'])`);
  }, 120000);

  afterAll(async () => {
    try {
      await producer?.disconnect();
      if (admin) await admin.deleteTopics({ topics: [topic, `${topic}.quarantine.v1`] });
    } finally {
      try {
        await Promise.all([
          admin?.disconnect(),
          client?.close?.(),
          context?.cleanup(),
          clickHouse?.stop(),
        ]);
      } finally {
        vi.unstubAllEnvs();
      }
    }
  });

  async function committedOffset() {
    const offsets = await admin.fetchOffsets({ groupId, topics: [topic] });
    return BigInt(offsets[0]?.partitions[0]?.offset ?? "-1");
  }
  async function count(table: string, field: string, value: string) {
    const rows = await (
      await client.query<{ count: string }>({
        query: `SELECT count() AS count FROM ${table} FINAL WHERE ${field}={id:UUID}`,
        query_params: { id: value },
        format: "JSONEachRow",
      })
    ).json();
    return Number(rows[0]?.count);
  }
  const row = (owner: string, instant: string) =>
    createMetricStreamEvent(
      {
        userId: owner,
        recordedAt: instant,
        providerId: "publication-fixture",
        externalId: instant,
        sourceType: "api",
        channel: "heart_rate",
        scalar: 70,
      },
      "1000000000000000",
    );
  const marker = () =>
    createMetricStreamBatchCompletedEvent(
      {
        operationId,
        batchId: randomUUID(),
        datasetKeys: ["heart_rate"],
      },
      2,
    );

  it("serializes the actual callback with erasure and consumer replacement before committing offsets", async () => {
    const sink = startPublicationSink({
      connectionString: context.connectionString,
      topic,
      groupId,
      holdFence: true,
    });
    let replacement: ReturnType<typeof startPublicationSink> | undefined;
    try {
      await sink.started;
      await producer.send({
        topic,
        messages: [
          row(userId, "2026-11-01T01:00:00Z"),
          row(survivor, "2026-11-01T01:00:00Z"),
          marker(),
        ].map((event) => ({ value: JSON.stringify(event) })),
        acks: -1,
      });
      await sink.fenceRead;
      const priorOwner =
        await context.db.execute(sql`SELECT quiescent FROM fitness.analytics_query_owner
        WHERE resource_id=${ANALYTICS_PUBLICATION_RESOURCE}`);
      const sinkOwnsPublication = priorOwner[0]?.quiescent === false;
      const accepted = await initiateAccountErasure(
        context.db,
        userId,
        async () => "retained-fixture",
        async () => undefined,
      );
      const leaseOwner = randomUUID();
      await claimAccountErasureRequest(context.db, accepted.requestId, leaseOwner, 300000);
      const store = new AccountErasureIdentifierStore(context.db, {
        requestId: accepted.requestId,
        leaseOwner,
        pageSize: 500,
      });
      const erased = withAnalyticsQueryOwner(
        context.db,
        client,
        {
          resourceId: ANALYTICS_PUBLICATION_RESOURCE,
          intentId: `account-erasure:${accepted.requestId}`,
        },
        async (owner) => {
          await fenceClickHouseAccount(owner.client, userId, [operationId]);
          const input = { userId, stage: "initial" as const };
          const options = {
            managedDatabases: ["ingest"],
            physicalPartPollIntervalMilliseconds: 25,
            physicalPartWaitTimeoutMilliseconds: 45000,
          };
          await prepareClickHouseAccountErasure(owner, store, input, options);
          await eraseClickHouseAccount(owner, store, input, options);
        },
      ).then(
        () => null,
        (error: unknown) => error,
      );
      try {
        if (sinkOwnsPublication)
          await vi.waitFor(async () => expect(await hasDatabaseLockWaiter(context.db)).toBe(true), {
            timeout: 10000,
          });
        else expect(await erased).toBeNull();
        expect(await committedOffset()).toBeLessThan(3n);
        expect(
          await count(METRIC_STREAM_PROCESSING_ACKNOWLEDGEMENT_TABLE, "operation_id", operationId),
        ).toBe(0);
      } finally {
        sink.releaseFence();
      }
      expect(await erased).toBeNull();
      await vi.waitFor(async () => expect(await committedOffset()).toBe(3n), { timeout: 10000 });
      expect(await count(METRIC_STREAM_TABLE, "user_id", userId)).toBe(0);
      expect(await count(METRIC_STREAM_TABLE, "user_id", survivor)).toBe(1);
      expect(
        await count(METRIC_STREAM_PROCESSING_ACKNOWLEDGEMENT_TABLE, "operation_id", operationId),
      ).toBe(0);
      await sink.stop();

      const admitted = createTestBarrier(),
        release = createTestBarrier();
      const held = withAnalyticsQueryOwner(
        context.db,
        client,
        {
          resourceId: ANALYTICS_PUBLICATION_RESOURCE,
          intentId: `account-erasure:${accepted.requestId}`,
        },
        async () => {
          admitted.resolve();
          await release.promise;
        },
      );
      await admitted.promise;
      try {
        replacement = startPublicationSink({
          connectionString: context.connectionString,
          topic,
          groupId,
          holdFence: false,
        });
        await replacement.started;
        await producer.send({
          topic,
          messages: [
            row(userId, "2026-11-01T02:00:00Z"),
            row(survivor, "2026-11-01T02:00:00Z"),
            marker(),
          ].map((event) => ({ value: JSON.stringify(event) })),
          acks: -1,
        });
        await vi.waitFor(async () => expect(await hasDatabaseLockWaiter(context.db)).toBe(true), {
          timeout: 10000,
        });
        expect(await committedOffset()).toBe(3n);
      } finally {
        release.resolve();
        await held;
      }
      await vi.waitFor(async () => expect(await committedOffset()).toBe(6n), { timeout: 10000 });
      expect(await count(METRIC_STREAM_TABLE, "user_id", userId)).toBe(0);
      expect(await count(METRIC_STREAM_TABLE, "user_id", survivor)).toBe(2);
      expect(
        await count(METRIC_STREAM_PROCESSING_ACKNOWLEDGEMENT_TABLE, "operation_id", operationId),
      ).toBe(0);
    } finally {
      sink.releaseFence();
      await sink.stop();
      await replacement?.stop();
    }
  }, 120000);
});
