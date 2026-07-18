import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getProviderDataGenerations } from "./provider-data-deletion.ts";
import { providerDataGeneration } from "./schema/events.ts";
import { userProfile } from "./schema/reference.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";

const firstUserId = "10000000-0000-4000-8000-000000000001";
const secondUserId = "20000000-0000-4000-8000-000000000001";

describe("provider data deletion persistence (integration)", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.insert(userProfile).values([
      { id: firstUserId, name: "Generation Test User One" },
      { id: secondUserId, name: "Generation Test User Two" },
    ]);
    await context.db.insert(providerDataGeneration).values({
      currentGeneration: 4,
      providerId: "garmin",
      userId: firstUserId,
    });
  }, 120_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  it("loads existing and default provider generations in one batch", async () => {
    await expect(
      getProviderDataGenerations(context.db, [
        { providerId: "garmin", userId: firstUserId },
        { providerId: "coros", userId: secondUserId },
      ]),
    ).resolves.toEqual(
      expect.arrayContaining([
        { generation: 4, providerId: "garmin", userId: firstUserId },
        { generation: 0, providerId: "coros", userId: secondUserId },
      ]),
    );
  });
});
