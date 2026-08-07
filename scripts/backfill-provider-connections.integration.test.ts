import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../src/db/test-helpers.ts";
import { backfillProviderConnections } from "./backfill-provider-connections.ts";

describe("provider connection backfill", () => {
  let context: TestContext;
  let client: Client;

  beforeAll(async () => {
    context = await setupTestDatabase();
    client = new Client({ connectionString: context.connectionString });
    await client.connect();
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await context?.cleanup();
  });

  it("backfills every ownership source, cuts over integrity, and resumes idempotently", async () => {
    const firstUserId = "71717171-7171-4171-8171-717171717171";
    const secondUserId = "72727272-7272-4272-8272-727272727272";
    await client.query(
      `INSERT INTO fitness.user_profile (id, name)
       VALUES ($1, 'Legacy owner'), ($2, 'OAuth and child owner')`,
      [firstUserId, secondUserId],
    );
    await client.query(
      `INSERT INTO fitness.provider (id, name, user_id)
       VALUES
         ('legacy-owner-source', 'Legacy owner source', $1),
         ('oauth-owner-source', 'OAuth owner source', NULL),
         ('child-owner-source', 'Child owner source', NULL)`,
      [firstUserId],
    );
    await client.query(
      `INSERT INTO fitness.oauth_token (provider_id, user_id, access_token, expires_at)
       VALUES ('oauth-owner-source', $1, 'encrypted-token', now() + interval '1 hour')`,
      [secondUserId],
    );
    await client.query(
      `INSERT INTO fitness.activity (
         provider_id, user_id, external_id, canonical_type, provider_type, started_at
       ) VALUES ('child-owner-source', $1, 'child-source-activity', 'running', 'running', now())`,
      [secondUserId],
    );

    const firstRun = await backfillProviderConnections(client);

    expect(firstRun.connectionsInserted).toBeGreaterThanOrEqual(3);
    const connectionResult = await client.query(
      `SELECT user_id::text, provider_id
       FROM fitness.provider_connection
       WHERE provider_id IN ('legacy-owner-source', 'oauth-owner-source', 'child-owner-source')
       ORDER BY provider_id`,
    );
    expect(connectionResult.rows).toEqual([
      { user_id: secondUserId, provider_id: "child-owner-source" },
      { user_id: firstUserId, provider_id: "legacy-owner-source" },
      { user_id: secondUserId, provider_id: "oauth-owner-source" },
    ]);
    const catalogOwnerResult = await client.query(
      `SELECT user_id
       FROM fitness.provider
       WHERE id = 'legacy-owner-source'`,
    );
    expect(catalogOwnerResult.rows).toEqual([{ user_id: null }]);

    const constraintResult = await client.query(
      `SELECT conname, convalidated
       FROM pg_constraint
       WHERE conname IN (
         'oauth_token_provider_connection_fkey',
         'webhook_subscription_provider_connection_fkey'
       )
       ORDER BY conname`,
    );
    expect(constraintResult.rows).toEqual([
      { conname: "oauth_token_provider_connection_fkey", convalidated: true },
      { conname: "webhook_subscription_provider_connection_fkey", convalidated: true },
    ]);

    const secondRun = await backfillProviderConnections(client);
    expect(secondRun.connectionsInserted).toBe(0);

    await expect(
      client.query(
        `INSERT INTO fitness.oauth_token (provider_id, user_id, access_token, expires_at)
         VALUES ('legacy-owner-source', $1, 'orphan-token', now() + interval '1 hour')`,
        [secondUserId],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      client.query(
        `INSERT INTO fitness.webhook_subscription (
           user_id, provider_id, provider_name, subscription_external_id,
           verify_token, status
         ) VALUES ($1, 'legacy-owner-source', 'legacy-owner-source', 'orphan-webhook', 'token', 'active')`,
        [secondUserId],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      client.query("DELETE FROM fitness.user_profile WHERE id = $1", [firstUserId]),
    ).resolves.toMatchObject({ rowCount: 1 });
  });
});
