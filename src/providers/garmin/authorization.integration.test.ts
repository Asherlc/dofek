import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createProviderDataDeletionRequest,
  markProviderDataDeletionCompleted,
} from "../../db/provider-data-deletion.ts";
import { userProfile } from "../../db/schema/reference.ts";
import {
  createTestBarrier,
  hasDatabaseLockWaiter,
  setupTestDatabase,
  type TestContext,
} from "../../db/test-helpers.ts";
import {
  deleteTokens,
  ensureProvider,
  findTokenUsersByProviderAccountId,
  loadTokens,
  saveTokens,
} from "../../db/tokens.ts";
import { assertGarminAuthorizationOwner, readGarminDeliveryState } from "./authorization.ts";

const TEST_USER_ID = "30000000-0000-4000-8000-000000000001";

describe("Garmin notification deletion fence", () => {
  let context: TestContext;
  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db
      .insert(userProfile)
      .values({ id: TEST_USER_ID, name: "Garmin delivery owner" });
    await ensureProvider(context.db, "garmin", "Garmin", undefined, TEST_USER_ID);
  }, 60_000);
  afterAll(async () => context?.cleanup());

  it("tracks deletion generations through completion without blocking another provider", async () => {
    expect(await readGarminDeliveryState(context.db, TEST_USER_ID)).toEqual({
      generation: 0,
      pendingDeletion: false,
    });
    await createProviderDataDeletionRequest(
      context.db,
      TEST_USER_ID,
      "garmin",
      "10000000-0000-4000-8000-000000000001",
    );
    expect(await readGarminDeliveryState(context.db, TEST_USER_ID)).toEqual({
      generation: 1,
      pendingDeletion: true,
    });
    await markProviderDataDeletionCompleted(context.db, "10000000-0000-4000-8000-000000000001");
    expect(await readGarminDeliveryState(context.db, TEST_USER_ID)).toEqual({
      generation: 1,
      pendingDeletion: false,
    });
    await ensureProvider(context.db, "wahoo", "Wahoo", undefined, TEST_USER_ID);
    await createProviderDataDeletionRequest(
      context.db,
      TEST_USER_ID,
      "wahoo",
      "10000000-0000-4000-8000-000000000002",
    );
    expect(await readGarminDeliveryState(context.db, TEST_USER_ID)).toEqual({
      generation: 1,
      pendingDeletion: false,
    });
  });
});

describe("exclusive Garmin authorization ownership", () => {
  let context: TestContext;
  const firstOwner = "30000000-0000-4000-8000-000000000002";
  const secondOwner = "30000000-0000-4000-8000-000000000003";
  const tokens = {
    accessToken: "official-access",
    refreshToken: "official-refresh",
    providerAccountId: "exclusive-garmin-account",
    authorizationId: "30000000-0000-4000-8000-000000000004",
    expiresAt: new Date("2099-01-01T00:00:00Z"),
    scopes: "ACTIVITY_EXPORT HEALTH_EXPORT",
  };

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.insert(userProfile).values([
      { id: firstOwner, name: "First Garmin owner" },
      { id: secondOwner, name: "Second Garmin owner" },
    ]);
  }, 60_000);
  afterAll(async () => context?.cleanup());
  beforeEach(async () => {
    await deleteTokens(context.db, "garmin", firstOwner);
    await deleteTokens(context.db, "garmin", secondOwner);
  });

  async function connect(userId: string, authorizationId = tokens.authorizationId) {
    await context.db.transaction(async (transaction) => {
      const next = { ...tokens, authorizationId };
      await assertGarminAuthorizationOwner(transaction, userId, next);
      await ensureProvider(transaction, "garmin", "Garmin", undefined, userId);
      await saveTokens(transaction, "garmin", next, userId);
    });
  }

  it("rejects another Dofek owner with an actionable conflict and permits the same owner to reconnect", async () => {
    await connect(firstOwner);
    await expect(connect(secondOwner)).rejects.toMatchObject({
      name: "ProviderAuthorizationAlreadyOwnedError",
      message: expect.stringContaining("another Dofek account"),
    });
    await connect(firstOwner, "30000000-0000-4000-8000-000000000005");
    expect(
      await findTokenUsersByProviderAccountId(context.db, "garmin", tokens.providerAccountId),
    ).toEqual([firstOwner]);
    expect(await loadTokens(context.db, "garmin", firstOwner)).toHaveProperty(
      "authorizationId",
      "30000000-0000-4000-8000-000000000005",
    );
  });

  it("serializes concurrent assignments with an account-scoped transaction lock", async () => {
    const entered = createTestBarrier();
    const release = createTestBarrier();
    const first = context.db.transaction(async (transaction) => {
      await assertGarminAuthorizationOwner(transaction, firstOwner, tokens);
      entered.resolve();
      await release.promise;
      await ensureProvider(transaction, "garmin", "Garmin", undefined, firstOwner);
      await saveTokens(transaction, "garmin", tokens, firstOwner);
    });
    const firstStarted = await Promise.race([
      entered.promise.then(() => true),
      first.then(
        () => false,
        () => false,
      ),
    ]);
    expect(firstStarted).toBe(true);
    const second = connect(secondOwner);
    const settled = Promise.allSettled([first, second]);
    try {
      await expect.poll(() => hasDatabaseLockWaiter(context.db)).toBe(true);
    } finally {
      release.resolve();
    }
    const outcomes = await settled;
    expect(outcomes[0]?.status).toBe("fulfilled");
    expect(outcomes[1]).toMatchObject({
      status: "rejected",
      reason: { name: "ProviderAuthorizationAlreadyOwnedError" },
    });
    expect(
      await findTokenUsersByProviderAccountId(context.db, "garmin", tokens.providerAccountId),
    ).toEqual([firstOwner]);
  });

  it("enforces the single-owner invariant for writers that bypass the connection hook", async () => {
    await connect(firstOwner);
    await ensureProvider(context.db, "garmin", "Garmin", undefined, secondOwner);
    await expect(saveTokens(context.db, "garmin", tokens, secondOwner)).rejects.toMatchObject({
      cause: { code: "23505", constraint: "oauth_token_garmin_account_owner_idx" },
    });
  });
});
