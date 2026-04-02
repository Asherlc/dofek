import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

vi.mock("dofek/db/schema", () => ({
  DEFAULT_USER_ID: "default-user-id",
}));

import { MissingEmailForSignupError, resolveOrCreateUser } from "./account-linking.ts";

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
      db.execute.mockResolvedValueOnce([]);

      const result = await resolveOrCreateUser(db, "google", identity, "logged-in-user");

      expect(result).toEqual({ userId: "logged-in-user", isNewUser: false });
      expect(db.execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("Step 2: existing auth_account lookup", () => {
    it("returns existing user when auth_account found", async () => {
      db.execute.mockResolvedValueOnce([{ user_id: "existing-user-1" }]);

      const result = await resolveOrCreateUser(db, "google", identity);

      expect(result).toEqual({ userId: "existing-user-1", isNewUser: false });
      expect(db.execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("Step 3: email-based auto-linking", () => {
    it("links to existing user by email match", async () => {
      db.execute.mockResolvedValueOnce([]);
      db.execute.mockResolvedValueOnce([{ id: "email-matched-user" }]);
      db.execute.mockResolvedValueOnce([]);

      const result = await resolveOrCreateUser(db, "google", identity);

      expect(result).toEqual({ userId: "email-matched-user", isNewUser: false });
      expect(db.execute).toHaveBeenCalledTimes(3);
    });

    it("skips email lookup when email is null", async () => {
      const noEmailIdentity = { ...identity, email: null };

      db.execute.mockResolvedValueOnce([]);
      db.execute.mockResolvedValueOnce([{ count: "5" }]);
      db.execute.mockResolvedValueOnce([{ id: "new-user-1" }]);
      db.execute.mockResolvedValueOnce([]);

      const result = await resolveOrCreateUser(db, "google", noEmailIdentity);

      expect(result.isNewUser).toBe(true);
    });

    it("requires email before creating a new user when configured", async () => {
      const noEmailIdentity = { ...identity, email: null };

      db.execute.mockResolvedValueOnce([]);

      await expect(
        resolveOrCreateUser(db, "strava", noEmailIdentity, undefined, {
          requireEmailForNewUser: true,
        }),
      ).rejects.toBeInstanceOf(MissingEmailForSignupError);
      expect(db.execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("Step 4: first-user migration", () => {
    it("claims DEFAULT_USER_ID when no auth accounts exist", async () => {
      // auth_account lookup - not found
      db.execute.mockResolvedValueOnce([]);
      // email match on user_profile - not found
      db.execute.mockResolvedValueOnce([]);
      // cross-provider email match on auth_account - not found
      db.execute.mockResolvedValueOnce([]);
      // account count - zero
      db.execute.mockResolvedValueOnce([{ count: "0" }]);
      // update user_profile with email/name
      db.execute.mockResolvedValueOnce([]);
      // upsertAuthAccount
      db.execute.mockResolvedValueOnce([]);

      const result = await resolveOrCreateUser(db, "google", identity);

      expect(result).toEqual({ userId: "default-user-id", isNewUser: true });
    });

    it("skips profile update when identity has no email or name", async () => {
      const bareIdentity = { providerAccountId: "bare-123", email: null, name: null };

      // auth_account lookup - not found
      db.execute.mockResolvedValueOnce([]);
      // skip email lookup (email is null)
      // skip cross-provider email match (email is null)
      // account count - zero
      db.execute.mockResolvedValueOnce([{ count: "0" }]);
      // upsertAuthAccount (no profile update since both are null)
      db.execute.mockResolvedValueOnce([]);

      const result = await resolveOrCreateUser(db, "google", bareIdentity);

      expect(result).toEqual({ userId: "default-user-id", isNewUser: true });
      expect(db.execute).toHaveBeenCalledTimes(3);
    });

    it("throws when account count query returns no rows", async () => {
      db.execute.mockResolvedValueOnce([]);
      db.execute.mockResolvedValueOnce([]);
      db.execute.mockResolvedValueOnce([]);
      db.execute.mockResolvedValueOnce([]);

      await expect(resolveOrCreateUser(db, "google", identity)).rejects.toThrow(
        "Failed to query account count",
      );
    });
  });

  describe("Step 3.5: cross-provider email matching via auth_account", () => {
    it("links to existing user when identity email matches another provider's auth_account email", async () => {
      const stravaIdentity = {
        providerAccountId: "strava-123",
        email: "strava@example.com",
        name: "Test User",
      };

      db.execute.mockResolvedValueOnce([]);
      db.execute.mockResolvedValueOnce([]);
      db.execute.mockResolvedValueOnce([{ user_id: "existing-user-1" }]);
      db.execute.mockResolvedValueOnce([]);

      const result = await resolveOrCreateUser(db, "strava", stravaIdentity);

      expect(result).toEqual({ userId: "existing-user-1", isNewUser: false });
    });

    it("skips auth_account email lookup when email is null", async () => {
      const noEmailIdentity = {
        providerAccountId: "strava-456",
        email: null,
        name: "No Email User",
      };

      db.execute.mockResolvedValueOnce([]);
      db.execute.mockResolvedValueOnce([{ count: "5" }]);
      db.execute.mockResolvedValueOnce([{ id: "new-user-1" }]);
      db.execute.mockResolvedValueOnce([]);

      const result = await resolveOrCreateUser(db, "strava", noEmailIdentity);

      expect(result).toEqual({ userId: "new-user-1", isNewUser: true });
    });

    it("falls through to user creation when no auth_account email match", async () => {
      db.execute.mockResolvedValueOnce([]);
      db.execute.mockResolvedValueOnce([]);
      db.execute.mockResolvedValueOnce([]);
      db.execute.mockResolvedValueOnce([{ count: "5" }]);
      db.execute.mockResolvedValueOnce([{ id: "new-user-2" }]);
      db.execute.mockResolvedValueOnce([]);

      const result = await resolveOrCreateUser(db, "google", identity);

      expect(result).toEqual({ userId: "new-user-2", isNewUser: true });
    });
  });

  describe("Step 4: new user creation", () => {
    it("creates a new user profile when no matches found", async () => {
      db.execute.mockResolvedValueOnce([]);
      db.execute.mockResolvedValueOnce([]);
      db.execute.mockResolvedValueOnce([]);
      db.execute.mockResolvedValueOnce([{ count: "5" }]);
      db.execute.mockResolvedValueOnce([{ id: "new-user-456" }]);
      db.execute.mockResolvedValueOnce([]);

      const result = await resolveOrCreateUser(db, "google", identity);

      expect(result).toEqual({ userId: "new-user-456", isNewUser: true });
    });

    it("throws when user profile creation returns no rows", async () => {
      db.execute.mockResolvedValueOnce([]);
      db.execute.mockResolvedValueOnce([]);
      db.execute.mockResolvedValueOnce([]);
      db.execute.mockResolvedValueOnce([{ count: "3" }]);
      db.execute.mockResolvedValueOnce([]);

      await expect(resolveOrCreateUser(db, "google", identity)).rejects.toThrow(
        "Failed to create user profile",
      );
    });

    it("uses 'User' as default name when identity has no name", async () => {
      const noNameIdentity = { ...identity, name: null };

      db.execute.mockResolvedValueOnce([]);
      db.execute.mockResolvedValueOnce([]);
      db.execute.mockResolvedValueOnce([]);
      db.execute.mockResolvedValueOnce([{ count: "2" }]);
      db.execute.mockResolvedValueOnce([{ id: "new-user-789" }]);
      db.execute.mockResolvedValueOnce([]);

      const result = await resolveOrCreateUser(db, "google", noNameIdentity);

      expect(result).toEqual({ userId: "new-user-789", isNewUser: true });
      expect(db.execute).toHaveBeenCalledTimes(6);
    });
  });
});
