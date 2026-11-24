import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { TokenSet } from "../../auth/oauth.ts";
import { runWithProviderUserIngestContext } from "../../db/provider-ingest-context.ts";
import { activity } from "../../db/schema/activity.ts";
import { userProfile } from "../../db/schema/reference.ts";
import { setupTestDatabase, type TestContext } from "../../db/test-helpers.ts";
import { connectProviderWithTokens } from "../../db/tokens.ts";
import { createIntegrationMswFixture } from "../../test/early-msw-lifecycle.ts";
import { failOnUnhandledExternalRequest } from "../../test/msw.ts";
import { SyncRun } from "../sync-run.ts";
import { SyncWindow } from "../sync-window.ts";
import { createTrailforksMswHarness } from "./msw-test-helpers.ts";
import { TrailforksProvider } from "./provider.ts";

const TRAILFORKS_PROVIDER = {
  id: "trailforks",
  name: "Trailforks",
  apiBaseUrl: "https://www.trailforks.com/mcp/account/",
};

/** Synthetic fixture — not an observed Trailforks MCP encoding. */
const SYNTHETIC_IN_WINDOW = {
  id: 42_001,
  title: "Synthetic Squamish loop",
  started_at: "2026-09-19T16:30:00-07:00",
  ended_at: "2026-09-19T18:00:00-07:00",
  activitytype: 1,
  link: "https://www.trailforks.com/ridelog/view/42001/",
};

const SYNTHETIC_OUT_OF_WINDOW = {
  id: 42_002,
  title: "Outside window",
  started_at: "2026-08-01T10:00:00Z",
  activitytype: 6,
};

const SYNTHETIC_SPARSE_REPLAY = {
  id: 42_001,
  started_at: "2026-09-19T16:30:00-07:00",
  link: "https://www.trailforks.com/ridelog/view/42001/",
};

const server = createIntegrationMswFixture();

function tokensFor(label: string): TokenSet {
  return {
    accessToken: `synthetic-trailforks-access-${label}`,
    refreshToken: `synthetic-trailforks-refresh-${label}`,
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    providerAccountId: `synthetic-trailforks-account-${label}`,
    scopes: "activities:read",
  };
}

async function createConnectedUser(label: string = randomUUID()): Promise<{
  userId: string;
  tokens: TokenSet;
}> {
  const userId = randomUUID();
  const tokens = tokensFor(label);
  await context.db.insert(userProfile).values({ id: userId, name: `Trailforks tester ${label}` });
  await connectProviderWithTokens(context.db, TRAILFORKS_PROVIDER, tokens, userId);
  return { userId, tokens };
}

async function sync(
  userId: string,
  provider: TrailforksProvider,
  options?: { ambientUserId?: string },
) {
  const ambientUserId = options?.ambientUserId ?? userId;
  return runWithProviderUserIngestContext(ambientUserId, { homeTimezone: null }, () =>
    provider.sync(
      new SyncRun({
        db: context.db,
        window: SyncWindow.fromDateRange({
          sinceDate: "2026-09-01",
          untilDate: "2026-09-30",
        }),
        userId,
      }),
    ),
  );
}

async function activitiesFor(userId: string) {
  return context.db
    .select()
    .from(activity)
    .where(and(eq(activity.userId, userId), eq(activity.providerId, "trailforks")))
    .orderBy(activity.externalId);
}

let context: TestContext;
const originalClientId = process.env.TRAILFORKS_CLIENT_ID;
const originalRedirectUri = process.env.OAUTH_REDIRECT_URI;

