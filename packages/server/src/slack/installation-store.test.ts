import { describe, expect, it, vi } from "vitest";

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { createInstallationStore } from "./installation-store.ts";

function mockDb(rows: Record<string, unknown>[] = []) {
  return { execute: vi.fn().mockResolvedValue(rows) };
}

describe("createInstallationStore", () => {
  describe("storeInstallation", () => {
    it("stores installation with team ID", async () => {
      const db = mockDb();
      const store = createInstallationStore(db);
      await store.storeInstallation({
        team: { id: "T123", name: "Test Team" },
        bot: { token: "xoxb-fake", id: "B1", userId: "U1" },
        user: { id: "U1", token: "xoxp-fake", scopes: ["chat:write"] },
        appId: "A123",
      });
      expect(db.execute).toHaveBeenCalledOnce();
    });

    it("stores installation with enterprise ID when no team", async () => {
      const db = mockDb();
      const store = createInstallationStore(db);
      await store.storeInstallation({
        enterprise: { id: "E456", name: "Enterprise" },
        bot: { token: "xoxb-fake" },
        user: { id: "U1" },
      });
      expect(db.execute).toHaveBeenCalledOnce();
    });

    it("throws when neither team nor enterprise ID", async () => {
      const db = mockDb();
      const store = createInstallationStore(db);
      await expect(
        store.storeInstallation({
          user: { id: "U1" },
          bot: { token: "xoxb-fake" },
        }),
      ).rejects.toThrow("Cannot store installation without team or enterprise ID");
    });

    it("throws when no bot token", async () => {
      const db = mockDb();
      const store = createInstallationStore(db);
      await expect(
        store.storeInstallation({
          team: { id: "T123" },
          user: { id: "U1" },
        }),
      ).rejects.toThrow("Cannot store installation without bot token");
    });
  });

  describe("fetchInstallation", () => {
    it("returns parsed installation from DB", async () => {
      const rawInstallation = {
        team: { id: "T123", name: "Test" },
        bot: { token: "xoxb-fake", id: "B1", userId: "U1" },
        user: { id: "U1" },
        appId: "A123",
      };
      const db = mockDb([{ raw_installation: JSON.stringify(rawInstallation) }]);
      const store = createInstallationStore(db);
      const result = await store.fetchInstallation({ teamId: "T123", isEnterpriseInstall: false });
      expect(result.team?.id).toBe("T123");
      expect(result.bot?.token).toBe("xoxb-fake");
    });

    it("handles raw_installation as object (not string)", async () => {
      const rawInstallation = {
        team: { id: "T123" },
        bot: { token: "xoxb-fake" },
        user: { id: "U1" },
      };
      const db = mockDb([{ raw_installation: rawInstallation }]);
      const store = createInstallationStore(db);
      const result = await store.fetchInstallation({ teamId: "T123", isEnterpriseInstall: false });
      expect(result.team?.id).toBe("T123");
    });

    it("throws when no team ID provided", async () => {
      const db = mockDb();
      const store = createInstallationStore(db);
      await expect(
        store.fetchInstallation({ teamId: undefined, isEnterpriseInstall: false }),
      ).rejects.toThrow("Cannot fetch installation without team ID");
    });

    it("throws when no installation found", async () => {
      const db = mockDb([]);
      const store = createInstallationStore(db);
      await expect(
        store.fetchInstallation({ teamId: "T999", isEnterpriseInstall: false }),
      ).rejects.toThrow("No installation found for team T999");
    });
  });

  describe("deleteInstallation", () => {
    it("deletes installation by team ID", async () => {
      const db = mockDb();
      const store = createInstallationStore(db);
      await store.deleteInstallation?.({ teamId: "T123", isEnterpriseInstall: false });
      expect(db.execute).toHaveBeenCalledOnce();
    });

    it("no-ops when team ID is undefined", async () => {
      const db = mockDb();
      const store = createInstallationStore(db);
      await store.deleteInstallation?.({ teamId: undefined, isEnterpriseInstall: false });
      expect(db.execute).not.toHaveBeenCalled();
    });
  });
});
