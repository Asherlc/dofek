import { describe, expect, it, vi } from "vitest";
import { AuthRepository } from "./auth-repository.ts";

describe("AuthRepository", () => {
  function makeRepository(rows: Record<string, unknown>[] = []) {
    const execute = vi.fn().mockResolvedValue(rows);
    const repo = new AuthRepository({ execute }, "user-1");
    return { repo, execute };
  }

  describe("getLinkedAccounts", () => {
    it("returns empty array when no accounts linked", async () => {
      const { repo } = makeRepository([]);
      expect(await repo.getLinkedAccounts()).toEqual([]);
    });

    it("maps snake_case DB rows to camelCase LinkedAccount objects", async () => {
      const { repo } = makeRepository([
        {
          id: "acc-1",
          auth_provider: "google",
          email: "user@example.com",
          name: "Test User",
          created_at: "2025-01-10T08:00:00Z",
        },
        {
          id: "acc-2",
          auth_provider: "apple",
          email: null,
          name: null,
          created_at: "2025-01-15T12:00:00Z",
        },
      ]);
      const result = await repo.getLinkedAccounts();
      expect(result).toEqual([
        {
          id: "acc-1",
          authProvider: "google",
          email: "user@example.com",
          name: "Test User",
          createdAt: "2025-01-10T08:00:00.000Z",
        },
        {
          id: "acc-2",
          authProvider: "apple",
          email: null,
          name: null,
          createdAt: "2025-01-15T12:00:00.000Z",
        },
      ]);
    });

    it("handles Date objects from postgres driver (Linux/ARM)", async () => {
      const { repo } = makeRepository([
        {
          id: "acc-1",
          auth_provider: "google",
          email: "user@example.com",
          name: "Test User",
          created_at: new Date("2025-01-10T08:00:00Z"),
        },
      ]);
      const result = await repo.getLinkedAccounts();
      expect(result[0]?.createdAt).toBe("2025-01-10T08:00:00.000Z");
    });
  });

  describe("getAccountCount", () => {
    it("returns 0 when no accounts exist", async () => {
      const { repo } = makeRepository([{ count: "0" }]);
      expect(await repo.getAccountCount()).toBe(0);
    });

    it("returns the count as a number", async () => {
      const { repo } = makeRepository([{ count: "3" }]);
      expect(await repo.getAccountCount()).toBe(3);
    });

    it("returns 0 when query returns empty results", async () => {
      const { repo } = makeRepository([]);
      expect(await repo.getAccountCount()).toBe(0);
    });

    it("returns exactly 0 (not just falsy) for empty results", async () => {
      const { repo } = makeRepository([]);
      expect(await repo.getAccountCount()).toStrictEqual(0);
    });
  });

  describe("deleteAccount", () => {
    it("returns deleted account id on success", async () => {
      const { repo } = makeRepository([{ id: "acc-1" }]);
      expect(await repo.deleteAccount("acc-1")).toBe("acc-1");
    });

    it("returns null when account not found", async () => {
      const { repo } = makeRepository([]);
      expect(await repo.deleteAccount("nonexistent")).toBeNull();
    });

    it("returns exactly null (not undefined) when account not found", async () => {
      const { repo } = makeRepository([]);
      expect(await repo.deleteAccount("x")).toStrictEqual(null);
    });

    it("calls execute once", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.deleteAccount("acc-1");
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });
});