describe("TrailforksProvider.sync (PostgreSQL + MCP protocol)", { concurrent: false }, () => {
  beforeAll(async () => {
    process.env.TRAILFORKS_CLIENT_ID = "trailforks-integration-client";
    process.env.OAUTH_REDIRECT_URI = "https://dofek.example.test/oauth/callback";
    server.activate({ onUnhandledFrame: failOnUnhandledExternalRequest });
    context = await setupTestDatabase();
  }, 120_000);

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(async () => {
    server.deactivate();
    await context?.cleanup();
    if (originalClientId === undefined) delete process.env.TRAILFORKS_CLIENT_ID;
    else process.env.TRAILFORKS_CLIENT_ID = originalClientId;
    if (originalRedirectUri === undefined) delete process.env.OAUTH_REDIRECT_URI;
    else process.env.OAUTH_REDIRECT_URI = originalRedirectUri;
  });

  it("upserts in-window activities idempotently and skips out-of-window rows", async () => {
    const { userId, tokens } = await createConnectedUser("idempotent");
    const harness = createTrailforksMswHarness(() => ({
      content: [],
      structuredContent: { activities: [SYNTHETIC_IN_WINDOW, SYNTHETIC_OUT_OF_WINDOW] },
    }));
    server.use(harness.handler);
    const provider = new TrailforksProvider();

    const first = await sync(userId, provider);
    const second = await sync(userId, provider);
    const rows = await activitiesFor(userId);

    expect(first.recordsSynced).toBe(1);
    expect(first.errors).toEqual([]);
    expect(second.recordsSynced).toBe(1);
    expect(second.errors).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      externalId: "42001",
      name: "Synthetic Squamish loop",
      providerId: "trailforks",
      canonicalType: "cycling",
      modality: "mountain",
    });
    expect(rows[0]?.endedAt?.toISOString()).toBe(
      new Date(SYNTHETIC_IN_WINDOW.ended_at).toISOString(),
    );
    expect(rows[0]?.raw).toEqual(SYNTHETIC_IN_WINDOW);
    expect(harness.requests.filter((request) => request.method === "tools/call")).toEqual([
      expect.objectContaining({
        toolName: "list_my_activities",
        toolArguments: {},
        bearer: `Bearer ${tokens.accessToken}`,
      }),
      expect.objectContaining({
        toolName: "list_my_activities",
        toolArguments: {},
      }),
    ]);
  });

  it("retains known title/end/sport when a sparse replay omits them", async () => {
    const { userId } = await createConnectedUser("sparse");
    const rich = createTrailforksMswHarness(() => ({
      content: [],
      structuredContent: { activities: [SYNTHETIC_IN_WINDOW] },
    }));
    server.use(rich.handler);
    const provider = new TrailforksProvider();
    await sync(userId, provider);

    server.resetHandlers();
    const sparse = createTrailforksMswHarness(() => ({
      content: [],
      structuredContent: { activities: [SYNTHETIC_SPARSE_REPLAY] },
    }));
    server.use(sparse.handler);

    const result = await sync(userId, provider);
    const rows = await activitiesFor(userId);

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      externalId: "42001",
      name: "Synthetic Squamish loop",
      canonicalType: "cycling",
      modality: "mountain",
    });
    expect(rows[0]?.endedAt?.toISOString()).toBe(
      new Date(SYNTHETIC_IN_WINDOW.ended_at).toISOString(),
    );
    expect(rows[0]?.raw).toEqual(SYNTHETIC_SPARSE_REPLAY);
  });

  it("clears stored title and end time when a refresh sends explicit nulls", async () => {
    const { userId } = await createConnectedUser("null-clear");
    const rich = createTrailforksMswHarness(() => ({
      content: [],
      structuredContent: { activities: [SYNTHETIC_IN_WINDOW] },
    }));
    server.use(rich.handler);
    const provider = new TrailforksProvider();
    await sync(userId, provider);

    server.resetHandlers();
    const cleared = createTrailforksMswHarness(() => ({
      content: [],
      structuredContent: {
        activities: [
          {
            id: 42_001,
            title: null,
            started_at: "2026-09-19T16:30:00-07:00",
            ended_at: null,
            activitytype: 1,
            link: "https://www.trailforks.com/ridelog/view/42001/",
          },
        ],
      },
    }));
    server.use(cleared.handler);

    const result = await sync(userId, provider);
    const rows = await activitiesFor(userId);

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      externalId: "42001",
      name: null,
      endedAt: null,
      canonicalType: "cycling",
      modality: "mountain",
    });
  });

  it("writes nothing when tokens are missing", async () => {
    const userId = randomUUID();
    await context.db.insert(userProfile).values({ id: userId, name: "Disconnected Trailforks" });
    const harness = createTrailforksMswHarness(() => ({
      content: [],
      structuredContent: { activities: [SYNTHETIC_IN_WINDOW] },
    }));
    server.use(harness.handler);

    const result = await sync(userId, new TrailforksProvider());

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toBe("Trailforks is not connected.");
    expect(result.errors[0]?.cause).toBeUndefined();
    expect(await activitiesFor(userId)).toEqual([]);
    expect(harness.requests).toEqual([]);
  });

  it("scopes upserts with distinct tokens and MCP responses per user", async () => {
    const userA = await createConnectedUser("user-a");
    const userB = await createConnectedUser("user-b");
    const activityA = {
      id: 51_001,
      title: "User A ride",
      started_at: "2026-09-12T10:00:00Z",
      activitytype: 1,
    };
    const activityB = {
      id: 51_002,
      title: "User B hike",
      started_at: "2026-09-13T10:00:00Z",
      activitytype: 6,
    };
    const harness = createTrailforksMswHarness(({ bearer }) => {
      if (bearer === `Bearer ${userA.tokens.accessToken}`) {
        return { content: [], structuredContent: { activities: [activityA] } };
      }
      if (bearer === `Bearer ${userB.tokens.accessToken}`) {
        return { content: [], structuredContent: { activities: [activityB] } };
      }
      throw new Error(`Unexpected Trailforks bearer ${bearer}`);
    });
    server.use(harness.handler);
    const provider = new TrailforksProvider();

    await sync(userA.userId, provider);
    await sync(userB.userId, provider);

    const rowsA = await activitiesFor(userA.userId);
    const rowsB = await activitiesFor(userB.userId);
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
    expect(rowsA[0]?.userId).toBe(userA.userId);
    expect(rowsB[0]?.userId).toBe(userB.userId);
    expect(rowsA[0]?.externalId).toBe("51001");
    expect(rowsA[0]?.name).toBe("User A ride");
    expect(rowsB[0]?.externalId).toBe("51002");
    expect(rowsB[0]?.name).toBe("User B hike");
    expect(
      harness.requests
        .filter((request) => request.method === "tools/call")
        .map((request) => request.bearer),
    ).toEqual([`Bearer ${userA.tokens.accessToken}`, `Bearer ${userB.tokens.accessToken}`]);
  });

  it("writes for explicit run.options.userId when ambient token user differs", async () => {
    const ambient = await createConnectedUser("ambient");
    const explicit = await createConnectedUser("explicit");
    const activityForExplicit = {
      id: 61_001,
      title: "Explicit user ride",
      started_at: "2026-09-15T10:00:00Z",
      activitytype: 1,
    };
    const harness = createTrailforksMswHarness(({ bearer }) => {
      if (bearer === `Bearer ${explicit.tokens.accessToken}`) {
        return { content: [], structuredContent: { activities: [activityForExplicit] } };
      }
      if (bearer === `Bearer ${ambient.tokens.accessToken}`) {
        return {
          content: [],
          structuredContent: {
            activities: [
              {
                id: 61_999,
                title: "Ambient should not write",
                started_at: "2026-09-15T11:00:00Z",
                activitytype: 6,
              },
            ],
          },
        };
      }
      throw new Error(`Unexpected Trailforks bearer ${bearer}`);
    });
    server.use(harness.handler);

    const result = await sync(explicit.userId, new TrailforksProvider(), {
      ambientUserId: ambient.userId,
    });

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toEqual([]);
    expect(await activitiesFor(ambient.userId)).toEqual([]);
    const rows = await activitiesFor(explicit.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: explicit.userId,
      externalId: "61001",
      name: "Explicit user ride",
    });
  });

  it("writes nothing when the MCP payload is malformed and does not delete existing rows", async () => {
    const { userId } = await createConnectedUser("malformed");
    const good = createTrailforksMswHarness(() => ({
      content: [],
      structuredContent: { activities: [SYNTHETIC_IN_WINDOW] },
    }));
    server.use(good.handler);
    const provider = new TrailforksProvider();
    await sync(userId, provider);
    expect(await activitiesFor(userId)).toHaveLength(1);

    server.resetHandlers();
    const bad = createTrailforksMswHarness(() => ({
      content: [],
      structuredContent: {
        activities: [{ id: 9, started_at: "2026-09-19" }],
      },
    }));
    server.use(bad.handler);

    const result = await sync(userId, provider);
    const rows = await activitiesFor(userId);

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toBe("Trailforks returned an invalid activity list.");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.externalId).toBe("42001");
  });

  it("writes nothing from a mixed listing that includes a valid sibling of a malformed row", async () => {
    const { userId } = await createConnectedUser("mixed-malformed");
    const harness = createTrailforksMswHarness(() => ({
      content: [],
      structuredContent: {
        activities: [
          { id: 9, started_at: "2026-09-19" },
          {
            id: 42_003,
            title: "Valid sibling",
            started_at: "2026-09-20T10:00:00-07:00",
            activitytype: 6,
            link: "https://www.trailforks.com/ridelog/view/42003/",
          },
        ],
      },
    }));
    server.use(harness.handler);

    const result = await sync(userId, new TrailforksProvider());
    const rows = await activitiesFor(userId);

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toBe("Trailforks returned an invalid activity list.");
    expect(rows).toEqual([]);
  });

  it("continues after a real PostgreSQL row-data failure from NUL in raw JSON", async () => {
    const { userId } = await createConnectedUser("nul-raw");
    const nulLeakMarker = "trailforks-nul-marker-9f3a";
    const harness = createTrailforksMswHarness(() => ({
      content: [],
      structuredContent: {
        activities: [
          {
            id: 42_010,
            title: "NUL in raw",
            started_at: "2026-09-19T16:30:00-07:00",
            activitytype: 1,
            link: "https://www.trailforks.com/ridelog/view/42010/",
            note: `${nulLeakMarker}\u0000payload`,
          },
          {
            id: 42_011,
            title: "Valid sibling",
            started_at: "2026-09-20T10:00:00-07:00",
            activitytype: 6,
            link: "https://www.trailforks.com/ridelog/view/42011/",
          },
        ],
      },
    }));
    server.use(harness.handler);

    const result = await sync(userId, new TrailforksProvider());
    const rows = await activitiesFor(userId);

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toEqual([
      {
        message: "Failed to save a Trailforks activity.",
        externalId: "42010",
      },
    ]);
    expect(JSON.stringify(result.errors)).not.toContain(nulLeakMarker);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      externalId: "42011",
      name: "Valid sibling",
    });
  });
});
