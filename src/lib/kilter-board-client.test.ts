import { describe, expect, it, vi } from "vitest";
import { KilterBoardClient } from "./kilter-board-client.ts";

const tokens = {
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: new Date("2099-01-01T00:00:00Z"),
  scopes: "openid offline_access",
};
const log = {
  logUuid: "log-one",
  userUuid: "owner",
  climbUuid: "problem",
  climbName: "A problem",
  createdAt: "2026-10-01T23:30:00.123456Z",
  angle: 40,
  attempts: 3,
  topped: true,
  flashed: false,
  currentDifficultyId: 20,
};
const grades = [
  { difficultyGradeId: 20, vScale: "V5", fontScale: "6C" },
  { difficultyGradeId: 22, vScale: "V6", fontScale: "7A" },
];
function client(logs: unknown, gradeList: unknown = grades) {
  return new KilterBoardClient(async (input) =>
    Response.json(String(input).endsWith("/grades") ? gradeList : logs),
  );
}

describe("KilterBoardClient", () => {
  it("keeps native log identity, exact raw facts, count, completion, and log-angle grade", async () => {
    const source = {
      ...log,
      climbRating: { angle: 30, difficultyGradeId: 22, comment: "Other angle" },
    };
    const result = await client([source]).fetchLogbook(tokens, vi.fn());
    expect(result).toMatchObject({ authoritative: true, absentExternalIds: [] });
    expect(result.entries).toEqual([
      expect.objectContaining({
        externalId: "kilter:log:log-one",
        climbedOn: "2026-10-01",
        raw: source,
        wallAngle: { value: 40, unit: "degrees" },
        reportedGrades: [
          { value: "V5", system: "v_scale" },
          { value: "6C", system: "font" },
        ],
        reportedAttemptCounts: [{ scope: "climb", count: 3 }],
        attempts: [{ scope: "climb", sourceCompleted: true }],
      }),
    ]);
    expect(result.entries[0]?.notes).toBeNull();
  });

  it("uses a matching personal grade and preserves unsuccessful logs", async () => {
    const source = {
      ...log,
      topped: false,
      attempts: 1,
      climbRating: { angle: 40, difficultyGradeId: 22, comment: "Hard" },
    };
    const result = await client([source]).fetchLogbook(tokens, vi.fn());
    expect(result.entries[0]).toMatchObject({
      notes: "Hard",
      reportedGrades: [
        { value: "V6", system: "v_scale" },
        { value: "7A", system: "font" },
      ],
      attempts: [{ scope: "climb", sourceCompleted: false }],
    });
  });

  it("leaves missing counts, names, grades and outcomes unknown", async () => {
    const result = await client([
      { logUuid: "unknown", climbUuid: "problem", createdAt: log.createdAt },
    ]).fetchLogbook(tokens, vi.fn());
    expect(result.entries[0]).toMatchObject({
      reportedGrades: [],
      attempts: [{ scope: "climb" }],
      climb: { externalId: "problem" },
    });
    expect(result.entries[0]?.reportedAttemptCounts).toBeUndefined();
    expect(result.entries[0]?.climb?.name).toBeUndefined();
  });

  it("retains the untouched upstream payload independently of parsed IDs", async () => {
    const raw = { ...log, logUuid: " log-one " };
    const result = await client([raw]).fetchLogbook(tokens, vi.fn());
    expect(result.entries[0]?.raw).toEqual(raw);
  });

  it.each([
    { flashed: false, completed: null },
    { flashed: null, completed: null },
    { flashed: undefined, completed: null },
    { flashed: true, completed: true },
  ])(
    "keeps explicit unknown topping distinct from omission with flashed=$flashed",
    async ({ flashed, completed }) => {
      const result = await client([{ ...log, topped: null, flashed }]).fetchLogbook(
        tokens,
        vi.fn(),
      );
      expect(result.entries[0]?.attempts).toEqual([{ scope: "climb", sourceCompleted: completed }]);
    },
  );

  it("omits a completion fact when topping is omitted and no positive flash is supplied", async () => {
    const result = await client([
      { logUuid: log.logUuid, climbUuid: log.climbUuid, createdAt: log.createdAt, flashed: false },
    ]).fetchLogbook(tokens, vi.fn());
    expect(result.entries[0]?.attempts).toEqual([{ scope: "climb" }]);
  });

  it.each([
    {},
    [{ ...log, logUuid: "" }],
    [{ ...log, createdAt: "bad" }],
    [{ ...log, attempts: -1 }],
    [log, log],
  ])("rejects malformed/inconsistent log lists before a snapshot (%j)", async (logs) => {
    await expect(client(logs).fetchLogbook(tokens, vi.fn())).rejects.toThrow();
  });

  it("does not treat an invalid grade catalog as an empty authoritative response", async () => {
    await expect(client([], {}).fetchLogbook(tokens, vi.fn())).rejects.toThrow();
  });

  it("authenticates with email and refreshes expired tokens before reading logs", async () => {
    const requests: { url: string; body: URLSearchParams }[] = [];
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes("/token")) {
        requests.push({ url, body: new URLSearchParams(String(init?.body)) });
        return Response.json({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 300,
          scope: "openid offline_access",
        });
      }
      expect(new Headers(init?.headers).get("authorization")).toBe(
        url.endsWith("/logs") ? "Bearer new-access" : null,
      );
      return Response.json([]);
    });
    const instance = new KilterBoardClient(fetchFn);
    const connected = await instance.login("me@example.com", "private-password");
    expect(requests[0]?.body.get("grant_type")).toBe("password");
    expect(requests[0]?.body.get("username")).toBe("me@example.com");
    expect(connected.refreshToken).toBe("new-refresh");
    const persist = vi.fn();
    await instance.fetchLogbook({ ...tokens, expiresAt: new Date(0) }, persist);
    expect(requests[1]?.body.get("grant_type")).toBe("refresh_token");
    expect(requests[1]?.body.get("refresh_token")).toBe("refresh");
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "new-access", refreshToken: "new-refresh" }),
    );
  });

  it("refreshes a rejected access token once and persists rotation before retry", async () => {
    const persist = vi.fn();
    let logCalls = 0;
    const instance = new KilterBoardClient(async (input, init) => {
      if (String(input).includes("/token"))
        return Response.json({ access_token: "new", refresh_token: "rotated", expires_in: 300 });
      if (String(input).endsWith("/grades")) return Response.json([]);
      if (logCalls++ === 0) return new Response(null, { status: 401 });
      expect(persist).toHaveBeenCalledOnce();
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer new");
      return Response.json([]);
    });
    await expect(instance.fetchLogbook(tokens, persist)).resolves.toMatchObject({ entries: [] });
    expect(logCalls).toBe(2);
  });

  it("reports revoked refresh credentials without including secret response bodies", async () => {
    const instance = new KilterBoardClient(
      async () => new Response("private vendor body", { status: 400 }),
    );
    await expect(
      instance.fetchLogbook({ ...tokens, expiresAt: new Date(0) }, vi.fn()),
    ).rejects.toThrow(/reconnect/i);
    await expect(instance.login("user", "pass")).rejects.not.toThrow("private vendor body");
  });
});
