import { queryCache } from "dofek/lib/cache";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { createApp } from "../index.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { makeMockSensorStore } from "./test-helpers.ts";

describe("Activity primary-source titles", () => {
  let context: TestContext;
  let server: ReturnType<import("express").Express["listen"]>;
  let baseUrl: string;
  let sessionCookie: string;
  const groupId = "00000000-0000-4000-8000-000000000701";
  const primaryId = "00000000-0000-4000-8000-000000000702";
  const representativeId = "00000000-0000-4000-8000-000000000703";

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(sql`INSERT INTO fitness.provider (id, name, user_id)
      VALUES ('apple_health', 'Apple Health', ${TEST_USER_ID}),
        ('whoop', 'WHOOP', ${TEST_USER_ID})
      ON CONFLICT DO NOTHING`);
    const session = await createSession(context.db, TEST_USER_ID);
    sessionCookie = `session=${session.sessionId}`;
    const app = createApp(context.db, makeMockSensorStore());
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address();
        if (typeof address !== "object" || address === null) {
          throw new Error("Activity title test server did not expose a port");
        }
        baseUrl = `http://localhost:${address.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await context?.cleanup();
  });

  it.each([
    { primaryName: null, expectedName: null, description: "has no title" },
    { primaryName: "", expectedName: null, description: "has an empty title" },
    { primaryName: "   ", expectedName: null, description: "has a whitespace-only title" },
    { primaryName: "Evening Run", expectedName: "Evening Run", description: "has a title" },
    {
      primaryName: "  Evening Run  ",
      expectedName: "  Evening Run  ",
      description: "has a title with surrounding whitespace",
    },
  ])(
    "follows the resolved primary source when it $description",
    async ({ primaryName, expectedName }) => {
      await context.db.execute(sql`INSERT INTO fitness.activity_group (id, user_id)
      VALUES (${groupId}::uuid, ${TEST_USER_ID})`);
      await context.db.execute(sql`INSERT INTO fitness.activity (
      id, group_id, user_id, provider_id, external_id, canonical_type, provider_type,
      started_at, ended_at, name, source_name, raw
    ) VALUES
      (${primaryId}::uuid, ${groupId}::uuid, ${TEST_USER_ID}, 'apple_health',
       'primary-title-watch', 'running', 'running',
       '2026-10-26T22:11:00Z', '2026-10-26T22:52:00Z',
       ${primaryName}, 'Asher’s Apple Watch', '{"sourceName":"Asher’s Apple Watch"}'),
      (${representativeId}::uuid, ${groupId}::uuid, ${TEST_USER_ID}, 'whoop',
       'secondary-title-whoop', 'walking', 'walking',
       '2026-10-26T22:11:00Z', '2026-10-26T22:51:58Z',
       '40 min 58 sec Walking', NULL, '{}')`);

      try {
        const projection = await executeWithSchema(
          context.db,
          z.object({
            representative_activity_id: z.string(),
            primary_activity_id: z.string(),
          }),
          sql`SELECT representative_activity_id::text, primary_activity_id::text
          FROM fitness.v_activity WHERE id = ${groupId}::uuid`,
        );
        expect(projection).toEqual([
          { representative_activity_id: representativeId, primary_activity_id: primaryId },
        ]);
        await queryCache.invalidateAll();

        for (const activityId of [groupId, primaryId, representativeId]) {
          const response = await fetch(`${baseUrl}/api/trpc/activity.byId?batch=1`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: sessionCookie },
            body: JSON.stringify({ "0": { id: activityId } }),
          });
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject([
            {
              result: {
                data: {
                  id: groupId,
                  name: expectedName,
                  activityType: "walking",
                  primaryActivityType: "running",
                  sourceDecision: {
                    origin: {
                      status: "resolved",
                      memberActivityId: primaryId,
                      providerId: "apple_health",
                    },
                  },
                },
              },
            },
          ]);
        }

        const listResponse = await fetch(`${baseUrl}/api/trpc/activity.list?batch=1`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: sessionCookie },
          body: JSON.stringify({ "0": { days: 7, endDate: "2026-10-26", limit: 20, offset: 0 } }),
        });
        expect(listResponse.status).toBe(200);
        expect(await listResponse.json()).toMatchObject([
          {
            result: {
              data: {
                items: [
                  {
                    id: groupId,
                    name: expectedName,
                    canonical_type: "walking",
                    primary_canonical_type: "running",
                  },
                ],
              },
            },
          },
        ]);
      } finally {
        await context.db.execute(
          sql`DELETE FROM fitness.activity WHERE group_id = ${groupId}::uuid`,
        );
        await context.db.execute(
          sql`DELETE FROM fitness.activity_group WHERE id = ${groupId}::uuid`,
        );
        await queryCache.invalidateAll();
      }
    },
  );
});
