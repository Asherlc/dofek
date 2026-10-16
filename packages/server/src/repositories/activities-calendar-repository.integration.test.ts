import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { persistClimbingLogEntries } from "../../../../src/db/climbing-log-sync.ts";
import { activity } from "../../../../src/db/schema/activity.ts";
import { TEST_USER_ID as userId } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ensureProvider } from "../../../../src/db/tokens.ts";
import { osmTilePreview } from "../lib/osm-tile.ts";
import {
  createClickHouseTestActivitySensorStore,
  executeClickHouseTestCommand,
} from "../routers/clickhouse-integration-test-helpers.ts";
import { ActivitiesCalendarRepository } from "./activities-calendar-repository.ts";
import { ClimbingActivityLogEntryRepository } from "./climbing-activity-log-entry-repository.ts";

describe("Activities list climbing source GPS", () => {
  let context: TestContext;
  let repository: ActivitiesCalendarRepository;
  let sourceGroup: string;
  let recordedGroup: string;
  let unknownGroup: string;
  let sourceActivityId: string;
  beforeAll(async () => {
    context = await setupTestDatabase();
    await ensureProvider(context.db, "openbeta", "OpenBeta", undefined, userId);
    const rows = await context.db
      .insert(activity)
      .values(
        ["source", "recorded", "unknown"].map((name, index) => ({
          userId,
          providerId: "openbeta",
          externalId: name,
          name,
          canonicalType: "climbing" as const,
          providerType: "rock-climbing",
          startedAt: new Date(`2026-10-02T${12 + index}:00:00Z`),
          endedAt: new Date(`2026-10-02T${12 + index}:30:00Z`),
        })),
      )
      .returning();
    const source = rows.find((row) => row.name === "source");
    const recorded = rows.find((row) => row.name === "recorded");
    const unknown = rows.find((row) => row.name === "unknown");
    if (!source?.groupId || !recorded?.groupId || !unknown?.groupId)
      throw new Error("Expected activity groups");
    sourceGroup = source.groupId;
    sourceActivityId = source.id;
    recordedGroup = recorded.groupId;
    unknownGroup = unknown.groupId;
    await persistClimbingLogEntries(context.db, {
      userId,
      providerId: "openbeta",
      entries: [
        {
          externalId: "source-log",
          activityId: source.id,
          attempts: [{ scope: "climb" }],
          climb: {
            externalId: "area-route",
            name: "Area route",
            kind: "route",
            areas: [
              {
                externalId: "boulder-canyon",
                name: "Boulder Canyon",
                coordinates: { latitude: 40.007, longitude: -105.4 },
              },
            ],
          },
        },
        {
          externalId: "recorded-log",
          activityId: recorded.id,
          attempts: [{ scope: "climb" }],
          climb: {
            externalId: "exact-route",
            name: "Exact route",
            kind: "route",
            coordinates: { latitude: 40.007, longitude: -105.4 },
          },
        },
      ],
    });
    const sensorStore = await createClickHouseTestActivitySensorStore(context);
    await executeClickHouseTestCommand(
      context,
      `ALTER TABLE analytics.activity_summary UPDATE centroid_lat=37.8,centroid_lng=-122.4
       WHERE activity_id=toUUID('${recorded.groupId}') AND user_id=toUUID('${userId}')
       SETTINGS mutations_sync=2`,
    );
    repository = new ActivitiesCalendarRepository(context.db, userId, "UTC", sensorStore);
  });
  afterAll(async () => {
    await context.cleanup();
  });

  it("serves attached Area points through weekList while retaining recorded GPS and GPS-less activities", async () => {
    const days = await repository.getWeekList({ weeks: 1, endDate: "2026-10-02" });
    const entries = days.flatMap((day) => day.activities);
    expect(entries).toHaveLength(3);
    expect(entries.find((entry) => entry.id === sourceGroup)?.location).toMatchObject({
      kind: "climbing_source",
      mapPreview: { routePath: null },
      sourcePoints: [
        {
          x: 512,
          y: 288,
          location: {
            scope: "area",
            name: "Boulder Canyon",
            providerId: "openbeta",
            coordinates: { latitude: 40.007, longitude: -105.4 },
          },
        },
      ],
    });
    expect(entries.find((entry) => entry.id === recordedGroup)?.location).toEqual({
      kind: "recorded_gps",
      centroidLat: 37.8,
      centroidLng: -122.4,
      mapPreview: osmTilePreview([{ lat: 37.8, lng: -122.4 }]),
    });
    expect(entries.find((entry) => entry.id === unknownGroup)?.location).toBeNull();
  });
  it("uses the saved grade preference for the same consolidated source graphs as detail", async () => {
    await ensureProvider(context.db, "mountain-project", "Mountain Project", undefined, userId);
    const [member] = await context.db
      .insert(activity)
      .values({
        userId,
        providerId: "mountain-project",
        externalId: "preferred-member",
        groupId: sourceGroup,
        canonicalType: "climbing",
        providerType: "climbing",
        startedAt: new Date("2026-10-02T12:00:00Z"),
      })
      .onConflictDoUpdate({
        target: [activity.userId, activity.providerId, activity.externalId],
        set: { groupId: sourceGroup },
      })
      .returning();
    if (!member) throw new Error("Expected member");
    for (const { providerId, activityId, externalId, french } of [
      {
        providerId: "openbeta",
        activityId: sourceActivityId,
        externalId: "source-log",
        french: "6a",
      },
      {
        providerId: "mountain-project",
        activityId: member.id,
        externalId: "preferred-log",
        french: "6b",
      },
    ]) {
      await persistClimbingLogEntries(context.db, {
        userId,
        providerId,
        entries: [
          {
            externalId,
            activityId,
            attempts: [{ scope: "climb" }],
            climb: {
              externalId: "area-route",
              name: "Area route",
              kind: "route",
              publishedGrades: [
                { value: "5.10a", system: "yds" },
                { value: french, system: "french" },
              ],
              areas: [
                {
                  externalId: "boulder-canyon",
                  name: "Boulder Canyon",
                  coordinates: { latitude: 40.007, longitude: -105.4 },
                },
              ],
            },
          },
        ],
      });
    }
    await context.db.execute(sql`INSERT INTO fitness.user_settings (user_id,key,value)
      VALUES (${userId}::uuid,'climbingGradeSystems','{"boulder":"v_scale","route":"french"}'::jsonb)
      ON CONFLICT (user_id,key) DO UPDATE SET value=EXCLUDED.value`);
    const details = (
      await new ClimbingActivityLogEntryRepository(context.db, userId, "UTC", undefined, {
        boulder: "v_scale",
        route: "french",
      }).getActivityLogEntries(sourceGroup)
    ).map((entry) => entry.toDetail());
    expect(details).toHaveLength(2);
    const days = await repository.getWeekList({ weeks: 1, endDate: "2026-10-02" });
    const location = days
      .flatMap((day) => day.activities)
      .find((entry) => entry.id === sourceGroup)?.location;
    if (location?.kind !== "climbing_source") throw new Error("Expected climbing source thumbnail");
    expect(location.sourcePoints).toHaveLength(2);
    expect(location.sourcePoints.map((point) => point.location)).toEqual(
      expect.arrayContaining(details.map((entry) => entry.mapLocation)),
    );
  });
});
