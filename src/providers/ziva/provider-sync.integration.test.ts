import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { TokenSet } from "../../auth/oauth.ts";
import { runWithProviderUserIngestContext } from "../../db/provider-ingest-context.ts";
import { foodEntry, foodEntryNutrient } from "../../db/schema/nutrition.ts";
import { userProfile } from "../../db/schema/reference.ts";
import { setupTestDatabase, type TestContext } from "../../db/test-helpers.ts";
import { connectProviderWithTokens } from "../../db/tokens.ts";
import { executeWithSchema } from "../../db/typed-sql.ts";
import { failOnUnhandledExternalRequest } from "../../test/msw.ts";
import type { SyncCheckpointStore } from "../sync-run.ts";
import { SyncRun } from "../sync-run.ts";
import { SyncWindow } from "../sync-window.ts";
import { ZivaMcpMalformedResponseError } from "./client.ts";
import { createZivaMswHarness } from "./msw-test-helpers.ts";
import { ZivaProvider } from "./provider.ts";

const ZIVA_PROVIDER = {
  id: "ziva",
  name: "Ziva",
  apiBaseUrl: "https://connect.ziva.fit/mcp",
};
const FIRST_DATE = "2026-09-19";
const SECOND_DATE = "2026-09-20";
const server = setupServer();

const nutritionResolutionSchema = z.object({
  calories: z.coerce.number().nullable(),
  resolution_status: z.string(),
});

function jwt(subject: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({
      iss: "https://connect.ziva.fit/",
      aud: "https://connect.ziva.fit/mcp",
      sub: subject,
    }),
  ).toString("base64url");
  return `${header}.${claims}.synthetic-integration-signature`;
}

function tokensFor(subject: string): TokenSet {
  return {
    accessToken: jwt(subject),
    refreshToken: `refresh-${subject}`,
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    providerAccountId: subject,
    scopes: null,
  };
}

function meal(
  date: string,
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    mealId: id,
    description: `Meal ${id}`,
    mealDate: date,
    items: [
      {
        food: `Food ${id}`,
        portion: "one bowl",
        gramWeight: 250,
        quantity: 1,
      },
    ],
    macros: { protein: 20, fat: 10, carbs: 30, calories: 300 },
    itemCount: 1,
    mealType: "lunch",
    mealTime: "12:00",
    createdAt: `${date}T12:00:00Z`,
    ...overrides,
  };
}

function callResult(meals: Array<Record<string, unknown>>): Record<string, unknown> {
  return { content: [], structuredContent: { meals } };
}

class MemoryCheckpointStore implements SyncCheckpointStore {
  value: unknown | null;
  readonly saved: unknown[] = [];
  clearCount = 0;

  constructor(value: unknown | null = null) {
    this.value = value;
  }

  async load(): Promise<unknown | null> {
    return this.value;
  }

  async save(checkpoint: unknown): Promise<void> {
    this.value = checkpoint;
    this.saved.push(checkpoint);
  }

  async clear(): Promise<void> {
    this.value = null;
    this.clearCount += 1;
  }
}

async function sync(options: {
  provider: ZivaProvider;
  userId: string;
  sinceDate: string;
  untilDate?: string;
  checkpoint?: MemoryCheckpointStore;
}) {
  const checkpoint = options.checkpoint ?? new MemoryCheckpointStore();
  return runWithProviderUserIngestContext(options.userId, { homeTimezone: null }, () =>
    options.provider.sync(
      new SyncRun({
        db: context.db,
        window: SyncWindow.fromDateRange({
          sinceDate: options.sinceDate,
          untilDate: options.untilDate ?? options.sinceDate,
        }),
        userId: options.userId,
        checkpoint,
        enqueueSyncContinuation: async (_nextCheckpoint) => undefined,
      }),
    ),
  );
}

