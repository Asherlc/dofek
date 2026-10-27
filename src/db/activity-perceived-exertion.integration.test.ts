import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";

const USER_ID = "10000000-0000-4000-8000-000000002247";
const ACTIVITY_ID = "20000000-0000-4000-8000-000000002247";

describe("activity perceived exertion persistence (integration)", () => {
  let context: TestContext;
  let client: Client;

  beforeAll(async () => {
    context = await setupTestDatabase();
    client = new Client({ connectionString: context.connectionString });
    await client.connect();
    await client.query(
      "INSERT INTO fitness.user_profile (id, name) VALUES ($1, 'Activity Test User')",
      [USER_ID],
    );
    await client.query(
      "INSERT INTO fitness.provider (id, name) VALUES ('activity-fixture', 'Activity Fixture')",
    );
    await client.query(
      `INSERT INTO fitness.activity (
         id, user_id, provider_id, external_id, provider_type, canonical_type, started_at
       )
       VALUES ($1, $2, 'activity-fixture', 'activity-2247', 'running', 'running', NOW())`,
      [ACTIVITY_ID, USER_ID],
    );
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await context?.cleanup();
  });

  it("rejects out-of-range activity RPE", async () => {
    await expect(
      client.query("UPDATE fitness.activity SET perceived_exertion = 10.1 WHERE id = $1", [
        ACTIVITY_ID,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
