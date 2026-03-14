import type { Installation, InstallationQuery } from "@slack/bolt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  setupTestDatabase,
  type TestContext,
} from "../../../../../src/db/__tests__/test-helpers.ts";
import { createInstallationStore } from "../installation-store.ts";

describe("Slack Installation Store (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await ctx?.cleanup();
  });

  function makeInstallation(overrides: Partial<Installation> = {}): Installation {
    return {
      team: { id: "T-TEST-001", name: "Test Workspace" },
      enterprise: undefined,
      user: { id: "U-INSTALLER", token: undefined, scopes: undefined },
      bot: {
        token: "xoxb-test-bot-token",
        scopes: ["chat:write", "commands"],
        id: "B-BOT-001",
        userId: "U-BOT-001",
      },
      appId: "A-APP-001",
      tokenType: "bot",
      isEnterpriseInstall: false,
      ...overrides,
    } as Installation;
  }

  it("storeInstallation saves and fetchInstallation retrieves", async () => {
    const store = createInstallationStore(ctx.db);
    const installation = makeInstallation();

    await store.storeInstallation(installation);

    const query: InstallationQuery<false> = {
      teamId: "T-TEST-001",
      enterpriseId: undefined,
      isEnterpriseInstall: false,
    };
    const fetched = await store.fetchInstallation(query);

    expect(fetched.team?.id).toBe("T-TEST-001");
    expect(fetched.bot?.token).toBe("xoxb-test-bot-token");
    expect(fetched.appId).toBe("A-APP-001");
  });

  it("storeInstallation upserts on conflict (same team_id)", async () => {
    const store = createInstallationStore(ctx.db);

    await store.storeInstallation(makeInstallation());

    // Update with new bot token
    const updated = makeInstallation({
      bot: {
        token: "xoxb-updated-token",
        scopes: ["chat:write"],
        id: "B-BOT-002",
        userId: "U-BOT-002",
      },
    } as Partial<Installation>);
    await store.storeInstallation(updated);

    const query: InstallationQuery<false> = {
      teamId: "T-TEST-001",
      enterpriseId: undefined,
      isEnterpriseInstall: false,
    };
    const fetched = await store.fetchInstallation(query);
    expect(fetched.bot?.token).toBe("xoxb-updated-token");
  });

  it("storeInstallation throws when no team or enterprise ID", async () => {
    const store = createInstallationStore(ctx.db);
    const installation = makeInstallation();
    installation.team = undefined as never;

    await expect(store.storeInstallation(installation)).rejects.toThrow(
      "Cannot store installation without team or enterprise ID",
    );
  });

  it("storeInstallation throws when no bot token", async () => {
    const store = createInstallationStore(ctx.db);
    const installation = makeInstallation();
    installation.bot = undefined as never;

    await expect(store.storeInstallation(installation)).rejects.toThrow(
      "Cannot store installation without bot token",
    );
  });

  it("fetchInstallation throws for unknown team", async () => {
    const store = createInstallationStore(ctx.db);
    const query: InstallationQuery<false> = {
      teamId: "T-NONEXISTENT",
      enterpriseId: undefined,
      isEnterpriseInstall: false,
    };

    await expect(store.fetchInstallation(query)).rejects.toThrow(
      "No installation found for team T-NONEXISTENT",
    );
  });

  it("fetchInstallation throws when teamId is missing", async () => {
    const store = createInstallationStore(ctx.db);
    const query = {
      teamId: undefined,
      enterpriseId: undefined,
      isEnterpriseInstall: false,
    } as unknown as InstallationQuery<false>;

    await expect(store.fetchInstallation(query)).rejects.toThrow(
      "Cannot fetch installation without team ID",
    );
  });

  it("deleteInstallation removes the installation", async () => {
    const store = createInstallationStore(ctx.db);
    const teamId = "T-DELETE-ME";
    const installation = makeInstallation({
      team: { id: teamId, name: "Delete Me" },
    } as Partial<Installation>);

    await store.storeInstallation(installation);

    // Verify it exists
    const query: InstallationQuery<false> = {
      teamId,
      enterpriseId: undefined,
      isEnterpriseInstall: false,
    };
    const fetched = await store.fetchInstallation(query);
    expect(fetched.team?.id).toBe(teamId);

    // Delete it
    if (store.deleteInstallation) await store.deleteInstallation(query);

    // Verify it's gone
    await expect(store.fetchInstallation(query)).rejects.toThrow(
      `No installation found for team ${teamId}`,
    );
  });

  it("storeInstallation falls back to enterprise ID when team ID is missing", async () => {
    const store = createInstallationStore(ctx.db);
    const installation = {
      team: undefined,
      enterprise: { id: "E-ENTERPRISE-001", name: "Enterprise Corp" },
      user: { id: "U-INSTALLER", token: undefined, scopes: undefined },
      bot: {
        token: "xoxb-enterprise-token",
        scopes: ["chat:write"],
        id: "B-ENT-001",
        userId: "U-ENT-001",
      },
      appId: "A-ENT-001",
      tokenType: "bot",
      isEnterpriseInstall: true,
    } as unknown as Installation;

    await store.storeInstallation(installation);

    const query: InstallationQuery<false> = {
      teamId: "E-ENTERPRISE-001",
      enterpriseId: "E-ENTERPRISE-001",
      isEnterpriseInstall: false,
    };
    const fetched = await store.fetchInstallation(query);
    expect(fetched.bot?.token).toBe("xoxb-enterprise-token");
  });

  it("storeInstallation handles installation with minimal optional fields", async () => {
    const store = createInstallationStore(ctx.db);
    const installation = {
      team: { id: "T-MINIMAL-001" },
      user: { id: "U-MIN" },
      bot: {
        token: "xoxb-minimal",
        scopes: [],
      },
      tokenType: "bot",
      isEnterpriseInstall: false,
    } as unknown as Installation;

    await store.storeInstallation(installation);

    const query: InstallationQuery<false> = {
      teamId: "T-MINIMAL-001",
      enterpriseId: undefined,
      isEnterpriseInstall: false,
    };
    const fetched = await store.fetchInstallation(query);
    expect(fetched.bot?.token).toBe("xoxb-minimal");
  });

  it("deleteInstallation is a no-op when teamId is missing", async () => {
    const store = createInstallationStore(ctx.db);
    const query = {
      teamId: undefined,
      enterpriseId: undefined,
      isEnterpriseInstall: false,
    } as unknown as InstallationQuery<false>;

    // Should not throw
    if (store.deleteInstallation) await store.deleteInstallation(query);
  });
});
