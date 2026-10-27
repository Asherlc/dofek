import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";

describe("processing alert dismissals (integration)", () => {
  const userId = "10000000-0000-4000-8000-000000000001";
  const operationId = "10000000-0000-4000-8000-000000000010";
  const missingUserId = "10000000-0000-4000-8000-000000000099";
  const missingOperationId = "10000000-0000-4000-8000-000000000199";
  let testContext: TestContext;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    await testContext.db.execute(sql`
      INSERT INTO fitness.user_profile (id, name)
      VALUES (${userId}::uuid, 'Processing Alert User')
    `);
    await testContext.db.execute(sql`
      INSERT INTO fitness.processing_operation (
        id,
        user_id,
        provider_id,
        kind,
        external_correlation_key,
        dataset_keys
      )
      VALUES (
        ${operationId}::uuid,
        ${userId}::uuid,
        'apple_health',
        'provider_sync',
        'processing-alert-dismissal-test',
        ARRAY['recovery']::text[]
      )
    `);
  }, 120_000);

  afterAll(async () => {
    await testContext?.cleanup();
  });

  const insertDismissal = (dismissalUserId: string, dismissalOperationId: string) =>
    testContext.db.execute<{
      user_id: string;
      operation_id: string;
      dismissed_at: string;
    }>(sql`
      INSERT INTO fitness.processing_alert_dismissal (user_id, operation_id)
      VALUES (${dismissalUserId}::uuid, ${dismissalOperationId}::uuid)
      RETURNING user_id, operation_id, dismissed_at
    `);

  it("enforces duplicate and independent foreign-key constraints", async () => {
    await expect(insertDismissal(userId, operationId)).resolves.toHaveLength(1);
    await expect(insertDismissal(userId, operationId)).rejects.toThrow();
    await expect(insertDismissal(missingUserId, operationId)).rejects.toThrow();
    await expect(insertDismissal(userId, missingOperationId)).rejects.toThrow();

    const rows = await testContext.db.execute<{
      user_id: string;
      operation_id: string;
      dismissed_at: string;
    }>(sql`
      SELECT user_id, operation_id, dismissed_at
      FROM fitness.processing_alert_dismissal
      WHERE user_id = ${userId}::uuid
        AND operation_id = ${operationId}::uuid
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      user_id: userId,
      operation_id: operationId,
      dismissed_at: expect.any(String),
    });
  });
});
