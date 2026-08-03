import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import {
  createClickHouseTestActivitySensorStore,
  executeClickHouseTestCommand,
} from "../routers/clickhouse-integration-test-helpers.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { CorrelationRepository } from "./correlation-repository.ts";

const userA = "11111111-1111-4111-8111-111111111153";
const userB = "22222222-2222-4222-8222-222222222153";
const activityIdsA = [
  "33333333-3333-4333-8333-333333333151",
  "33333333-3333-4333-8333-333333333152",
  "33333333-3333-4333-8333-333333333153",
];
const activityIdB = "44444444-4444-4444-8444-444444444153";

describe("CorrelationRepository observations", () => {
  let testContext: TestContext;
  let sensorStore: ActivitySensorStore;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    sensorStore = await createClickHouseTestActivitySensorStore(testContext);

    await testContext.db.execute(sql`
      INSERT INTO fitness.user_profile (id, name)
      VALUES (${userA}, 'Correlation User A'), (${userB}, 'Correlation User B')
    `);
    await testContext.db.execute(sql`
      INSERT INTO fitness.provider (id, name, user_id)
      VALUES
        ('correlation_provider_a', 'Correlation Provider A', ${userA}),
        ('correlation_provider_b', 'Correlation Provider B', ${userB})
    `);
    await testContext.db.execute(sql`
      INSERT INTO fitness.daily_metrics (date, provider_id, user_id, steps, source_name)
      VALUES
        ('2026-01-01', 'correlation_provider_a', ${userA}, 7001, 'Watch A'),
        ('2026-01-02', 'correlation_provider_a', ${userA}, 7002, 'Watch A'),
        ('2026-01-03', 'correlation_provider_a', ${userA}, 7003, 'Watch A'),
        ('2026-01-03', 'correlation_provider_b', ${userB}, 9903, 'Watch B')
    `);

    await executeClickHouseTestCommand(
      testContext,
      `INSERT INTO analytics.activity_summary (
        activity_id,
        user_id,
        activity_type,
        name,
        started_at,
        ended_at
      ) VALUES
        (
          toUUID('${activityIdsA[0]}'),
          toUUID('${userA}'),
          'running',
          'A run one',
          toDateTime64('2026-01-01 08:00:00', 6, 'UTC'),
          toDateTime64('2026-01-01 08:31:00', 6, 'UTC')
        ),
        (
          toUUID('${activityIdsA[1]}'),
          toUUID('${userA}'),
          'running',
          'A run two',
          toDateTime64('2026-01-02 08:00:00', 6, 'UTC'),
          toDateTime64('2026-01-02 08:32:00', 6, 'UTC')
        ),
        (
          toUUID('${activityIdsA[2]}'),
          toUUID('${userA}'),
          'running',
          'A run three',
          toDateTime64('2026-01-03 08:00:00', 6, 'UTC'),
          toDateTime64('2026-01-03 08:33:00', 6, 'UTC')
        ),
        (
          toUUID('${activityIdB}'),
          toUUID('${userB}'),
          'running',
          'B private run',
          toDateTime64('2026-01-03 09:00:00', 6, 'UTC'),
          toDateTime64('2026-01-03 10:00:00', 6, 'UTC')
        )`,
    );
  }, 120_000);

  afterAll(async () => {
    await testContext?.cleanup();
  });

  it("paginates canonical source provenance without exposing another user's records", async () => {
    const repository = new CorrelationRepository(testContext.db, userA, "UTC", sensorStore);
    const first = await repository.listObservations(
      "steps",
      "exercise_duration",
      null,
      0,
      "2026-01-03",
      { pageSize: 2 },
    );
    const second = await repository.listObservations(
      "steps",
      "exercise_duration",
      null,
      0,
      "2026-01-03",
      { cursor: first.nextCursor ?? undefined, pageSize: 2 },
    );

    expect(first.totalCount).toBe(3);
    expect(first.items.map((item) => item.x.value)).toEqual([7003, 7002]);
    expect(first.items[0]?.x.contributors).toEqual([
      {
        kind: "aggregate_inputs",
        label: "Daily activity aggregate inputs",
        providerIds: ["correlation_provider_a"],
        target: { type: "metric_family", family: "activity" },
      },
    ]);
    expect([...first.items, ...second.items].map((item) => item.y.contributors[0])).toEqual([
      {
        kind: "record",
        label: "A run three",
        providerIds: [],
        target: { type: "activity", activityId: activityIdsA[2] },
      },
      {
        kind: "record",
        label: "A run two",
        providerIds: [],
        target: { type: "activity", activityId: activityIdsA[1] },
      },
      {
        kind: "record",
        label: "A run one",
        providerIds: [],
        target: { type: "activity", activityId: activityIdsA[0] },
      },
    ]);
    expect(JSON.stringify([...first.items, ...second.items])).not.toContain(activityIdB);
    expect(JSON.stringify([...first.items, ...second.items])).not.toContain("B private run");
  });

  it("returns only the authenticated user's paired observations", async () => {
    const repository = new CorrelationRepository(testContext.db, userB, "UTC", sensorStore);
    const page = await repository.listObservations(
      "steps",
      "exercise_duration",
      null,
      0,
      "2026-01-03",
      { pageSize: 25 },
    );

    expect(page.totalCount).toBe(1);
    expect(page.items[0]).toMatchObject({
      x: { value: 9903 },
      y: {
        value: 60,
        contributors: [
          {
            kind: "record",
            label: "B private run",
            target: { type: "activity", activityId: activityIdB },
          },
        ],
      },
    });
    expect(JSON.stringify(page.items)).not.toContain(activityIdsA[0]);
  });
});
