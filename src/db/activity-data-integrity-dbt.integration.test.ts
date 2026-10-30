import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runningRevisionFixture } from "./activity-data-integrity-cadence-test-helpers.ts";
import type { ActivityIntegrityClickHouseClient } from "./activity-data-integrity-clickhouse.ts";
import { runActivityIntegrityDbtBuild } from "./activity-data-integrity-dbt.ts";
import {
  activityIntegrityFixtureIds,
  bootstrapActivityIntegrityIdentityModels,
  configureDbtEnvironment,
  dbtEnvironmentKeys,
  scopeClickHouseClient,
  seedProductionDbtFixture,
} from "./activity-data-integrity-dbt-test-helpers.ts";
import { TEST_USER_ID } from "./schema/core.ts";

const { wahooActivityId } = activityIntegrityFixtureIds;
const priorDbtEnvironment = new Map(
  dbtEnvironmentKeys.map((key) => [key, process.env[key]] as const),
);

describe("activity data integrity dbt build", () => {
  let client: ReturnType<typeof createClient>;
  let scopedClient: ActivityIntegrityClickHouseClient;
  const database = `activity_integrity_dbt_${randomBytes(6).toString("hex")}`;

  beforeAll(async () => {
    const clickHouseUrl = process.env.CLICKHOUSE_URL?.trim();
    if (!clickHouseUrl)
      throw new Error("CLICKHOUSE_URL is required for activity dbt integration tests");
    client = createClient({ url: clickHouseUrl, request_timeout: 120_000 });
    await client.query({ query: "SELECT 1", format: "JSONEachRow" });
    scopedClient = scopeClickHouseClient(client, database);
  }, 300_000);

  beforeEach(({ onTestFailed }) => {
    onTestFailed(({ task }) => {
      process.stderr.write(
        `${JSON.stringify({
          test: task.name,
          errors: task.result?.errors?.map((error) => error.message.slice(0, 1200)),
        })}\n`,
      );
    });
  }, 120_000);

  afterAll(async () => {
    for (const [key, value] of priorDbtEnvironment) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    if (client) {
      await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
      await client.close();
    }
  }, 120_000);

  it("finishes 101 revision/member aliases, old-group tombstones and downstream cadence before returning", async () => {
    await seedProductionDbtFixture(client, database);
    configureDbtEnvironment(database);
    await bootstrapActivityIntegrityIdentityModels();
    const fixture = runningRevisionFixture(TEST_USER_ID);
    const { records } = fixture;
    await client.insert({
      table: `${database}.activity`,
      format: "JSONEachRow",
      values: fixture.initialActivityRows,
    });
    await client.insert({
      table: `${database}.metric_stream`,
      format: "JSONEachRow",
      values: fixture.initialStepRows,
    });
    const input = {
      userId: TEST_USER_ID,
      activityIds: records.map((record) => record.member),
      eventTimeStart: new Date("2026-09-01"),
      eventTimeEnd: new Date("2026-09-03"),
    };
    const cadenceRows = async () => {
      const result = await client.query({
        query: `SELECT activity_id,avg_cadence,is_deleted FROM ${database}.activity_step_cadence_rows FINAL WHERE user_id={user:UUID}`,
        query_params: { user: TEST_USER_ID },
        format: "JSONEachRow",
      });
      return result.json<{ activity_id: string; avg_cadence: number | null; is_deleted: number }>();
    };
    // Establish every old row before testing correction of the entire canonical scope.
    await runActivityIntegrityDbtBuild(input, scopedClient);
    const before = await cadenceRows();
    expect(before).toHaveLength(101);
    expect(before).toEqual(
      expect.arrayContaining(
        records.map((record) => ({
          activity_id: record.group,
          avg_cadence: 150,
          is_deleted: 0,
        })),
      ),
    );

    await client.insert({
      table: `${database}.activity`,
      format: "JSONEachRow",
      values: fixture.revisedActivityRows,
    });
    await client.insert({
      table: `${database}.metric_stream`,
      format: "JSONEachRow",
      values: fixture.revisedStepRows,
    });
    await runActivityIntegrityDbtBuild(input, scopedClient);
    const cadence = await cadenceRows();
    expect(cadence).toHaveLength(202);
    expect(cadence.filter((row) => row.is_deleted === 0)).toHaveLength(101);
    for (const record of records) {
      expect(cadence.find((row) => row.activity_id === record.group)).toMatchObject({
        is_deleted: 1,
        avg_cadence: null,
      });
      expect(cadence.find((row) => row.activity_id === record.nextGroup)).toMatchObject({
        is_deleted: 0,
        avg_cadence: 180,
      });
    }
    const summaries = await client.query({
      query: `SELECT activity_id,avg_cadence FROM ${database}.activity_summary_rows FINAL WHERE user_id={user:UUID} AND is_deleted=0 AND activity_id IN {ids:Array(UUID)}`,
      query_params: { user: TEST_USER_ID, ids: records.map((record) => record.nextGroup) },
      format: "JSONEachRow",
    });
    const summaryRows = await summaries.json();
    expect(summaryRows).toHaveLength(101);
    expect(summaryRows).toEqual(
      expect.arrayContaining(
        records.map((record) => ({
          activity_id: record.nextGroup,
          avg_cadence: 180,
        })),
      ),
    );
    const foreign = await client.query({
      query: `SELECT count() AS count FROM ${database}.activity_step_cadence_rows FINAL WHERE user_id={user:UUID}`,
      query_params: { user: fixture.foreignUserId },
      format: "JSONEachRow",
    });
    expect(await foreign.json()).toEqual([{ count: 0 }]);
  }, 300_000);

  it("creates an empty exact cadence target without selecting another user's running group", async () => {
    await seedProductionDbtFixture(client, database);
    configureDbtEnvironment(database);
    const foreignUser = randomUUID();
    const fixture = runningRevisionFixture(foreignUser);
    const foreign = fixture.initialActivityRows[0];
    if (!foreign) throw new Error("Missing foreign fixture activity");
    await client.insert({
      table: `${database}.activity`,
      format: "JSONEachRow",
      values: [foreign],
    });
    await bootstrapActivityIntegrityIdentityModels();
    await runActivityIntegrityDbtBuild(
      {
        userId: TEST_USER_ID,
        activityIds: [wahooActivityId],
        eventTimeStart: new Date("2026-09-01"),
        eventTimeEnd: new Date("2026-09-03"),
      },
      scopedClient,
    );
    const result = await client.query({
      query: `SELECT count() AS count FROM ${database}.activity_step_cadence_rows FINAL`,
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([{ count: 0 }]);
  }, 300_000);
});
