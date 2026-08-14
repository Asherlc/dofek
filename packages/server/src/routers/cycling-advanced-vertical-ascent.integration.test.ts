import { queryCache } from "dofek/lib/cache";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { createApp } from "../index.ts";
import {
  type ClickHouseMetricStreamSeedRow,
  createClickHouseTestActivitySensorStore,
  seedClickHouseMetricStreamRows,
  syncClickHouseTestActivitySensorStore,
} from "./clickhouse-integration-test-helpers.ts";

describe("cyclingAdvanced vertical ascent integration", () => {
  let server: ReturnType<import("express").Express["listen"]>;
  let baseUrl: string;
  let sessionCookie: string;
  let testCtx: TestContext;

  beforeAll(async () => {
    testCtx = await setupTestDatabase();

    const session = await createSession(testCtx.db, TEST_USER_ID);
    sessionCookie = `session=${session.sessionId}`;

    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('test_provider', 'Test Provider', ${TEST_USER_ID})
          ON CONFLICT DO NOTHING`,
    );

    const sensorStore = await createClickHouseTestActivitySensorStore(testCtx);
    const app = createApp(testCtx.db, sensorStore);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  }, 60_000);

  afterAll(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    await testCtx?.cleanup();
  });

  it("uses nearby grade when present and altitude fallback otherwise", async () => {
    const startedAt = new Date();
    startedAt.setDate(startedAt.getDate() - 2);
    startedAt.setMinutes(0, 0, 0);
    const endedAt = new Date(startedAt.getTime() + 10 * 60 * 1000);

    const offsetGradeClimbId = await createActivity("Offset Grade Climb", startedAt, endedAt);
    const lowGradeDriftId = await createActivity(
      "Low Grade Drift",
      new Date(startedAt.getTime() + 20 * 60 * 1000),
      new Date(endedAt.getTime() + 20 * 60 * 1000),
    );
    const altitudeOnlyClimbId = await createActivity(
      "Altitude Only Climb",
      new Date(startedAt.getTime() + 40 * 60 * 1000),
      new Date(endedAt.getTime() + 40 * 60 * 1000),
    );
    const walkingClimbId = await createActivity(
      "Walking Climb",
      new Date(startedAt.getTime() + 60 * 60 * 1000),
      new Date(endedAt.getTime() + 60 * 60 * 1000),
      "walking",
    );

    const metricStreamSeedRows: ClickHouseMetricStreamSeedRow[] = [];
    for (let second = 0; second <= 360; second += 120) {
      const offsetAltitudeTimestamp = new Date(startedAt.getTime() + second * 1000).toISOString();
      const offsetGradeTimestamp = new Date(
        startedAt.getTime() + second * 1000 + 2000,
      ).toISOString();
      const driftAltitudeTimestamp = new Date(
        startedAt.getTime() + 20 * 60 * 1000 + second * 1000,
      ).toISOString();
      const driftGradeTimestamp = new Date(
        startedAt.getTime() + 20 * 60 * 1000 + second * 1000 + 2000,
      ).toISOString();
      const altitudeOnlyTimestamp = new Date(
        startedAt.getTime() + 40 * 60 * 1000 + second * 1000,
      ).toISOString();
      const walkingTimestamp = new Date(
        startedAt.getTime() + 60 * 60 * 1000 + second * 1000,
      ).toISOString();
      const altitude = 400 + second * 0.6;

      metricStreamSeedRows.push(
        {
          userId: TEST_USER_ID,
          recordedAt: offsetAltitudeTimestamp,
          providerId: "test_provider",
          sourceType: "api",
          channel: "altitude",
          activityId: offsetGradeClimbId,
          scalar: altitude,
        },
        {
          userId: TEST_USER_ID,
          recordedAt: offsetGradeTimestamp,
          providerId: "test_provider",
          sourceType: "api",
          channel: "grade",
          activityId: offsetGradeClimbId,
          scalar: 6,
        },
        {
          userId: TEST_USER_ID,
          recordedAt: driftAltitudeTimestamp,
          providerId: "test_provider",
          sourceType: "api",
          channel: "altitude",
          activityId: lowGradeDriftId,
          scalar: altitude,
        },
        {
          userId: TEST_USER_ID,
          recordedAt: driftGradeTimestamp,
          providerId: "test_provider",
          sourceType: "api",
          channel: "grade",
          activityId: lowGradeDriftId,
          scalar: 0.5,
        },
        {
          userId: TEST_USER_ID,
          recordedAt: altitudeOnlyTimestamp,
          providerId: "test_provider",
          sourceType: "api",
          channel: "altitude",
          activityId: altitudeOnlyClimbId,
          scalar: altitude,
        },
        {
          userId: TEST_USER_ID,
          recordedAt: walkingTimestamp,
          providerId: "test_provider",
          sourceType: "api",
          channel: "altitude",
          activityId: walkingClimbId,
          scalar: altitude,
        },
      );
    }

    await syncClickHouseTestActivitySensorStore(testCtx);
    await seedClickHouseMetricStreamRows(testCtx, metricStreamSeedRows);
    await queryCache.invalidateAll();

    const result = await query<
      {
        date: string;
        activityName: string;
        activityType: string;
        verticalAscentRate: number;
        elevationGainMeters: number;
        elapsedMinutes: number;
      }[]
    >("cyclingAdvanced.verticalAscentRate", { days: 3 });

    const offsetRow = result.find((row) => row.activityName === "Offset Grade Climb");
    const altitudeOnlyRow = result.find((row) => row.activityName === "Altitude Only Climb");
    const lowGradeRow = result.find((row) => row.activityName === "Low Grade Drift");
    const walkingRow = result.find((row) => row.activityName === "Walking Climb");

    expect(offsetRow).toBeDefined();
    expect(offsetRow?.elevationGainMeters).toBeGreaterThan(0);
    expect(offsetRow?.elapsedMinutes).toBeGreaterThan(5);
    expect(offsetRow?.verticalAscentRate).toBeGreaterThan(0);

    expect(altitudeOnlyRow).toBeDefined();
    expect(altitudeOnlyRow?.elevationGainMeters).toBeGreaterThan(0);
    expect(altitudeOnlyRow?.verticalAscentRate).toBeGreaterThan(0);

    expect(lowGradeRow).toBeDefined();
    expect(lowGradeRow?.elevationGainMeters).toBeGreaterThan(0);
    expect(lowGradeRow?.verticalAscentRate).toBeGreaterThan(0);
    expect(walkingRow).toBeUndefined();
  });

  async function createActivity(
    name: string,
    startedAt: Date,
    endedAt: Date,
    activityType = "cycling",
  ): Promise<string> {
    const activityRows = await testCtx.db.execute<{ id: string }>(
      sql`INSERT INTO fitness.activity (
            provider_id, user_id, external_id, canonical_type, provider_type, started_at, ended_at, name
          ) VALUES (
            'test_provider', ${TEST_USER_ID}, ${`vertical-ascent-${name}-${startedAt.toISOString()}`}, ${activityType}, ${activityType},
            ${startedAt.toISOString()},
            ${endedAt.toISOString()}, ${name}
          )
          RETURNING id`,
    );
    const activityId = activityRows[0]?.id;

    if (!activityId) {
      throw new Error(`Failed to create ${name} activity`);
    }

    return activityId;
  }

  async function query<T = unknown>(path: string, input: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(`${baseUrl}/api/trpc/${path}?batch=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify({ "0": input }),
    });
    const data = await response.json();
    const first: { result?: { data?: T }; error?: { message: string } } = data[0];
    if (first?.error) {
      throw new Error(`${path} error: ${JSON.stringify(first.error)}`);
    }
    return first?.result?.data;
  }
});
