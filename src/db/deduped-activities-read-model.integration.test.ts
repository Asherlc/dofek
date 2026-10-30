import { randomBytes } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildActivityOriginViewSql } from "./clickhouse-activity-origin.ts";
import { buildActivitySummaryRowsTableSql } from "./clickhouse-activity-summary.ts";
import {
  activityId,
  groupId,
  linkedActivityId,
  renderDedupedActivitiesSelectSql,
  requireClickHouseUrl,
  requireClient,
  seedMissingSourceNameFixture,
  seedNamedTimezoneContextFixture,
  seedSensorBearingRepresentativeFixture,
  seedSpecificActivityTypeFixture,
  testUserId,
  waitForClickHouse,
} from "./deduped-activities-test-helpers.ts";
import { extractCteSql, readModelSql, renderDbtModelSql } from "./read-model-sql-test-helpers.ts";

type ClickHouseClient = ReturnType<typeof createClient>;

interface SourceLinkRow {
  providerId: string;
  sourceLinkCount: number;
  subsource: string;
}

interface ActivityTypeRow {
  activityType: string;
  activityId: string;
  providerId: string;
  providerType: string;
}

interface LocalTimeContextRow {
  endUtcOffsetMinutes: number | null;
  localTimeSource: string;
  startUtcOffsetMinutes: number | null;
  timezone: string | null;
}

