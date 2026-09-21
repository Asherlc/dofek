// cspell:ignore Ziva
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TokenSet } from "../src/auth/oauth.ts";
import type { SyncDatabase } from "../src/db/index.ts";
import { main, parseZivaSmokeOptions, type ZivaSmokeRuntime } from "./ziva-smoke.ts";

const USER_ID = "00000000-0000-4000-8000-000000000010";
const DATE = "2026-09-20";
const ZIVA_ISSUER = "https://connect.ziva.fit/";
const ZIVA_RESOURCE = "https://connect.ziva.fit/mcp";

function jwt(subject: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ iss: ZIVA_ISSUER, aud: ZIVA_RESOURCE, sub: subject }),
  ).toString("base64url");
  return `${header}.${payload}.synthetic-signature`;
}

function tokens(overrides: Partial<TokenSet> = {}): TokenSet {
  return {
    accessToken: jwt("stored-ziva-subject"),
    refreshToken: "sensitive-refresh-token",
    expiresAt: new Date("2026-09-20T13:00:00.000Z"),
    providerAccountId: "stored-ziva-subject",
    scopes: null,
    ...overrides,
  };
}

function createRuntime(overrides: Partial<ZivaSmokeRuntime> = {}) {
  const endDatabase = vi.fn().mockResolvedValue(undefined);
  const select: SyncDatabase["select"] = vi.fn();
  const database = {
    $client: { end: endDatabase },
    select,
  };
  const closeClient = vi.fn().mockResolvedValue(undefined);
  const getMealsForDate = vi.fn().mockResolvedValue({
    meals: [
      {
        mealId: "private-meal-id",
        description: "private meal description",
        mealDate: DATE,
        mealType: "lunch",
        mealTime: null,
        createdAt: "2026-09-20T12:00:00Z",
        itemCount: 1,
        items: [
          {
            itemId: "private-item-id",
            food: "private food",
            portion: "private portion",
            gramWeight: null,
            quantity: 1,
          },
        ],
        macros: { calories: 876, protein: 54, carbs: 32, fat: 10 },
      },
    ],
  });
  const client = { close: closeClient, getMealsForDate };
  const sourceFetch = vi.fn<typeof globalThis.fetch>();
  const wrappedFetch = vi.fn<typeof globalThis.fetch>();
  const storedTokens = tokens();
  const runtime: ZivaSmokeRuntime = {
    now: () => new Date("2026-09-20T12:00:00.000Z"),
    fetch: sourceFetch,
    createDatabase: vi.fn(() => database),
    loadTokens: vi.fn().mockResolvedValue(storedTokens),
    createRateLimitAwareFetch: vi.fn(() => wrappedFetch),
    connectMcpClient: vi.fn().mockResolvedValue(client),
    captureException: vi.fn(),
    writeOutput: vi.fn(),
    ...overrides,
  };
  return {
    client,
    closeClient,
    database,
    endDatabase,
    getMealsForDate,
    runtime,
    sourceFetch,
    storedTokens,
    wrappedFetch,
  };
}

const validArgs = [`--user-id=${USER_ID}`, `--date=${DATE}`];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseZivaSmokeOptions", () => {
  it("accepts exactly one explicit user UUID and literal diary date", () => {
    expect(parseZivaSmokeOptions(validArgs)).toEqual({ userId: USER_ID, date: DATE });
  });

  it.each([
    [[], "missing arguments"],
    [[`--user-id=${USER_ID}`], "missing date"],
    [[`--date=${DATE}`], "missing user"],
    [["--user-id=not-a-uuid", `--date=${DATE}`], "invalid user"],
    [[`--user-id=${USER_ID}`, "--date=2026-02-30"], "invalid date"],
    [[...validArgs, `--user-id=${USER_ID}`], "duplicate user"],
    [[...validArgs, `--date=${DATE}`], "duplicate date"],
    [[...validArgs, "--unexpected=private-value"], "unknown option"],
  ])("rejects %s with one fixed safe usage message", (args) => {
    expect(() => parseZivaSmokeOptions(args)).toThrow(
      "Ziva smoke arguments are invalid. Supply exactly --user-id <UUID> and --date <YYYY-MM-DD>.",
    );
  });
});

