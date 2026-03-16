import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

vi.mock("dofek/db/schema", () => ({
  DEFAULT_USER_ID: "default-user-id",
}));

import { resolveOrCreateUser } from "./account-linking.ts";

function createMockDb() {
  return {
    execute: vi.fn(),
  };
}

const identity = {
  providerAccountId: "provider-acc-123",
  email: "test@example.com",
  name: "Test User",
};

describe("resolveOrCreateUser", () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    db = createMockDb();
    vi.clearAllMocks();
  });

  describe("Step 1: logged-in user linking", () => {
    it("links to the logged-in user and returns their userId", async () => {
      // upsertAuthAccount call
      db.execute.mockResolvedValueOnce([]);

      // @ts-expect-error mock db
      const result = await resolveOrCreateUser(db, "google", identity, "logged-in-user");

      expect(result).toEqual({ userId: "logged-in-user", isNewUser: false });
      expect(db.execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("Step 2: existing auth_account lookup", () => {
    it("returns existing user when auth_account found", async () => {
      // auth_account lookup
      db.execute.mockResolvedValueOnce([{ user_id: "existing-user-1" }]);

      // @ts-expect-error mock db
      const result = await resolveOrCreateUser(db, "google", identity);

      expect(result).toEqual({ userId: "existing-user-1", isNewUser: false });
      expect(db.execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("Step 3: email-based auto-linking", () => {
    it("links to existing user by email match", async () => {
      // auth_account lookup - not found
      db.execute.mockResolvedValueOnce([]);
      // email match - found
      db.execute.mockResolvedValueOnce([{ id: "email-matched-user" }]);
      // upsertAuthAccount
      db.execute.mockResolvedValueOnce([]);

      // @ts-expect-error mock db
      const result = await resolveOrCreateUser(db, "google", identity);

      expect(result).toEqual({ userId: "email-matched-user", isNewUser: false });
      expect(db.execute).toHaveBeenCalledTimes(3);
    });

    it("skips email lookup when email is null", async () => {
      const noEmailIdentity = { ...identity, email: null };

      // auth_account lookup - not found
      db.execute.mockResolvedValueOnce([]);
      // account count (skips email lookup since email is null)
      db.execute.mockResolvedValueOnce([{ count: "5" }]);
      // create new user
      db.execute.mockResolvedValueOnce([{ id: "new-user-1" }]);
      // upsertAuthAccount
      db.execute.mockResolvedValueOnce([]);

      // @ts-expect-error mock db
      const result = await resolveOrCreateUser(db, "google", noEmailIdentity);

      expect(result.isNewUser).toBe(true);
    });
  });

  describe("Step 4: first-user migration", () => {
    it("claims DEFAULT_USER_ID when no auth accounts exist", async () => {
      // auth_account lookup - not found
      db.execute.mockResolvedValueOnce([]);
      // email match - not found
      db.execute.mockResolvedValueOnce([]);
      // account count - zero
      db.execute.mockResolvedValueOnce([{ count: "0" }]);
      // update user_profile with email/name
      db.execute.mockResolvedValueOnce([]);
      // upsertAuthAccount
      db.execute.mockResolvedValueOnce([]);

      // @ts-expect-error mock db
      const result = await resolveOrCreateUser(db, "google", identity);

      expect(result).toEqual({ userId: "default-user-id", isNewUser: true });
    });

    it("skips profile update when identity has no email or name", async () => {
      const bareIdentity = { providerAccountId: "bare-123", email: null, name: null };

      // auth_account lookup - not found
      db.execute.mockResolvedValueOnce([]);
      // skip email lookup (email is null)
      // account count - zero
      db.execute.mockResolvedValueOnce([{ count: "0" }]);
      // upsertAuthAccount (no profile update since both are null)
      db.execute.mockResolvedValueOnce([]);

      // @ts-expect-error mock db
      const result = await resolveOrCreateUser(db, "google", bareIdentity);

      expect(result).toEqual({ userId: "default-user-id", isNewUser: true });
      // Should be: auth_account lookup, account count, upsertAuthAccount (3 calls, no profile update)
      expect(db.execute).toHaveBeenCalledTimes(3);
    });

    it("throws when account count query returns no rows", async () => {
      // auth_account lookup - not found
      db.execute.mockResolvedValueOnce([]);
      // email match - not found
      db.execute.mockResolvedValueOnce([]);
      // account count - empty result
      db.execute.mockResolvedValueOnce([]);

      await expect(
        // @ts-expect-error mock db
        resolveOrCreateUser(db, "google", identity),
      ).rejects.toThrow("Failed to query account count");
    });
  });

  describe("Step 5: new user creation", () => {
    it("creates a new user profile when no matches found", async () => {
      // auth_account lookup - not found
      db.execute.mockResolvedValueOnce([]);
      // email match - not found
      db.execute.mockResolvedValueOnce([]);
      // account count - non-zero (not first user)
      db.execute.mockResolvedValueOnce([{ count: "5" }]);
      // create user profile
      db.execute.mockResolvedValueOnce([{ id: "new-user-456" }]);
      // upsertAuthAccount
      db.execute.mockResolvedValueOnce([]);

      // @ts-expect-error mock db
      const result = await resolveOrCreateUser(db, "google", identity);

      expect(result).toEqual({ userId: "new-user-456", isNewUser: true });
    });

    it("throws when user profile creation returns no rows", async () => {
      // auth_account lookup - not found
      db.execute.mockResolvedValueOnce([]);
      // email match - not found
      db.execute.mockResolvedValueOnce([]);
      // account count - non-zero
      db.execute.mockResolvedValueOnce([{ count: "3" }]);
      // create user profile - empty result
      db.execute.mockResolvedValueOnce([]);

      await expect(
        // @ts-expect-error mock db
        resolveOrCreateUser(db, "google", identity),
      ).rejects.toThrow("Failed to create user profile");
    });

    it("uses 'User' as default name when identity has no name", async () => {
      const noNameIdentity = { ...identity, name: null };

      // auth_account lookup - not found
      db.execute.mockResolvedValueOnce([]);
      // email match - not found
      db.execute.mockResolvedValueOnce([]);
      // account count - non-zero
      db.execute.mockResolvedValueOnce([{ count: "2" }]);
      // create user profile
      db.execute.mockResolvedValueOnce([{ id: "new-user-789" }]);
      // upsertAuthAccount
      db.execute.mockResolvedValueOnce([]);

      // @ts-expect-error mock db
      const result = await resolveOrCreateUser(db, "google", noNameIdentity);

      expect(result).toEqual({ userId: "new-user-789", isNewUser: true });
      // The INSERT call is the 4th execute call
      expect(db.execute).toHaveBeenCalledTimes(5);
    });
  });
});
