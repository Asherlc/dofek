import { randomUUID } from "node:crypto";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createClickHouseClientFromEnv } from "../../../../src/db/clickhouse.ts";
import { buildClickHouseBootstrapStatementsForNativeMetricStream } from "../../../../src/db/clickhouse-metric-stream-bootstrap.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { deleteProviderAuthorization } from "../../../../src/db/tokens.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import type { BodyClickHouseStore } from "./body-clickhouse.ts";
import {
  type MetricStreamSeedRow,
  seedMetricStreamRows,
} from "./metric-stream-integration-test-helpers.ts";
import { ProviderDetailRepository } from "./provider-detail-repository.ts";

// metricStream reads only touch ClickHouse; the repository still requires a
// Postgres Database to construct, but it is never queried by these tests.
const noopDb: Pick<Database, "execute" | "transaction"> = {
  execute: vi.fn(async () => []),
  transaction: vi.fn(),
};

const testUserId = "00000000-0000-0000-0000-0000000000b2";

const client = createClickHouseClientFromEnv();

// The repository only needs a ClickHouse query runner (BodyClickHouseStore shape).
const clickHouse: BodyClickHouseStore = {
  async query(schema, query, params) {
    if (!client.query) throw new Error("ClickHouse client must support query");
    const result = await client.query({ query, query_params: params, format: "JSONEachRow" });
    const rows = await result.json();
    return rows.map((row) => schema.parse(row));
  },
};

const noRetainedMetricStream: BodyClickHouseStore = {
  async query(schema) {
    return [schema.parse({ has_data: 0 })];
  },
};

async function seed(rows: MetricStreamSeedRow[]): Promise<void> {
  await seedMetricStreamRows(client, testUserId, rows);
}

const rowSchema = z.object({
  id: z.string(),
  recorded_at: z.string(),
  provider_id: z.string(),
  channel: z.string(),
  scalar: z.number().nullable(),
});

const countSchema = z.object({ count: z.coerce.number() });