describe("Ziva read-only smoke command", () => {
  it("parses invalid arguments before creating database resources", async () => {
    const { runtime } = createRuntime();

    await expect(main(["--user-id=not-a-uuid", `--date=${DATE}`], runtime)).rejects.toThrow(
      "Ziva smoke arguments are invalid",
    );

    expect(runtime.createDatabase).not.toHaveBeenCalled();
    expect(runtime.loadTokens).not.toHaveBeenCalled();
    expect(runtime.connectMcpClient).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "missing authorization",
      storedTokens: null,
      expected: "No stored Ziva authorization was found",
    },
    {
      label: "expired authorization",
      storedTokens: tokens({ expiresAt: new Date("2026-09-20T12:00:00.000Z") }),
      expected: "Stored Ziva authorization is expired",
    },
    {
      label: "mismatched account identity",
      storedTokens: tokens({ providerAccountId: "different-subject" }),
      expected: "Stored Ziva authorization identity is invalid",
    },
    {
      label: "blank account identity",
      storedTokens: tokens({ providerAccountId: "   " }),
      expected: "Stored Ziva authorization identity is invalid",
    },
    {
      label: "non-exact padded account identity",
      storedTokens: tokens({ providerAccountId: " stored-ziva-subject " }),
      expected: "Stored Ziva authorization identity is invalid",
    },
  ])(
    "rejects $label without contacting Ziva or mutating credentials",
    async ({ storedTokens, expected }) => {
      const { runtime, endDatabase } = createRuntime({
        loadTokens: vi.fn().mockResolvedValue(storedTokens),
      });

      await expect(main(validArgs, runtime)).rejects.toThrow(expected);

      expect(runtime.loadTokens).toHaveBeenCalledWith(expect.anything(), "ziva", USER_ID);
      expect(runtime.createRateLimitAwareFetch).not.toHaveBeenCalled();
      expect(runtime.connectMcpClient).not.toHaveBeenCalled();
      expect(endDatabase).toHaveBeenCalledOnce();
    },
  );

  it("loads one explicit user's token and makes one rate-limit-aware production-client read", async () => {
    const {
      runtime,
      database,
      getMealsForDate,
      closeClient,
      endDatabase,
      sourceFetch,
      storedTokens,
      wrappedFetch,
    } = createRuntime();

    await main(validArgs, runtime);

    expect(runtime.loadTokens).toHaveBeenCalledOnce();
    expect(runtime.loadTokens).toHaveBeenCalledWith(database, "ziva", USER_ID);
    expect(runtime.createRateLimitAwareFetch).toHaveBeenCalledWith(sourceFetch, {
      providerId: "ziva",
    });
    expect(runtime.connectMcpClient).toHaveBeenCalledWith({
      accessToken: storedTokens.accessToken,
      fetchFn: wrappedFetch,
    });
    expect(getMealsForDate).toHaveBeenCalledOnce();
    expect(getMealsForDate).toHaveBeenCalledWith(DATE);
    expect(closeClient).toHaveBeenCalledOnce();
    expect(endDatabase).toHaveBeenCalledOnce();
  });

  it("prints one redacted JSON object without credential, identity, diary, ID, or nutrient values", async () => {
    const { runtime, storedTokens } = createRuntime();

    await main(validArgs, runtime);

    expect(runtime.writeOutput).toHaveBeenCalledOnce();
    const output = vi.mocked(runtime.writeOutput).mock.calls[0]?.[0];
    expect(JSON.parse(output ?? "")).toEqual({
      tools: { get_meals_for_date: true },
      mealCount: 1,
      mealFields: {
        description: true,
        mealDate: true,
        mealType: true,
        mealTime: true,
        createdAt: true,
        itemCount: true,
        items: true,
        macros: true,
      },
      itemFields: { food: true, portion: true, quantity: true },
      macroKeys: { calories: true, protein: true, carbs: true, fat: true },
      presence: { mealId: true, itemId: true, gramWeight: true },
    });
    for (const privateValue of [
      "sensitive-refresh-token",
      storedTokens.accessToken,
      "stored-ziva-subject",
      "private-meal-id",
      "private-item-id",
      "private meal description",
      "private food",
      "private portion",
      "876",
      "54",
      "32",
      "10",
    ]) {
      expect(output).not.toContain(privateValue);
    }
  });

  it("maps private failures to a fixed message and closes both resources", async () => {
    const privateFailure = new Error("private bearer and raw diary response");
    const { runtime, closeClient, endDatabase, getMealsForDate } = createRuntime();
    getMealsForDate.mockRejectedValue(privateFailure);

    const error = await main(validArgs, runtime).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toBe(
      "Error: Ziva read-only smoke check failed safely. No Dofek or Ziva data was written.",
    );
    expect(JSON.stringify(error)).not.toContain(privateFailure.message);
    expect(runtime.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Ziva read-only smoke check failed safely. No Dofek or Ziva data was written.",
      }),
      expect.objectContaining({ tags: { operation: "ziva-smoke" } }),
    );
    expect(closeClient).toHaveBeenCalledOnce();
    expect(endDatabase).toHaveBeenCalledOnce();
    expect(runtime.writeOutput).not.toHaveBeenCalled();
  });

  it("settles client and database cleanup even when both closers fail", async () => {
    const closeClient = vi.fn().mockRejectedValue(new Error("private client close failure"));
    const endDatabase = vi.fn().mockRejectedValue(new Error("private database close failure"));
    const select: SyncDatabase["select"] = vi.fn();
    const { runtime } = createRuntime({
      createDatabase: vi.fn(() => ({
        $client: { end: endDatabase },
        select,
      })),
      connectMcpClient: vi.fn().mockResolvedValue({
        close: closeClient,
        getMealsForDate: vi.fn().mockResolvedValue({ meals: [] }),
      }),
    });

    await expect(main(validArgs, runtime)).rejects.toThrow(
      "Ziva read-only smoke check failed safely. No Dofek or Ziva data was written.",
    );

    expect(closeClient).toHaveBeenCalledOnce();
    expect(endDatabase).toHaveBeenCalledOnce();
    expect(runtime.writeOutput).not.toHaveBeenCalled();
  });
});