describe("deduped_activities read model", () => {
  let client: ClickHouseClient | undefined;
  const targetSchema = `analytics_deduped_activities_test_${randomBytes(6).toString("hex")}`;

  beforeAll(async () => {
    client = createClient({
      url: requireClickHouseUrl(),
      request_timeout: 120_000,
    });
    await waitForClickHouse(client);
  }, 120_000);

  afterAll(async () => {
    if (client) {
      await client.command({ query: `DROP DATABASE IF EXISTS ${targetSchema} SYNC` });
      await client.close();
    }
  });

  it.each(["Afternoon run", " Afternoon run ", null, "", "   "])(
    "uses primary title %s independently of representative fields",
    async (primaryTitle) => {
      const expectedTitle = primaryTitle?.trim() ? primaryTitle : null;
      const activeClient = requireClient(client);
      await seedSpecificActivityTypeFixture(activeClient, targetSchema, "running", "walking");
      await activeClient.command({ query: `TRUNCATE TABLE ${targetSchema}.deduped_sensor` });
      await activeClient.command({
        query: `INSERT INTO ${targetSchema}.deduped_sensor
      (user_id, provider_id, recorded_at, channel)
      VALUES ('${testUserId}', 'peloton', '2026-07-05 16:05:00', 'heart_rate')`,
      });
      await activeClient.command({
        query: `ALTER TABLE ${targetSchema}.activity_source_records UPDATE
      provider_id = if(activity_id = toUUID('${linkedActivityId}'), 'apple_health', provider_id),
      canonical_type = if(activity_id = toUUID('${linkedActivityId}'), 'running', canonical_type),
      source_name = if(activity_id = toUUID('${linkedActivityId}'), 'Asher’s Apple Watch', source_name),
      name = if(activity_id = toUUID('${linkedActivityId}'), {primaryTitle:Nullable(String)}, '40 min 58 sec Walking')
      WHERE 1 SETTINGS mutations_sync = 2`,
        query_params: { primaryTitle },
      });

      const result = await activeClient.query({
        query: renderDedupedActivitiesSelectSql(targetSchema),
        format: "JSONEachRow",
      });
      const rows = z
        .array(
          z.object({
            activity_id: z.string(),
            representative_activity_id: z.string(),
            primary_activity_id: z.string(),
            primary_canonical_type: z.string(),
            canonical_type: z.string(),
            name: z.string().nullable(),
          }),
        )
        .parse(await result.json());
      expect(rows).toEqual([
        {
          activity_id: groupId,
          representative_activity_id: activityId,
          primary_activity_id: linkedActivityId,
          primary_canonical_type: "running",
          canonical_type: "walking",
          name: expectedTitle,
        },
      ]);

      await activeClient.command({
        query: `INSERT INTO ${targetSchema}.deduped_activities ${renderDedupedActivitiesSelectSql(targetSchema)}`,
      });
      const legacyFields = `SELECT * EXCEPT(primary_activity_id,name),activity_id AS id,
      representative_activity_id AS primary_activity_id,'Secondary display title' AS name
      FROM ${targetSchema}.deduped_activities FINAL WHERE is_deleted = 0`;
      await activeClient.command({
        query: buildActivityOriginViewSql(legacyFields, true).replaceAll(
          "analytics.",
          `${targetSchema}.`,
        ),
      });
      const sourceTitle = await activeClient.query({
        query: `SELECT name, primary_canonical_type FROM ${targetSchema}.v_activity`,
        format: "JSONEachRow",
      });
      expect(
        z
          .array(z.object({ name: z.string().nullable(), primary_canonical_type: z.string() }))
          .parse(await sourceTitle.json()),
      ).toEqual([{ name: expectedTitle, primary_canonical_type: "running" }]);
    },
  );

  it("keeps primary title and type in cycling rows while representative metrics remain cycling", async () => {
    const activeClient = requireClient(client);
    await seedSpecificActivityTypeFixture(activeClient, targetSchema, "running", "cycling");
    await activeClient.command({ query: `TRUNCATE TABLE ${targetSchema}.deduped_sensor` });
    await activeClient.command({
      query: `INSERT INTO ${targetSchema}.deduped_sensor (user_id,provider_id,recorded_at,channel)
      VALUES ('${testUserId}','peloton','2026-07-05 16:05:00','heart_rate')`,
    });
    await activeClient.command({
      query: `ALTER TABLE ${targetSchema}.activity_source_records UPDATE
      provider_id = if(activity_id = toUUID('${linkedActivityId}'),'apple_health',provider_id),
      canonical_type = if(activity_id = toUUID('${linkedActivityId}'),'running',canonical_type),
      source_name = if(activity_id = toUUID('${linkedActivityId}'),'Asher’s Apple Watch',source_name),
      name = if(activity_id = toUUID('${linkedActivityId}'),NULL,'Secondary cycling title')
      WHERE 1 SETTINGS mutations_sync = 2`,
    });
    await activeClient.command({
      query: `INSERT INTO ${targetSchema}.deduped_activities ${renderDedupedActivitiesSelectSql(targetSchema)}`,
    });
    await activeClient.command({
      query: buildActivitySummaryRowsTableSql().replaceAll("analytics.", `${targetSchema}.`),
    });
    await activeClient.command({
      query: `INSERT INTO ${targetSchema}.activity_summary_rows
      (activity_id,user_id,canonical_type,provider_type,name,started_at,ended_at,refresh_version,is_deleted,refreshed_at)
      VALUES ('${groupId}','${testUserId}','cycling','cycling','Stale secondary title',
        '2026-07-05 16:00:00','2026-07-05 17:00:00',1,0,now64(9))`,
    });
    await activeClient.command({
      query: `CREATE TABLE ${targetSchema}.activity_aerobic_efficiency (
      activity_id UUID,user_id UUID,max_hr Nullable(Int16),avg_power_z2 Nullable(Float64),
      avg_hr_z2 Nullable(Float64),efficiency_factor Nullable(Float64),z2_samples Nullable(Int32),
      is_deleted UInt8,refresh_version UInt64,refreshed_at DateTime64(9,'UTC')
      ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id,activity_id)`,
    });

    const query = renderDbtModelSql(readModelSql("cycling_activity.sql"), {
      isIncremental: false,
    })
      .replaceAll("{{ ref('activity_summary_rows') }}", `${targetSchema}.activity_summary_rows`)
      .replaceAll("{{ ref('deduped_activities') }}", `${targetSchema}.deduped_activities`)
      .replaceAll(
        "{{ ref('activity_aerobic_efficiency') }}",
        `${targetSchema}.activity_aerobic_efficiency`,
      )
      .concat("\nSETTINGS max_threads = 1, join_use_nulls = 1");
    const result = await activeClient.query({ query, format: "JSONEachRow" });
    expect(
      z
        .array(
          z.object({
            canonical_type: z.string(),
            primary_canonical_type: z.string(),
            activity_name: z.string().nullable(),
          }),
        )
        .parse(await result.json()),
    ).toEqual([
      { canonical_type: "cycling", primary_canonical_type: "running", activity_name: null },
    ]);
  });

  it("updates origin attribution incrementally without changing merged fields or unchanged rebuild versions", async () => {
    const activeClient = requireClient(client);
    await seedSpecificActivityTypeFixture(activeClient, targetSchema, "cycling", "cycling");
    await activeClient.command({
      query: `ALTER TABLE ${targetSchema}.activity_source_records UPDATE
      provider_id = if(activity_id = toUUID('${activityId}'), 'garmin', 'apple_health'),
      source_name = if(activity_id = toUUID('${activityId}'), 'Garmin Edge 530', 'Garmin'),
      raw = if(activity_id = toUUID('${activityId}'), '{"stable":true}', '{"sourceBundle":"com.strava.strava"}')
      WHERE 1 SETTINGS mutations_sync = 2`,
    });
    const build = async () => {
      await activeClient.command({
        query: `INSERT INTO ${targetSchema}.deduped_activities ${renderDedupedActivitiesSelectSql(targetSchema)}`,
      });
    };
    const read = async () => {
      const result = await activeClient.query({
        query: `SELECT * FROM ${targetSchema}.deduped_activities FINAL WHERE is_deleted=0`,
        format: "JSONEachRow",
      });
      const rows = z.array(z.record(z.string(), z.unknown())).parse(await result.json());
      if (rows.length !== 1 || !rows[0]) throw new Error("Expected one activity group");
      return rows[0];
    };
    const selectedFields = (row: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(row).filter(
          ([key]) =>
            !new Set([
              "primary_activity_id",
              "primary_provider_id",
              "primary_source_name",
              "primary_canonical_type",
              "origin_candidate_member_ids",
              "origin_evidence",
              "refresh_version",
              "refreshed_at",
            ]).has(key),
        ),
      );
    await build();
    const before = await read();
    expect(before.primary_activity_id).toBeNull();
    await activeClient.command({
      query: `ALTER TABLE ${targetSchema}.activity_source_records UPDATE raw='{}'
      WHERE activity_id=toUUID('${linkedActivityId}') SETTINGS mutations_sync=2`,
    });
    await build();
    const after = await read();
    expect(after.primary_activity_id).toBe(activityId);
    expect(selectedFields(after)).toEqual(selectedFields(before));
    expect(BigInt(String(after.refresh_version))).toBeGreaterThan(
      BigInt(String(before.refresh_version)),
    );
    await build();
    expect(await read()).toEqual(after);
    await activeClient.command({
      query: `ALTER TABLE ${targetSchema}.activity_source_records UPDATE priority=0,name='Edited downstream title'
      WHERE activity_id=toUUID('${linkedActivityId}') SETTINGS mutations_sync=2`,
    });
    await build();
    const fieldUpdate = await read();
    expect(fieldUpdate.primary_activity_id).toBe(activityId);
    expect(fieldUpdate.name).toBe("Power Zone Ride");
    expect(fieldUpdate.activity_id).toBe(groupId);
  });

  it("resolves late originals and removed members while preserving group identity and legacy fields", async () => {
    const activeClient = requireClient(client);
    await seedSpecificActivityTypeFixture(activeClient, targetSchema, "cycling", "cycling");
    await activeClient.command({
      query: `ALTER TABLE ${targetSchema}.activity_source_records UPDATE
      provider_id=if(activity_id=toUUID('${activityId}'),'garmin','strava'),source_name='Garmin Edge 530',
      is_deleted=if(activity_id=toUUID('${activityId}'),1,0) WHERE 1 SETTINGS mutations_sync=2`,
    });
    const build = async () => {
      await activeClient.command({
        query: `INSERT INTO ${targetSchema}.deduped_activities ${renderDedupedActivitiesSelectSql(targetSchema)}`,
      });
    };
    const read = async () => {
      const result = await activeClient.query({
        query: `SELECT toString(activity_id) AS id,toString(primary_activity_id) AS primary
        FROM ${targetSchema}.deduped_activities FINAL WHERE is_deleted=0`,
        format: "JSONEachRow",
      });
      return z
        .array(z.object({ id: z.string(), primary: z.string().nullable() }))
        .parse(await result.json());
    };
    await build();
    expect(await read()).toEqual([{ id: groupId, primary: linkedActivityId }]);
    await activeClient.command({
      query: `ALTER TABLE ${targetSchema}.activity_source_records UPDATE is_deleted=0
      WHERE activity_id=toUUID('${activityId}') SETTINGS mutations_sync=2`,
    });
    await build();
    expect(await read()).toEqual([{ id: groupId, primary: activityId }]);
    const legacyQuery = `SELECT * EXCEPT(primary_activity_id,name),activity_id AS id,
      representative_activity_id AS primary_activity_id,'Legacy display title' AS name
      FROM ${targetSchema}.deduped_activities FINAL WHERE is_deleted=0`;
    await activeClient.command({
      query: buildActivityOriginViewSql(legacyQuery).replaceAll("analytics.", `${targetSchema}.`),
    });
    const legacy = await activeClient.query({
      query: `SELECT toString(id) AS id,toString(primary_activity_id) AS primary,name
      FROM ${targetSchema}.v_activity`,
      format: "JSONEachRow",
    });
    expect(
      z
        .array(z.object({ id: z.string(), primary: z.string().nullable(), name: z.string() }))
        .parse(await legacy.json()),
    ).toEqual([{ id: groupId, primary: activityId, name: "Legacy display title" }]);
    await activeClient.command({ query: `DROP VIEW ${targetSchema}.v_activity` });
    const changedMembership = `SELECT * EXCEPT(primary_activity_id,name,member_activity_ids),activity_id AS id,
      representative_activity_id AS primary_activity_id,'Legacy display title' AS name,
      [toUUID('${linkedActivityId}')] AS member_activity_ids
      FROM ${targetSchema}.deduped_activities FINAL WHERE is_deleted=0`;
    await activeClient.command({
      query: buildActivityOriginViewSql(changedMembership).replaceAll(
        "analytics.",
        `${targetSchema}.`,
      ),
    });
    const stale = await activeClient.query({
      query: `SELECT toString(primary_activity_id) AS primary,length(origin_evidence) AS evidenceCount
      FROM ${targetSchema}.v_activity`,
      format: "JSONEachRow",
    });
    expect(
      z
        .array(z.object({ primary: z.string().nullable(), evidenceCount: z.number() }))
        .parse(await stale.json()),
    ).toEqual([{ primary: null, evidenceCount: 0 }]);
    await activeClient.command({
      query: `ALTER TABLE ${targetSchema}.activity_source_records UPDATE is_deleted=1
      WHERE activity_id=toUUID('${activityId}') SETTINGS mutations_sync=2`,
    });
    await build();
    expect(await read()).toEqual([{ id: groupId, primary: linkedActivityId }]);
  });

  it("materializes source links when source name fields are absent", async () => {
    const activeClient = requireClient(client);
    await seedMissingSourceNameFixture(activeClient, targetSchema);

    await activeClient.command({
      query: `INSERT INTO ${targetSchema}.deduped_activities
${renderDedupedActivitiesSelectSql(targetSchema)}`,
    });

    const result = await activeClient.query({
      query: `SELECT
          length(source_external_ids) AS sourceLinkCount,
          source_external_ids[1]['providerId'] AS providerId,
          source_external_ids[1]['subsource'] AS subsource
        FROM ${targetSchema}.deduped_activities FINAL
        WHERE activity_id = {activityId:UUID}
          AND is_deleted = 0`,
      query_params: { activityId: groupId },
      format: "JSONEachRow",
    });
    const rows = await result.json<SourceLinkRow>();

    expect(rows).toEqual([{ providerId: "peloton", sourceLinkCount: 1, subsource: "" }]);

    const localTimeResult = await activeClient.query({
      query: `SELECT
          timezone,
          start_utc_offset_minutes AS startUtcOffsetMinutes,
          end_utc_offset_minutes AS endUtcOffsetMinutes,
          local_time_source AS localTimeSource
        FROM ${targetSchema}.deduped_activities FINAL
        WHERE activity_id = {activityId:UUID}
          AND is_deleted = 0`,
      query_params: { activityId: groupId },
      format: "JSONEachRow",
    });
    const localTimeRows = await localTimeResult.json<LocalTimeContextRow>();

    expect(localTimeRows).toEqual([
      {
        endUtcOffsetMinutes: -420,
        localTimeSource: "provider_timezone",
        startUtcOffsetMinutes: -480,
        timezone: "America/Los_Angeles",
      },
    ]);
  }, 180_000);

  it("preserves unknown end times and uses only recorded end times across members", async () => {
    const activeClient = requireClient(client);
    await seedSpecificActivityTypeFixture(activeClient, targetSchema, "cycling", "cycling");
    await activeClient.command({
      query: `ALTER TABLE ${targetSchema}.activity_source_records UPDATE ended_at = NULL WHERE 1 SETTINGS mutations_sync = 2`,
    });
    const readGroups = async () => {
      const result = await activeClient.query({
        query: renderDedupedActivitiesSelectSql(targetSchema),
        format: "JSONEachRow",
      });
      return result.json();
    };
    expect(await readGroups()).toEqual([expect.objectContaining({ ended_at: null })]);

    await activeClient.command({
      query: `ALTER TABLE ${targetSchema}.activity_source_records
      UPDATE ended_at = toDateTime64('2026-07-05 17:00:00', 6, 'UTC')
      WHERE activity_id = '${linkedActivityId}' SETTINGS mutations_sync = 2`,
    });
    expect(await readGroups()).toEqual([
      expect.objectContaining({ ended_at: "2026-07-05 17:00:00.000000" }),
    ]);
  });

  it("prefers specific canonical and provider type evidence over provider priority", async () => {
    const activeClient = requireClient(client);
    await seedSpecificActivityTypeFixture(activeClient, targetSchema);

    await activeClient.command({
      query: `INSERT INTO ${targetSchema}.deduped_activities
${renderDedupedActivitiesSelectSql(targetSchema)}`,
    });

    const result = await activeClient.query({
      query: `SELECT
          toString(activity_id) AS activityId,
          provider_id AS providerId,
          canonical_type AS activityType,
          provider_type AS providerType
        FROM ${targetSchema}.deduped_activities FINAL
        WHERE is_deleted = 0`,
      format: "JSONEachRow",
    });
    const rows = await result.json<ActivityTypeRow>();

    expect(rows).toEqual([
      {
        activityId: groupId,
        providerId: "whoop",
        activityType: "cycling",
        providerType: "commuting",
      },
    ]);
  }, 180_000);

  it("prefers a sensor-bearing member when type evidence is tied", async () => {
    const activeClient = requireClient(client);
    await seedSensorBearingRepresentativeFixture(activeClient, targetSchema);

    await activeClient.command({
      query: `INSERT INTO ${targetSchema}.deduped_activities
${renderDedupedActivitiesSelectSql(targetSchema)}`,
    });

    const result = await activeClient.query({
      query: `SELECT toString(activity_id) AS activityId, provider_id AS providerId,
          canonical_type AS activityType, provider_type AS providerType
        FROM ${targetSchema}.deduped_activities FINAL
        WHERE is_deleted = 0`,
      format: "JSONEachRow",
    });

    expect(await result.json<ActivityTypeRow>()).toEqual([
      {
        activityId: groupId,
        providerId: "whoop",
        activityType: "cycling",
        providerType: "cycling",
      },
    ]);
  }, 180_000);

  it("keeps a named timezone and its offsets from the same member", async () => {
    const activeClient = requireClient(client);
    await seedNamedTimezoneContextFixture(activeClient, targetSchema);

    await activeClient.command({
      query: `INSERT INTO ${targetSchema}.deduped_activities
${renderDedupedActivitiesSelectSql(targetSchema)}`,
    });

    const result = await activeClient.query({
      query: `SELECT
          timezone,
          start_utc_offset_minutes AS startUtcOffsetMinutes,
          end_utc_offset_minutes AS endUtcOffsetMinutes,
          local_time_source AS localTimeSource
        FROM ${targetSchema}.deduped_activities FINAL
        WHERE is_deleted = 0`,
      format: "JSONEachRow",
    });

    expect(await result.json<LocalTimeContextRow>()).toEqual([
      {
        endUtcOffsetMinutes: -420,
        localTimeSource: "device_timezone",
        startUtcOffsetMinutes: -420,
        timezone: "America/Los_Angeles",
      },
    ]);
  }, 180_000);

  it("keeps the group key and all members when richer sensor payload changes the winner", async () => {
    const activeClient = requireClient(client);
    await seedSpecificActivityTypeFixture(activeClient, targetSchema);
    await activeClient.command({
      query: `INSERT INTO ${targetSchema}.deduped_activities ${renderDedupedActivitiesSelectSql(targetSchema)}`,
    });
    const before = await activeClient.query({
      query: `SELECT representative_activity_id, provider_id, canonical_type, name FROM ${targetSchema}.deduped_activities FINAL`,
      format: "JSONEachRow",
    });
    expect(await before.json()).toEqual([
      {
        representative_activity_id: linkedActivityId,
        provider_id: "whoop",
        canonical_type: "cycling",
        name: "Power Zone Ride",
      },
    ]);
    // The generic, higher-priority member now has more samples than the specific member.
    await activeClient.command({
      query: `INSERT INTO ${targetSchema}.deduped_sensor (user_id, provider_id, recorded_at, channel) VALUES
        ('${testUserId}', 'peloton', '2026-07-05 16:10:00', 'heart_rate'),
        ('${testUserId}', 'peloton', '2026-07-05 16:11:00', 'heart_rate')`,
    });
    await activeClient.command({
      query: `INSERT INTO ${targetSchema}.deduped_activities ${renderDedupedActivitiesSelectSql(targetSchema)}`,
    });
    const result = await activeClient.query({
      query: `SELECT toString(activity_id) AS activityId, toString(representative_activity_id) AS primaryId,
        provider_id AS providerId, canonical_type AS activityType, name,
        arraySort(member_activity_ids) AS members, is_deleted AS isDeleted
        FROM ${targetSchema}.deduped_activities FINAL`,
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([
      {
        activityId: groupId,
        primaryId: activityId,
        providerId: "peloton",
        activityType: "cardio",
        name: "Power Zone Ride",
        members: [activityId, linkedActivityId],
        isDeleted: 0,
      },
    ]);
  });

  it("does not credit an overlapping metadata-only member of the same provider", async () => {
    const activeClient = requireClient(client);
    await seedSpecificActivityTypeFixture(activeClient, targetSchema, "cycling", "cycling");
    await activeClient.command({
      query: `ALTER TABLE ${targetSchema}.activity_source_records
      UPDATE provider_id = 'whoop' WHERE activity_id = '${activityId}' SETTINGS mutations_sync = 2`,
    });
    // Both windows and providers match; only the lower-priority linked member owns this sample.
    const sql = renderDedupedActivitiesSelectSql(targetSchema);
    const credits = await activeClient.query({
      query: `WITH active_field_priority AS (${extractCteSql(sql, "active_field_priority")}),
      ranked AS (${extractCteSql(sql, "ranked")}),
      sensor_bearing_members AS (${extractCteSql(sql, "sensor_bearing_members")})
      SELECT ranked.activity_id AS memberId, toUInt32(coalesce(sensor_sample_count, 0)) AS sampleCount
      FROM ranked LEFT JOIN sensor_bearing_members
        ON ranked.activity_id = sensor_bearing_members.activity_id
        AND ranked.user_id = sensor_bearing_members.user_id
      ORDER BY memberId SETTINGS join_use_nulls = 1`,
      format: "JSONEachRow",
    });
    expect(await credits.json()).toEqual([
      { memberId: activityId, sampleCount: 0 },
      { memberId: linkedActivityId, sampleCount: 1 },
    ]);
    const result = await activeClient.query({
      query: renderDedupedActivitiesSelectSql(targetSchema),
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([
      expect.objectContaining({
        activity_id: groupId,
        representative_activity_id: linkedActivityId,
      }),
    ]);
  });

  it.each([
    {
      name: "sensor presence before specific type",
      pelotonType: "cardio",
      whoopType: "commuting",
      pelotonSamples: 1,
      whoopSamples: 0,
      whoopPriority: 1,
      winner: "peloton",
    },
    {
      name: "sample richness before provider priority",
      pelotonType: "cycling",
      whoopType: "cycling",
      pelotonSamples: 1,
      whoopSamples: 2,
      whoopPriority: 20,
      winner: "whoop",
    },
    {
      name: "specific canonical type after tied payload",
      pelotonType: "cardio",
      whoopType: "cycling",
      pelotonSamples: 0,
      whoopSamples: 0,
      whoopPriority: 20,
      winner: "whoop",
    },
    {
      name: "provider refinement after tied canonical type",
      pelotonType: "cycling",
      whoopType: " commuting ",
      pelotonSamples: 0,
      whoopSamples: 0,
      whoopPriority: 20,
      winner: "whoop",
    },
    {
      name: "normalized provider type before priority",
      pelotonType: "cycling",
      whoopType: " Cycling ",
      pelotonSamples: 0,
      whoopSamples: 0,
      whoopPriority: 20,
      winner: "peloton",
    },
    {
      name: "priority after tied type and payload",
      pelotonType: "cycling",
      whoopType: "cycling",
      pelotonSamples: 0,
      whoopSamples: 0,
      whoopPriority: 1,
      winner: "whoop",
    },
    {
      name: "UUID after tied priority",
      pelotonType: "cycling",
      whoopType: "cycling",
      pelotonSamples: 0,
      whoopSamples: 0,
      whoopPriority: 10,
      winner: "peloton",
    },
  ])("ranks $name", async (scenario) => {
    const activeClient = requireClient(client);
    await seedSpecificActivityTypeFixture(
      activeClient,
      targetSchema,
      scenario.whoopType,
      scenario.pelotonType,
    );
    await activeClient.command({ query: `TRUNCATE TABLE ${targetSchema}.deduped_sensor` });
    await activeClient.command({
      query: `ALTER TABLE ${targetSchema}.activity_source_records
      UPDATE priority = ${scenario.whoopPriority} WHERE activity_id = '${linkedActivityId}' SETTINGS mutations_sync = 2`,
    });
    for (const [provider, count] of [
      ["peloton", scenario.pelotonSamples],
      ["whoop", scenario.whoopSamples],
    ] as const) {
      if (count === 0) continue;
      await activeClient.command({
        query: `INSERT INTO ${targetSchema}.deduped_sensor
        (user_id, provider_id, recorded_at, channel)
        SELECT '${testUserId}', '${provider}', toDateTime64('2026-07-05 16:00:00', 6, 'UTC') + toIntervalMinute(number), '${provider === "peloton" ? "power" : "heart_rate"}'
        FROM numbers(${count})`,
      });
    }
    const result = await activeClient.query({
      query: renderDedupedActivitiesSelectSql(targetSchema),
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([
      expect.objectContaining({ activity_id: groupId, provider_id: scenario.winner }),
    ]);
  });

  it("prefers elevation payload after equal sample counts", async () => {
    const activeClient = requireClient(client);
    await seedSpecificActivityTypeFixture(activeClient, targetSchema, "cycling", "cycling");
    await activeClient.command({ query: `TRUNCATE TABLE ${targetSchema}.deduped_sensor` });
    await activeClient.command({
      query: `INSERT INTO ${targetSchema}.deduped_sensor
      (user_id, provider_id, recorded_at, channel) VALUES
      ('${testUserId}', 'peloton', '2026-07-05 16:00:00', 'power'),
      ('${testUserId}', 'whoop', '2026-07-05 17:00:00', 'altitude')`,
    });
    const result = await activeClient.query({
      query: renderDedupedActivitiesSelectSql(targetSchema),
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([
      expect.objectContaining({ activity_id: groupId, provider_id: "whoop" }),
    ]);
  });

  it("ignores deleted samples and samples outside adjacent same-provider activity windows", async () => {
    const activeClient = requireClient(client);
    await seedSpecificActivityTypeFixture(activeClient, targetSchema, "cycling", "cycling");
    await activeClient.command({ query: `TRUNCATE TABLE ${targetSchema}.deduped_sensor` });
    await activeClient.command({
      query: `INSERT INTO ${targetSchema}.deduped_sensor
      (user_id, provider_id, recorded_at, channel, is_deleted) VALUES
      ('${testUserId}', 'whoop', '2026-07-05 15:59:59', 'heart_rate', 0),
      ('${testUserId}', 'whoop', '2026-07-05 17:00:01', 'heart_rate', 0),
      ('${testUserId}', 'whoop', '2026-07-05 16:10:00', 'heart_rate', 1)`,
    });
    const result = await activeClient.query({
      query: renderDedupedActivitiesSelectSql(targetSchema),
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([
      expect.objectContaining({ activity_id: groupId, provider_id: "peloton" }),
    ]);
  });

  it("tombstones a removed member alias while keeping its stable group during a group-scoped refresh", async () => {
    const activeClient = requireClient(client);
    await seedSpecificActivityTypeFixture(activeClient, targetSchema);
    await activeClient.command({
      query: `INSERT INTO ${targetSchema}.deduped_activities ${renderDedupedActivitiesSelectSql(targetSchema)}`,
    });
    const renderMembers = (incremental: boolean) =>
      renderDbtModelSql(readModelSql("deduped_activity_members.sql"), {
        isIncremental: incremental,
        activityRefreshScoped: true,
        activityRefreshIds: [groupId],
      })
        .replaceAll("{{ ref('deduped_activities') }}", `${targetSchema}.deduped_activities`)
        .replaceAll("{{ this }}", `${targetSchema}.deduped_activity_members`)
        .replaceAll('{{ var("activity_refresh_user_id") }}', testUserId)
        .concat("\nSETTINGS max_threads = 1, join_use_nulls = 1");
    await activeClient.command({
      query: `CREATE TABLE ${targetSchema}.deduped_activity_members
      ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, member_activity_id) AS ${renderMembers(false)}`,
    });
    await activeClient.command({
      query: `ALTER TABLE ${targetSchema}.activity_source_records
      UPDATE is_deleted = 1 WHERE activity_id = '${linkedActivityId}' SETTINGS mutations_sync = 2`,
    });
    await activeClient.command({
      query: `INSERT INTO ${targetSchema}.deduped_activities ${renderDedupedActivitiesSelectSql(targetSchema, [groupId])}`,
    });
    await activeClient.command({
      query: `INSERT INTO ${targetSchema}.deduped_activity_members ${renderMembers(true)}`,
    });
    const result = await activeClient.query({
      query: `SELECT toString(activity_id) AS groupId,
      toString(member_activity_id) AS memberId, is_deleted AS isDeleted
      FROM ${targetSchema}.deduped_activity_members FINAL ORDER BY memberId`,
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([
      { groupId, memberId: activityId, isDeleted: 0 },
      { groupId, memberId: linkedActivityId, isDeleted: 1 },
    ]);
  });

  it("fails explicitly if active membership has not reached the source projection", async () => {
    const activeClient = requireClient(client);
    await seedMissingSourceNameFixture(activeClient, targetSchema);
    await activeClient.command({
      query: `ALTER TABLE ${targetSchema}.activity_source_records
      UPDATE group_id = NULL WHERE 1 SETTINGS mutations_sync = 2`,
    });
    await expect(
      activeClient.command({
        query: `INSERT INTO ${targetSchema}.deduped_activities ${renderDedupedActivitiesSelectSql(targetSchema)}`,
      }),
    ).rejects.toThrow("missing persisted group_id");
  });
});