describe("ProviderDetailRepository metric stream (integration)", () => {
  const supersededId = "11111111-1111-4111-8111-111111111111";
  const tiedVersionTombstonedId = "33333333-3333-4333-8333-333333333333";

  beforeAll(async () => {
    for (const statement of buildClickHouseBootstrapStatementsForNativeMetricStream("")) {
      await client.command({ query: statement });
    }
    await client.command({
      query: `ALTER TABLE ingest.metric_stream
        DELETE WHERE user_id = {userId:UUID}
        SETTINGS mutations_sync = 1`,
      query_params: { userId: testUserId },
    });
    await seed([
      {
        id: randomUUID(),
        recorded_at: "2026-04-12 10:00:00.000",
        provider_id: "withings",
        channel: "heart_rate",
        scalar: 60,
        is_deleted: 0,
        version: 0,
      },
      {
        id: randomUUID(),
        recorded_at: "2026-04-12 10:05:00.000",
        provider_id: "withings",
        channel: "body_weight",
        scalar: 80,
        is_deleted: 0,
        version: 0,
      },
      // version dedup: v1 (90) supersedes v0 (50)
      {
        id: supersededId,
        recorded_at: "2026-04-12 10:10:00.000",
        provider_id: "withings",
        channel: "body_weight",
        scalar: 50,
        is_deleted: 0,
        version: 0,
      },
      {
        id: supersededId,
        recorded_at: "2026-04-12 10:10:00.000",
        provider_id: "withings",
        channel: "body_weight",
        scalar: 90,
        is_deleted: 0,
        version: 1,
      },
      // excluded: deleted + other provider
      {
        id: randomUUID(),
        recorded_at: "2026-04-12 10:15:00.000",
        provider_id: "withings",
        channel: "heart_rate",
        scalar: 70,
        is_deleted: 1,
        version: 1,
      },
      {
        id: randomUUID(),
        recorded_at: "2026-04-12 10:20:00.000",
        provider_id: "fitbit",
        channel: "heart_rate",
        scalar: 65,
        is_deleted: 0,
        version: 0,
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        recorded_at: "2026-04-12 10:25:00.000",
        provider_id: "tombstoned-provider",
        channel: "heart_rate",
        scalar: 65,
        is_deleted: 0,
        version: 0,
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        recorded_at: "2026-04-12 10:25:00.000",
        provider_id: "tombstoned-provider",
        channel: "heart_rate",
        scalar: 65,
        is_deleted: 1,
        version: 1,
      },
      {
        id: tiedVersionTombstonedId,
        recorded_at: "2026-04-12 10:30:00.000",
        provider_id: "tied-version-tombstoned-provider",
        channel: "heart_rate",
        scalar: 65,
        is_deleted: 0,
        ingested_at: "2026-04-12 10:31:00.000",
        version: 1,
      },
      {
        id: tiedVersionTombstonedId,
        recorded_at: "2026-04-12 10:30:00.000",
        provider_id: "tied-version-tombstoned-provider",
        channel: "heart_rate",
        scalar: 65,
        is_deleted: 1,
        ingested_at: "2026-04-12 10:32:00.000",
        version: 1,
      },
    ]);
  }, 120_000);

  afterAll(async () => {
    await client.command({
      query: `ALTER TABLE ingest.metric_stream
        DELETE WHERE user_id = {userId:UUID}
        SETTINGS mutations_sync = 1`,
      query_params: { userId: testUserId },
    });
    await client.close?.();
  });

  it("returns a provider's metric-stream rows, version-deduped, newest first", async () => {
    const repo = new ProviderDetailRepository(noopDb, testUserId, clickHouse);

    const rows = (await repo.getRecords("withings", "metricStream", 50, 0)).map((row) =>
      rowSchema.parse(row),
    );

    // withings only, deleted excluded, superseded version dedup -> 90 (not 50), newest first
    expect(rows).toEqual([
      {
        id: supersededId,
        recorded_at: "2026-04-12T10:10:00.000000Z",
        provider_id: "withings",
        channel: "body_weight",
        scalar: 90,
      },
      {
        id: expect.any(String),
        recorded_at: "2026-04-12T10:05:00.000000Z",
        provider_id: "withings",
        channel: "body_weight",
        scalar: 80,
      },
      {
        id: expect.any(String),
        recorded_at: "2026-04-12T10:00:00.000000Z",
        provider_id: "withings",
        channel: "heart_rate",
        scalar: 60,
      },
    ]);
    expect(rows.some((row) => row.provider_id === "fitbit")).toBe(false);
  });

  it("returns a single record by id", async () => {
    const repo = new ProviderDetailRepository(noopDb, testUserId, clickHouse);
    const detail = await repo.getRecordDetail("withings", "metricStream", supersededId);
    expect(detail).toMatchObject({ id: supersededId, scalar: 90, channel: "body_weight" });
  });

  it("uses only active deduplicated metric-stream rows as retained ownership evidence", async () => {
    const repository = new ProviderDetailRepository(noopDb, testUserId, clickHouse);

    await expect(repository.canDeleteProviderData("withings")).resolves.toBe(true);
    await expect(repository.canDeleteProviderData("tombstoned-provider")).resolves.toBe(false);
    await expect(
      repository.canDeleteProviderData("tied-version-tombstoned-provider"),
    ).resolves.toBe(false);
    await expect(repository.canDeleteProviderData("fitbit")).resolves.toBe(true);
  });
});

