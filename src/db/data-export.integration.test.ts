import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listQueuedDataExportRequests } from "./data-export.ts";
import { dataExport } from "./schema/account.ts";
import { userProfile } from "./schema/reference.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";

const userId = "10000000-0000-4000-8000-000000000025";
const olderQueuedExportId = "20000000-0000-4000-8000-000000000025";
const newerQueuedExportId = "30000000-0000-4000-8000-000000000025";
const fencedUserId = "60000000-0000-4000-8000-000000000025";
const fencedExportId = "70000000-0000-4000-8000-000000000025";

describe("data export persistence (integration)", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.insert(userProfile).values({ id: userId, name: "Export Outbox Test User" });
    await context.db.insert(dataExport).values([
      {
        createdAt: new Date("2026-07-24T10:00:00.000Z"),
        expiresAt: new Date("2026-07-31T10:00:00.000Z"),
        filename: "dofek-export.zip",
        id: olderQueuedExportId,
        status: "queued",
        userId,
      },
      {
        createdAt: new Date("2026-07-24T11:00:00.000Z"),
        expiresAt: new Date("2026-07-31T11:00:00.000Z"),
        filename: "dofek-export.zip",
        id: newerQueuedExportId,
        status: "queued",
        userId,
      },
      {
        expiresAt: new Date("2026-07-31T12:00:00.000Z"),
        filename: "dofek-export.zip",
        id: "40000000-0000-4000-8000-000000000025",
        status: "processing",
        userId,
      },
      {
        expiresAt: new Date("2026-07-31T13:00:00.000Z"),
        filename: "dofek-export.zip",
        id: "50000000-0000-4000-8000-000000000025",
        status: "failed",
        userId,
      },
    ]);
  }, 120_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  it("lists committed queued exports in stable order and honors the batch limit", async () => {
    await expect(listQueuedDataExportRequests(context.db, 1)).resolves.toEqual([
      { exportId: olderQueuedExportId, userId },
    ]);
    await expect(listQueuedDataExportRequests(context.db, 10)).resolves.toEqual([
      { exportId: olderQueuedExportId, userId },
      { exportId: newerQueuedExportId, userId },
    ]);
  });

  it("excludes queued exports owned by an account being erased", async () => {
    await context.db.insert(userProfile).values({
      id: fencedUserId,
      name: "Fenced Export Outbox Test User",
    });
    await context.db.insert(dataExport).values({
      createdAt: new Date("2026-07-24T09:00:00.000Z"),
      expiresAt: new Date("2026-07-31T09:00:00.000Z"),
      filename: "dofek-export.zip",
      id: fencedExportId,
      status: "queued",
      userId: fencedUserId,
    });
    await context.db.execute(
      sql`INSERT INTO fitness.account_erasure_request (
            id,
            user_id,
            user_hash,
            user_hash_key_id,
            write_fence_hash,
            status_token_hash,
            replay_retained_until,
            completion_deadline
          )
          VALUES (
            '80000000-0000-4000-8000-000000000025',
            ${fencedUserId}::uuid,
            ${"a".repeat(64)},
            'test-key',
            ${"b".repeat(64)},
            ${"c".repeat(64)},
            now() + interval '7 days',
            now() + interval '30 days'
          )`,
    );

    const requests = await listQueuedDataExportRequests(context.db, 10);

    expect(requests).not.toContainEqual({ exportId: fencedExportId, userId: fencedUserId });
    expect(requests).toContainEqual({ exportId: olderQueuedExportId, userId });
  });
});
