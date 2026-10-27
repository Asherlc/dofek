import { inArray, sql } from "drizzle-orm";
import { area, climb, climbingLogEntry } from "./schema/climbing.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";

export const CLIMBING_SYNC_PROVIDER_ID = "climbing-sync-test";
export const CLIMBING_SYNC_OTHER_PROVIDER_ID = "climbing-sync-other";
export const CLIMBING_SYNC_OTHER_USER_ID = "00000000-0000-4000-8000-000000001997";

export async function createClimbingLogSyncTestContext(): Promise<TestContext> {
  const context = await setupTestDatabase();
  await context.db.execute(sql`
    INSERT INTO fitness.provider (id, name) VALUES
    (${CLIMBING_SYNC_PROVIDER_ID}, 'Climbing sync test'),
    (${CLIMBING_SYNC_OTHER_PROVIDER_ID}, 'Other climbing sync test')
  `);
  await context.db.execute(sql`
    INSERT INTO fitness.user_profile (id, name)
    VALUES (${CLIMBING_SYNC_OTHER_USER_ID}::uuid, 'Other climbing owner')
  `);
  return context;
}

export async function clearClimbingLogSyncTestContext(context: TestContext): Promise<void> {
  const providers = [CLIMBING_SYNC_PROVIDER_ID, CLIMBING_SYNC_OTHER_PROVIDER_ID];
  await context.db.delete(climbingLogEntry).where(inArray(climbingLogEntry.providerId, providers));
  await context.db.delete(climb).where(inArray(climb.providerId, providers));
  await context.db.update(area).set({ parentAreaId: null });
  await context.db.delete(area).where(inArray(area.providerId, providers));
}
