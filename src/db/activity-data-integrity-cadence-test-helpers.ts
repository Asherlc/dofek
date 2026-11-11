import { randomUUID } from "node:crypto";
import type { createClient } from "@clickhouse/client";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  type ActivityIntegrityClickHouseClient,
  queryClickHouseRows,
} from "./activity-data-integrity-clickhouse.ts";
import { activity } from "./schema/activity.ts";
import { TEST_USER_ID } from "./schema/core.ts";
import type { TestContext } from "./test-helpers.ts";

export function runningRevisionFixture(userId: string) {
  const records = Array.from({ length: 101 }, (_, index) => ({
    member: randomUUID(),
    group: randomUUID(),
    nextMember: randomUUID(),
    nextGroup: randomUUID(),
    workout: randomUUID(),
    nextWorkout: randomUUID(),
    rawId: randomUUID(),
    sync: `revision-${index}`,
  }));
  const foreignUserId = randomUUID();
  const activityRows = (next: boolean) =>
    records.map((record) => ({
      id: next ? record.nextMember : record.member,
      group_id: next ? record.nextGroup : record.group,
      provider_id: "apple_health",
      user_id: userId,
      external_id: `hk:workout:${next ? record.nextWorkout : record.workout}`,
      canonical_type: "running",
      provider_type: "running",
      started_at: "2026-09-01 08:00:00",
      ended_at: "2026-09-01 08:10:00",
      source_name: "Watch",
      raw: JSON.stringify({
        metadata: {
          HKMetadataKeySyncIdentifier: record.sync,
          HKMetadataKeySyncVersion: next ? 2 : 1,
        },
      }),
      local_time_source: "unknown",
      _peerdb_synced_at: "2026-09-02 17:00:00",
      _peerdb_version: next ? 2 : 1,
      created_at: next ? "2026-09-02 17:00:00" : "2026-09-01 17:00:00",
    }));
  const initialActivityRows = activityRows(false);
  const foreignActivity = initialActivityRows[0];
  if (!foreignActivity) throw new Error("Running revision fixture requires an initial activity");
  const stepRows = (next: boolean) =>
    records.map((record) => ({
      id: record.rawId,
      user_id: userId,
      provider_id: "apple_health",
      channel: "step_count",
      scalar: next ? 180 : 150,
      recorded_at: "2026-09-01 08:00:00",
      device_id: "Watch",
      external_id: record.rawId,
      metadata: JSON.stringify({
        interval_end: "2026-09-01T08:01:00Z",
        source_bundle: "com.watch",
        workout_uuids: [next ? record.nextWorkout : record.workout],
      }),
      version: next ? 2 : 1,
      ingested_at: next ? "2026-09-02 17:00:02" : "2026-09-02 17:00:01",
    }));
  return {
    records,
    foreignUserId,
    initialActivityRows: [
      ...initialActivityRows,
      {
        ...foreignActivity,
        id: randomUUID(),
        group_id: randomUUID(),
        user_id: foreignUserId,
      },
    ],
    revisedActivityRows: activityRows(true),
    initialStepRows: stepRows(false),
    revisedStepRows: stepRows(true),
  };
}

export async function mirrorRunningLocalTime(
  context: TestContext,
  client: ReturnType<typeof createClient>,
  database: string,
  activityIds: readonly string[],
): Promise<void> {
  const states = z
    .array(
      z.object({
        id: z.string(),
        timezone: z.string().nullable(),
        start_utc_offset_minutes: z.number().nullable(),
        end_utc_offset_minutes: z.number().nullable(),
        local_time_source: z.string(),
      }),
    )
    .parse(
      await context.db
        .select({
          id: activity.id,
          timezone: activity.timezone,
          start_utc_offset_minutes: activity.startUtcOffsetMinutes,
          end_utc_offset_minutes: activity.endUtcOffsetMinutes,
          local_time_source: activity.localTimeSource,
        })
        .from(activity)
        .where(and(eq(activity.userId, TEST_USER_ID), inArray(activity.id, activityIds))),
    );
  const current = await queryClickHouseRows(
    client,
    z.object({ id: z.string(), _peerdb_version: z.string() }).passthrough(),
    `SELECT * REPLACE(toString(_peerdb_version) AS _peerdb_version) FROM ${database}.activity FINAL WHERE user_id={user:UUID} AND id IN {ids:Array(UUID)}`,
    { user: TEST_USER_ID, ids: activityIds },
  );
  const byId = new Map(states.map((row) => [row.id, row]));
  await client.insert({
    table: `${database}.activity`,
    format: "JSONEachRow",
    values: current.map((row) => {
      const state = byId.get(row.id);
      if (!state) throw new Error(`Missing committed PostgreSQL fixture activity ${row.id}`);
      return {
        ...row,
        ...state,
        _peerdb_version: String(BigInt(row._peerdb_version) + 100n),
        _peerdb_synced_at: "2026-09-02 17:00:00",
      };
    }),
  });
}

export function failSecondCadenceBatch(
  client: ReturnType<typeof createClient>,
  scoped: ActivityIntegrityClickHouseClient,
  database: string,
): ActivityIntegrityClickHouseClient {
  let injected = false;
  return {
    ...scoped,
    query: async (options) => {
      if (
        !injected &&
        options.query.includes(".activity_step_cadence_rows FINAL") &&
        options.query.includes("toString(refresh_version)") &&
        Array.isArray(options.query_params?.activityIds) &&
        options.query_params.activityIds.length === 1
      ) {
        injected = true;
        await client.command({ query: `DROP TABLE ${database}.metric_stream_day_change SYNC` });
      }
      return scoped.query(options);
    },
  };
}
