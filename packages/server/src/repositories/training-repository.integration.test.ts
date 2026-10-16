import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ClickHouseActivitySensorStore } from "./clickhouse-activity-sensor-store.ts";
import { TrainingRepository } from "./training-repository.ts";

describe("TrainingRepository heart-rate distribution serving", () => {
  const database = `training_zones_${randomUUID().replaceAll("-", "")}`;
  const userId = randomUUID();
  const activityId = randomUUID();
  const clickhouse = createClient({ url: process.env.CLICKHOUSE_URL });
  let postgres: TestContext;
  let repository: TrainingRepository;

  beforeAll(async () => {
    postgres = await setupTestDatabase();
    await postgres.db.execute(sql`
      INSERT INTO fitness.user_profile (id, name) VALUES (${userId}::uuid, 'Training fixture')
    `);
    await postgres.db.execute(sql`
      INSERT INTO fitness.provider (id, name, user_id) VALUES ('training-fixture', 'Training fixture', ${userId}::uuid)
    `);
    await postgres.db.execute(sql`
      INSERT INTO fitness.activity (id, group_id, provider_id, user_id, external_id,
        canonical_type, provider_type, started_at, ended_at)
      VALUES (${activityId}::uuid, ${activityId}::uuid, 'training-fixture', ${userId}::uuid, 'activity',
        'cycling', 'cycling', CURRENT_TIMESTAMP - INTERVAL '1 hour', CURRENT_TIMESTAMP);
    `);
    await clickhouse.command({ query: `CREATE DATABASE ${database}` });
    for (const [name, columns, key] of [
      [
        "activity_summary",
        "activity_id UUID, user_id UUID, started_at DateTime64(6,'UTC'), ended_at Nullable(DateTime64(6,'UTC')), canonical_type String",
        "user_id, activity_id",
      ],
      [
        "deduped_activities",
        "activity_id UUID, user_id UUID, is_deleted UInt8",
        "user_id, activity_id",
      ],
      ["user_profile_current", "id UUID, max_hr Float64, resting_hr Float64", "id"],
      [
        "resting_heart_rate_sleep_window",
        "user_id UUID, ended_at Nullable(DateTime64(6,'UTC')), resting_hr Nullable(Float64), duration_seconds Float64, is_deleted UInt8",
        "user_id",
      ],
      [
        "deduped_sensor",
        "user_id UUID, recorded_at DateTime64(6,'UTC'), channel String, scalar Nullable(Float64), is_deleted UInt8",
        "user_id, channel, recorded_at",
      ],
      [
        "activity_heart_rate_distribution",
        "user_id UUID, activity_id UUID, samples Array(Tuple(Float64,UInt64)), is_deleted UInt8",
        "user_id, activity_id",
      ],
    ]) {
      await clickhouse.command({
        query: `CREATE TABLE ${database}.${name} (${columns}, refresh_version UInt64 DEFAULT 1)
          ENGINE=ReplacingMergeTree(refresh_version) ORDER BY (${key})`,
      });
    }
    await clickhouse.command({
      query: `INSERT INTO ${database}.activity_summary (activity_id,user_id,started_at,ended_at,canonical_type)
        SELECT {activityId:UUID},{userId:UUID},today(),today()+INTERVAL 1 HOUR,'cycling'`,
      query_params: { activityId, userId },
    });
    await clickhouse.insert({
      table: `${database}.deduped_activities`,
      format: "JSONEachRow",
      values: [{ activity_id: activityId, user_id: userId, is_deleted: 0 }],
    });
    await clickhouse.insert({
      table: `${database}.user_profile_current`,
      format: "JSONEachRow",
      values: [{ id: userId, max_hr: 200, resting_hr: 60 }],
    });
    await clickhouse.command({
      query: `INSERT INTO ${database}.resting_heart_rate_sleep_window
        (user_id,ended_at,resting_hr,duration_seconds,is_deleted)
        SELECT {userId:UUID},today(),60,28800,0`,
      query_params: { userId },
    });
    await clickhouse.insert({
      table: `${database}.activity_heart_rate_distribution`,
      format: "JSONEachRow",
      values: [
        {
          user_id: userId,
          activity_id: activityId,
          samples: [
            [129.5, 2],
            [130, 3],
            [144, 4],
            [158, 5],
            [172, 6],
            [186, 7],
          ],
          is_deleted: 0,
        },
        { user_id: randomUUID(), activity_id: activityId, samples: [[190, 1000]], is_deleted: 0 },
      ],
    });
    const store = new ClickHouseActivitySensorStore({
      command: (options) => clickhouse.command(options),
      async query<TRow extends object>(options: {
        query: string;
        format: "JSONEachRow";
        query_params: Record<string, unknown>;
        abort_signal?: AbortSignal;
      }) {
        const result = await clickhouse.query({
          ...options,
          query: options.query
            .replaceAll("analytics.", `${database}.`)
            .replaceAll("postgres_fitness.", `${database}.`),
        });
        return { json: () => result.json<TRow>() };
      },
    });
    repository = new TrainingRepository(postgres.db, userId, "UTC", store);
  });

  afterAll(async () => {
    await clickhouse.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await clickhouse.close();
    await postgres?.cleanup();
  });

  it("serves exact weighted zone counts without raw sensor rows", async () => {
    const result = await repository.getHrZones(null);
    expect(result.maxHr).toBe(200);
    expect(result.weeks).toEqual([
      expect.objectContaining({ zone0: 2, zone1: 3, zone2: 4, zone3: 5, zone4: 6, zone5: 7 }),
    ]);
    expect(result.intensityDistribution.totalSeconds).toBe(27);
  });
});
