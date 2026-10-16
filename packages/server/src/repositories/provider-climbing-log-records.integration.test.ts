import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createClickHouseClientFromEnv } from "../../../../src/db/clickhouse.ts";
import { persistClimbingLogEntries } from "../../../../src/db/climbing-log-sync.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import type { BodyClickHouseStore } from "./body-clickhouse.ts";
import { ProviderDetailRepository } from "./provider-detail-repository.ts";
import { SyncRepository } from "./sync-repository.ts";

// The current provider has no ClickHouse records; PostgreSQL holds the real log graph.
const network = setupServer(
  http.post("*", () =>
    HttpResponse.text("", {
      headers: { "Content-Type": "application/x-ndjson" },
    }),
  ),
);
const client = createClickHouseClientFromEnv();
const store: BodyClickHouseStore = {
  async query(schema, query, params) {
    if (!client.query) throw new Error("ClickHouse client must support query");
    const result = await client.query({ query, query_params: params, format: "JSONEachRow" });
    return (await result.json()).map((row) => schema.parse(row));
  },
};

describe("provider climbing log records", () => {
  const userId = randomUUID();
  const otherUserId = randomUUID();
  let context: TestContext;
  let ids: string[];
  let foreignId: string;

  beforeAll(async () => {
    network.listen({ onUnhandledRequest: "error" });
    context = await setupTestDatabase();
    await context.db.execute(sql`INSERT INTO fitness.user_profile (id, name) VALUES
      (${userId}::uuid, 'Log owner'), (${otherUserId}::uuid, 'Other log owner')`);
    await context.db.execute(sql`INSERT INTO fitness.provider (id, name) VALUES
      ('mountain-project', 'Mountain Project'), ('openbeta', 'OpenBeta') ON CONFLICT (id) DO NOTHING`);
    ids = (
      await persistClimbingLogEntries(context.db, {
        userId,
        providerId: "mountain-project",
        entries: ["2026-10-02", "2026-10-01", null].map((climbedOn, index) => ({
          externalId: `log-${index}`,
          climbedOn,
          discipline: "rock_climbing" as const,
          notes: "Recorded source note",
          raw: {
            URL: "https://www.mountainproject.com/route/105734732/swiss-cheese",
            sourceProfileId: "182146",
          },
          reportedGrades: [{ value: "5.11a", system: "yds" as const }],
          climb: {
            externalId: "route",
            kind: "route" as const,
            name: "Corner",
            publishedGrades: [
              { value: "5.10a", system: "yds" as const },
              { value: "6a", system: "french" as const },
              { value: "A1", system: "aid" as const },
            ],
            coordinates: { latitude: 37.5, longitude: -122.25 },
            areas: [
              { externalId: "region", name: "Region" },
              {
                externalId: "wall",
                name: "Original wall",
                coordinates: { latitude: 0, longitude: 0 },
              },
            ],
            pitches: [
              {
                externalId: "p1",
                number: 1,
                publishedGrades: [{ value: "5.9", system: "yds" as const }],
              },
            ],
          },
          attempts:
            index === 0
              ? [
                  {
                    scope: "pitch" as const,
                    pitch: { externalId: "p1" },
                    sourceResult: "completed" as const,
                  },
                ]
              : [{ scope: "climb" as const }],
          reportedAttemptCounts:
            index === 0 ? [{ scope: "pitch" as const, pitch: { externalId: "p1" }, count: 2 }] : [],
        })),
      })
    ).logEntryIds;
    const foreign = await persistClimbingLogEntries(context.db, {
      userId: otherUserId,
      providerId: "mountain-project",
      entries: [
        {
          externalId: "foreign-log",
          climb: { externalId: "route", kind: "route", name: "Other owner's Corner" },
          attempts: [{ scope: "climb" }],
        },
      ],
    });
    foreignId = foreign.logEntryIds[0] ?? "";
    await context.db.execute(
      sql`UPDATE fitness.climbing_log_entry SET provider_absent_at = now() WHERE id = ${ids[0]}::uuid`,
    );
    await context.db.execute(
      sql`UPDATE fitness.area SET name = 'Current wall' WHERE user_id = ${userId}::uuid AND external_id = 'wall'`,
    );
  });
  afterAll(async () => {
    network.close();
    await client.close?.();
    await context?.cleanup();
  });

  it("counts logs independently of pitch attempt and grade joins, including a log-only provider", async () => {
    const stats = await new SyncRepository(context.db, userId, store).getProviderStats();
    expect(stats).toEqual([
      expect.objectContaining({
        providerId: "mountain-project",
        climbingLogEntries: 3,
        totalRecords: 3,
      }),
    ]);
    const repository = new ProviderDetailRepository(context.db, userId, store);
    expect(await repository.getAvailableDataTypes("mountain-project")).toContain(
      "climbingLogEntries",
    );
    const rows = await repository.getRecords("mountain-project", "climbingLogEntries", 10, 0);
    expect(rows.map((row) => row.id)).toEqual(ids);
    expect(rows[0]).toMatchObject({ name: "Corner", result: "Pitch completed" });
    expect(
      (
        await repository.getRecords("mountain-project", "climbingLogEntries", 10, 0, {
          climbed_on_from: "2026-10-02",
        })
      ).map((row) => row.id),
    ).toEqual([ids[0]]);
  });

  it("loads full owned pitch and grade details from a concise row", async () => {
    const repository = new ProviderDetailRepository(context.db, userId, store);
    const detail = await repository.getRecordDetail(
      "mountain-project",
      "climbingLogEntries",
      ids[0] ?? "",
    );
    expect(detail).toMatchObject({
      notes: "Recorded source note",
      providerAbsentAt: expect.any(String),
      reportedGrades: [{ value: "5.11a", system: "yds" }],
      recordedClimbAttemptCount: 0,
      recordedClimbOutcome: null,
      recordedPitchAttemptCount: 2,
      climb: {
        coordinates: { latitude: 37.5, longitude: -122.25 },
        publishedGrades: [
          { value: "5.10a", system: "yds" },
          { value: "6a", system: "french" },
          { value: "A1", system: "aid" },
        ],
        areaPath: [
          { name: "Region" },
          { name: "Current wall", coordinates: { latitude: 0, longitude: 0 } },
        ],
        pitches: [{ number: 1, publishedGrades: [{ value: "5.9", system: "yds" }] }],
      },
      attempts: expect.arrayContaining([
        expect.objectContaining({ scope: "pitch", outcome: "completed", attemptIndex: null }),
        expect.objectContaining({ scope: "pitch", outcome: null, attemptIndex: null }),
      ]),
      sourceLinks: expect.any(Array),
      raw: { sourceProfileId: "182146" },
    });
    expect(detail?.sourceLinks).toHaveLength(2);
    expect(
      await repository.getRecordDetail("openbeta", "climbingLogEntries", ids[0] ?? ""),
    ).toBeNull();
    expect(
      await repository.getRecordDetail("mountain-project", "climbingLogEntries", foreignId),
    ).toBeNull();
  });

  it("deletes the owned graph while preserving another provider's attached log and another user's graph", async () => {
    const activityId = randomUUID();
    const otherProviderActivityId = randomUUID();
    await context.db.execute(sql`INSERT INTO fitness.activity (id, provider_id, user_id, external_id, canonical_type, provider_type, started_at)
      VALUES (${otherProviderActivityId}::uuid, 'openbeta', ${userId}::uuid, ${otherProviderActivityId}, 'hiking', 'hiking', now())`);
    await context.db.execute(sql`INSERT INTO fitness.activity (id, provider_id, user_id, external_id, canonical_type, provider_type, started_at)
      VALUES (${activityId}::uuid, 'mountain-project', ${userId}::uuid, ${activityId}, 'climbing', 'climbing', now())`);
    const retained = await persistClimbingLogEntries(context.db, {
      userId,
      providerId: "openbeta",
      entries: [
        {
          externalId: "retained-log",
          activityId,
          climbedOn: "2026-10-01",
          attempts: [{ scope: "climb" }],
          climb: { externalId: "retained-route", name: "Retained route", kind: "route" },
        },
      ],
    });
    const request = await new ProviderDetailRepository(
      context.db,
      userId,
      store,
    ).requestProviderDataDeletion("mountain-project");
    expect(request).toMatchObject({ userId, providerId: "mountain-project", generation: 1 });
    const countSchema = z.object({
      logs: z.coerce.number(),
      climbs: z.coerce.number(),
      areas: z.coerce.number(),
      pitches: z.coerce.number(),
    });
    const [counts] = await executeWithSchema(
      context.db,
      countSchema,
      sql`SELECT
      (SELECT COUNT(*) FROM fitness.climbing_log_entry WHERE user_id = ${userId}::uuid AND provider_id = 'mountain-project') AS logs,
      (SELECT COUNT(*) FROM fitness.climb WHERE user_id = ${userId}::uuid AND provider_id = 'mountain-project') AS climbs,
      (SELECT COUNT(*) FROM fitness.area WHERE user_id = ${userId}::uuid AND provider_id = 'mountain-project') AS areas,
      (SELECT COUNT(*) FROM fitness.pitch JOIN fitness.climb ON climb.id = pitch.climb_id WHERE climb.user_id = ${userId}::uuid AND climb.provider_id = 'mountain-project') AS pitches`,
    );
    expect(counts).toEqual({ logs: 0, climbs: 0, areas: 0, pitches: 0 });
    expect(
      await executeWithSchema(
        context.db,
        z.object({ id: z.string() }),
        sql`SELECT id FROM fitness.activity WHERE id=${otherProviderActivityId}::uuid`,
      ),
    ).toEqual([{ id: otherProviderActivityId }]);
    const repository = new ProviderDetailRepository(context.db, userId, store);
    expect(
      await repository.getRecordDetail(
        "openbeta",
        "climbingLogEntries",
        retained.logEntryIds[0] ?? "",
      ),
    ).toMatchObject({
      activityId: null,
      climbedOn: "2026-10-01",
      climb: { name: "Retained route" },
    });
    expect(
      await new ProviderDetailRepository(context.db, otherUserId, store).getRecordDetail(
        "mountain-project",
        "climbingLogEntries",
        foreignId,
      ),
    ).toMatchObject({ providerId: "mountain-project" });
  });
});