describe("ProviderDetailRepository provider data deletion (integration)", () => {
  const userId = "00000000-0000-4000-8000-0000000000b3";
  const secondUserId = "00000000-0000-4000-8000-0000000000b4";
  const providerId = "provider-delete-integration";
  const retainedProviderId = "provider-disconnect-retained-integration";
  let testContext: TestContext;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    await testContext.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name)
          VALUES
            (${userId}, 'Provider Delete Integration User'),
            (${secondUserId}, 'Second Provider Delete Integration User')
          ON CONFLICT (id) DO NOTHING`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES
            (${providerId}, 'Provider Delete Integration', ${userId}),
            (${retainedProviderId}, 'Provider Disconnect Retained Integration', ${userId})`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.provider_connection (user_id, provider_id)
          VALUES
            (${userId}, ${providerId}),
            (${secondUserId}, ${providerId}),
            (${userId}, ${retainedProviderId})`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.oauth_token (provider_id, user_id, access_token, expires_at)
          VALUES
            (${providerId}, ${userId}, 'encrypted-test-token', now() + interval '1 hour'),
            (${providerId}, ${secondUserId}, 'encrypted-second-token', now() + interval '1 hour'),
            (${retainedProviderId}, ${userId}, 'encrypted-retained-token', now() + interval '1 hour')`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.activity
            (provider_id, user_id, external_id, activity_type, started_at)
          VALUES
            (${providerId}, ${userId}, 'activity-1', 'running', now()),
            (${providerId}, ${secondUserId}, 'activity-2', 'cycling', now()),
            (${retainedProviderId}, ${userId}, 'retained-activity', 'running', now())`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.daily_metrics (provider_id, user_id, date)
          VALUES (${providerId}, ${userId}, '2026-07-17')`,
    );
  }, 120_000);

  afterAll(async () => {
    await testContext?.cleanup();
  });

  it("deletes one user's records while preserving both users' connections and tokens", async () => {
    const repository = new ProviderDetailRepository(testContext.db, userId);

    const request = await repository.requestProviderDataDeletion(providerId);

    expect(request).toMatchObject({
      generation: 1,
      providerId,
      userId,
    });

    const countSchema = z.object({ count: z.coerce.number() });
    const [activityCount] = await executeWithSchema(
      testContext.db,
      countSchema,
      sql`SELECT count(*) AS count FROM fitness.activity
          WHERE provider_id = ${providerId} AND user_id = ${userId}`,
    );
    const [dailyMetricsCount] = await executeWithSchema(
      testContext.db,
      countSchema,
      sql`SELECT count(*) AS count FROM fitness.daily_metrics
          WHERE provider_id = ${providerId} AND user_id = ${userId}`,
    );
    const [tokenCount] = await executeWithSchema(
      testContext.db,
      countSchema,
      sql`SELECT count(*) AS count FROM fitness.oauth_token
          WHERE provider_id = ${providerId} AND user_id = ${userId}`,
    );
    const [secondUserActivityCount] = await executeWithSchema(
      testContext.db,
      countSchema,
      sql`SELECT count(*) AS count FROM fitness.activity
          WHERE provider_id = ${providerId} AND user_id = ${secondUserId}`,
    );
    const [connectionCount] = await executeWithSchema(
      testContext.db,
      countSchema,
      sql`SELECT count(*) AS count FROM fitness.provider_connection
          WHERE provider_id = ${providerId}`,
    );
    const [allTokenCount] = await executeWithSchema(
      testContext.db,
      countSchema,
      sql`SELECT count(*) AS count FROM fitness.oauth_token
          WHERE provider_id = ${providerId}`,
    );

    expect(activityCount?.count).toBe(0);
    expect(dailyMetricsCount?.count).toBe(0);
    expect(tokenCount?.count).toBe(1);
    expect(secondUserActivityCount?.count).toBe(1);
    expect(connectionCount?.count).toBe(2);
    expect(allTokenCount?.count).toBe(2);
  });

  it("authorizes canonical deletion from retained rows after disconnect and emits its outbox event", async () => {
    await deleteProviderAuthorization(testContext.db, retainedProviderId, userId);
    const repository = new ProviderDetailRepository(testContext.db, userId, noRetainedMetricStream);

    await expect(repository.canDeleteProviderData(retainedProviderId)).resolves.toBe(true);
    const request = await repository.requestProviderDataDeletion(retainedProviderId);

    const [connectionCount] = await executeWithSchema(
      testContext.db,
      countSchema,
      sql`SELECT count(*) AS count
          FROM fitness.provider_connection
          WHERE user_id = ${userId} AND provider_id = ${retainedProviderId}`,
    );
    const [activityCount] = await executeWithSchema(
      testContext.db,
      countSchema,
      sql`SELECT count(*) AS count
          FROM fitness.activity
          WHERE user_id = ${userId} AND provider_id = ${retainedProviderId}`,
    );
    const [outboxCount] = await executeWithSchema(
      testContext.db,
      countSchema,
      sql`SELECT count(*) AS count
          FROM fitness.provider_data_deletion_outbox
          WHERE event_id = ${request.eventId}
            AND user_id = ${userId}
            AND provider_id = ${retainedProviderId}`,
    );

    expect(connectionCount?.count).toBe(0);
    expect(activityCount?.count).toBe(0);
    expect(outboxCount?.count).toBe(1);
  });

  it("does not authorize another user from someone else's retained records", async () => {
    const repository = new ProviderDetailRepository(
      testContext.db,
      secondUserId,
      noRetainedMetricStream,
    );

    await expect(repository.canDeleteProviderData(retainedProviderId)).resolves.toBe(false);
  });

  it("fails with the missing-table error before writing another outbox event", async () => {
    await testContext.db.execute(
      sql`ALTER TABLE fitness.daily_metrics RENAME TO daily_metrics_unavailable`,
    );
    try {
      const repository = new ProviderDetailRepository(testContext.db, userId);

      await expect(repository.requestProviderDataDeletion(providerId)).rejects.toMatchObject({
        cause: { code: "42P01" },
      });

      const [outboxCount] = await executeWithSchema(
        testContext.db,
        z.object({ count: z.coerce.number() }),
        sql`SELECT count(*) AS count
            FROM fitness.provider_data_deletion_outbox
            WHERE provider_id = ${providerId} AND user_id = ${userId}`,
      );
      expect(outboxCount?.count).toBe(1);
    } finally {
      await testContext.db.execute(
        sql`ALTER TABLE fitness.daily_metrics_unavailable RENAME TO daily_metrics`,
      );
    }
  });
});