async function createConnectedUser(subject: string): Promise<{
  userId: string;
  tokens: TokenSet;
}> {
  const userId = randomUUID();
  const tokens = tokensFor(subject);
  await context.db.insert(userProfile).values({ id: userId, name: `Ziva ${subject}` });
  await connectProviderWithTokens(context.db, ZIVA_PROVIDER, tokens, userId);
  return { userId, tokens };
}

async function entriesFor(userId: string) {
  return context.db
    .select()
    .from(foodEntry)
    .where(and(eq(foodEntry.userId, userId), eq(foodEntry.providerId, "ziva")))
    .orderBy(foodEntry.date, foodEntry.externalId);
}

async function nutrientsFor(entryId: string) {
  return context.db
    .select({ nutrientId: foodEntryNutrient.nutrientId, amount: foodEntryNutrient.amount })
    .from(foodEntryNutrient)
    .where(eq(foodEntryNutrient.foodEntryId, entryId))
    .orderBy(foodEntryNutrient.nutrientId);
}

let context: TestContext;
const originalClientId = process.env.ZIVA_CLIENT_ID;
const originalClientSecret = process.env.ZIVA_CLIENT_SECRET;
const originalRedirectUri = process.env.OAUTH_REDIRECT_URI;

describe.sequential("ZivaProvider.sync (PostgreSQL + MCP protocol)", () => {
  beforeAll(async () => {
    process.env.ZIVA_CLIENT_ID = "ziva-integration-client";
    process.env.ZIVA_CLIENT_SECRET = "ziva-integration-secret";
    process.env.OAUTH_REDIRECT_URI = "https://dofek.example.test/oauth/callback";
    server.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
    context = await setupTestDatabase();
  }, 120_000);

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(async () => {
    server.close();
    await context?.cleanup();
    if (originalClientId === undefined) delete process.env.ZIVA_CLIENT_ID;
    else process.env.ZIVA_CLIENT_ID = originalClientId;
    if (originalClientSecret === undefined) delete process.env.ZIVA_CLIENT_SECRET;
    else process.env.ZIVA_CLIENT_SECRET = originalClientSecret;
    if (originalRedirectUri === undefined) delete process.env.OAUTH_REDIRECT_URI;
    else process.env.OAUTH_REDIRECT_URI = originalRedirectUri;
  });

  it("replays idempotently and applies a source edit, date move, and exact nutrients", async () => {
    const { userId } = await createConnectedUser("edit-subject");
    const originalMeal = meal(FIRST_DATE, "stable-meal");
    const changedMeal = meal(SECOND_DATE, "stable-meal", {
      description: "Edited dinner",
      items: [
        {
          food: "Edited tofu bowl",
          portion: "two bowls",
          gramWeight: 425,
          quantity: 2,
        },
      ],
      macros: { protein: 35, fat: 18, carbs: 0, calories: 410 },
      mealType: "dinner",
      mealTime: "18:30",
      createdAt: `${SECOND_DATE}T18:30:00Z`,
    });
    const harness = createZivaMswHarness(({ date }) =>
      callResult([date === FIRST_DATE ? originalMeal : changedMeal]),
    );
    server.use(harness.handler);
    const provider = new ZivaProvider();

    const initial = await sync({ provider, userId, sinceDate: FIRST_DATE });
    const replay = await sync({ provider, userId, sinceDate: FIRST_DATE });
    expect(initial).toMatchObject({ recordsSynced: 1, errors: [], continued: false });
    expect(replay).toMatchObject({ recordsSynced: 1, errors: [], continued: false });

    const [firstRow] = await entriesFor(userId);
    if (!firstRow) throw new Error("Expected the initial Ziva entry");
    await context.db.insert(foodEntryNutrient).values({
      foodEntryId: firstRow.id,
      nutrientId: "fiber",
      amount: 9,
    });

    const changed = await sync({ provider, userId, sinceDate: SECOND_DATE });
    expect(changed).toMatchObject({ recordsSynced: 1, errors: [], continued: false });

    const rows = await entriesFor(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: firstRow.id,
      date: SECOND_DATE,
      meal: "dinner",
      foodName: "Edited tofu bowl",
      foodDescription: "Edited dinner",
      numberOfUnits: 2,
      servingUnit: "two bowls",
      servingWeightGrams: 425,
    });
    expect(await nutrientsFor(firstRow.id)).toEqual([
      { nutrientId: "calories", amount: 410 },
      { nutrientId: "carbohydrate", amount: 0 },
      { nutrientId: "fat", amount: 18 },
      { nutrientId: "protein", amount: 35 },
    ]);
    expect(harness.requests.filter((request) => request.method === "tools/call")).toHaveLength(3);
  });

  it("isolates identical source meal IDs, bearer tokens, and MCP sessions between users", async () => {
    const first = await createConnectedUser("first-user-subject");
    const second = await createConnectedUser("second-user-subject");
    const harness = createZivaMswHarness(({ bearer, date }) =>
      callResult([
        meal(date, "shared-source-meal", {
          description:
            bearer === `Bearer ${first.tokens.accessToken}` ? "First meal" : "Second meal",
        }),
      ]),
    );
    server.use(harness.handler);
    const provider = new ZivaProvider();

    await sync({ provider, userId: first.userId, sinceDate: FIRST_DATE });
    await sync({ provider, userId: second.userId, sinceDate: FIRST_DATE });

    const [firstEntry] = await entriesFor(first.userId);
    const [secondEntry] = await entriesFor(second.userId);
    expect(firstEntry).toMatchObject({ userId: first.userId, foodDescription: "First meal" });
    expect(secondEntry).toMatchObject({ userId: second.userId, foodDescription: "Second meal" });
    expect(firstEntry?.id).not.toBe(secondEntry?.id);
    expect(firstEntry?.externalId).not.toBe(secondEntry?.externalId);
    expect(firstEntry?.sourceAccountKey).not.toBe(secondEntry?.sourceAccountKey);
    expect(new Set(harness.initializedSessions).size).toBe(2);

    for (const [tokens, expectedSession] of [
      [first.tokens, harness.initializedSessions[0]],
      [second.tokens, harness.initializedSessions[1]],
    ] as const) {
      const requests = harness.requests.filter(
        (request) => request.bearer === `Bearer ${tokens.accessToken}`,
      );
      expect(requests.map((request) => request.method)).toEqual([
        "initialize",
        "notifications/initialized",
        "tools/list",
        "tools/call",
      ]);
      expect(requests[0]?.sessionId).toBeNull();
      expect(requests.slice(1).every((request) => request.sessionId === expectedSession)).toBe(
        true,
      );
    }
  });

  it("preserves separate raw rows for two Ziva subjects and exposes a canonical conflict", async () => {
    const connected = await createConnectedUser("account-a");
    const accountATokens = connected.tokens;
    const accountBTokens = tokensFor("account-b");
    const harness = createZivaMswHarness(({ bearer, date }) =>
      callResult([
        meal(date, "same-upstream-id", {
          description:
            bearer === `Bearer ${accountATokens.accessToken}` ? "Account A meal" : "Account B meal",
          macros:
            bearer === `Bearer ${accountATokens.accessToken}`
              ? { protein: 20, fat: 10, carbs: 30, calories: 300 }
              : { protein: 25, fat: 12, carbs: 40, calories: 380 },
        }),
      ]),
    );
    server.use(harness.handler);
    const provider = new ZivaProvider();

    await sync({ provider, userId: connected.userId, sinceDate: FIRST_DATE });
    await connectProviderWithTokens(context.db, ZIVA_PROVIDER, accountBTokens, connected.userId);
    await sync({ provider, userId: connected.userId, sinceDate: FIRST_DATE });

    const rows = await entriesFor(connected.userId);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.externalId)).size).toBe(2);
    expect(new Set(rows.map((row) => row.sourceAccountKey)).size).toBe(2);

    const resolution = await executeWithSchema(
      context.db,
      nutritionResolutionSchema,
      sql`SELECT calories, resolution_status
          FROM fitness.v_nutrition_daily
          WHERE user_id = ${connected.userId} AND date = ${FIRST_DATE}`,
    );
    expect(resolution).toEqual([{ calories: null, resolution_status: "source_conflict" }]);
  });

  it("retains prior data on an empty success and checkpoints the following malformed date", async () => {
    const { userId } = await createConnectedUser("empty-subject");
    let phase: "seed" | "empty-then-malformed" = "seed";
    const harness = createZivaMswHarness(({ date }) => {
      if (phase === "seed") return callResult([meal(date, "retained-meal")]);
      if (date === FIRST_DATE) return callResult([]);
      return callResult([
        meal(date, "malformed-meal", {
          macros: { protein: 1, fat: 2, carbs: 3 },
        }),
      ]);
    });
    server.use(harness.handler);
    const provider = new ZivaProvider();

    await sync({ provider, userId, sinceDate: FIRST_DATE });
    phase = "empty-then-malformed";
    const checkpoint = new MemoryCheckpointStore();
    const result = await sync({
      provider,
      userId,
      sinceDate: FIRST_DATE,
      untilDate: SECOND_DATE,
      checkpoint,
    });

    expect(result).toMatchObject({ recordsSynced: 0, continued: false });
    expect(result.errors[0]?.cause).toBeInstanceOf(ZivaMcpMalformedResponseError);
    expect(await entriesFor(userId)).toHaveLength(1);
    expect(checkpoint.value).toEqual({
      version: 1,
      nextDate: SECOND_DATE,
      endDate: SECOND_DATE,
      recordsSynced: 0,
    });
    expect(checkpoint.clearCount).toBe(0);
  });

  it("keeps a committed first date on failure and permits a duplicate-free manual replay", async () => {
    const { userId } = await createConnectedUser("replay-subject");
    let malformedSecondDate = true;
    const harness = createZivaMswHarness(({ date }) => {
      if (date === SECOND_DATE && malformedSecondDate) {
        return callResult([
          meal(date, "second-meal", { macros: { protein: 1, fat: 2, carbs: 3 } }),
        ]);
      }
      return callResult([meal(date, date === FIRST_DATE ? "first-meal" : "second-meal")]);
    });
    server.use(harness.handler);
    const provider = new ZivaProvider();
    const checkpoint = new MemoryCheckpointStore();

    const partial = await sync({
      provider,
      userId,
      sinceDate: FIRST_DATE,
      untilDate: SECOND_DATE,
      checkpoint,
    });
    expect(partial).toMatchObject({ recordsSynced: 1, continued: false });
    expect(partial.errors[0]?.cause).toBeInstanceOf(ZivaMcpMalformedResponseError);
    expect(checkpoint.value).toEqual({
      version: 1,
      nextDate: SECOND_DATE,
      endDate: SECOND_DATE,
      recordsSynced: 1,
    });
    const [committedFirstRow] = await entriesFor(userId);
    if (!committedFirstRow) throw new Error("Expected the first date to remain committed");

    malformedSecondDate = false;
    const replay = await sync({
      provider,
      userId,
      sinceDate: FIRST_DATE,
      untilDate: SECOND_DATE,
      checkpoint: new MemoryCheckpointStore(),
    });
    expect(replay).toMatchObject({ recordsSynced: 2, errors: [], continued: false });
    const replayedRows = await entriesFor(userId);
    expect(replayedRows).toHaveLength(2);
    expect(replayedRows.find((row) => row.date === FIRST_DATE)?.id).toBe(committedFirstRow.id);
    expect(new Set(replayedRows.map((row) => row.externalId)).size).toBe(2);
  });
});
