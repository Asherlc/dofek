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
  it("rejects a grade catalog record missing its required identity", async () => {
    vi.resetModules();
    const { KilterBoardClient: FreshKilterBoardClient } = await import("./kilter-board-client.ts");
    const instance = new FreshKilterBoardClient(async (input) =>
      Response.json(
        String(input).endsWith("/grades") ? [{ vScale: "V5", fontScale: "6C" }] : [log],
      ),
    );
    await expect(instance.fetchLogbook(tokens, vi.fn())).rejects.toMatchObject({
      name: "ZodError",
    });
  });

  it("rejects a personal rating missing its required wall angle", async () => {
    vi.resetModules();
    const { KilterBoardClient: FreshKilterBoardClient } = await import("./kilter-board-client.ts");
    const instance = new FreshKilterBoardClient(async (input) =>
      Response.json(
        String(input).endsWith("/grades")
          ? grades
          : [{ ...log, climbRating: { difficultyGradeId: 22, comment: "Missing angle" } }],
      ),
    );
    await expect(instance.fetchLogbook(tokens, vi.fn())).rejects.toMatchObject({
      name: "ZodError",
    });
  });

  it("initializes schemas that preserve normalized tokens, offset dates and personal grades", async () => {
    vi.resetModules();
    const { KilterBoardClient: FreshKilterBoardClient } = await import("./kilter-board-client.ts");
    const instance = new FreshKilterBoardClient(async (input) => {
      if (String(input).includes("/token"))
        return Response.json({
          access_token: " access ",
          refresh_token: " refresh ",
          expires_in: 300,
        });
      if (String(input).endsWith("/grades")) return Response.json(grades);
      return Response.json([
        {
          ...log,
          logUuid: " normalized-log ",
          climbUuid: " normalized-climb ",
          createdAt: "2026-10-02T00:30:00+02:00",
          climbRating: { angle: 40, difficultyGradeId: 22, comment: "Personal rating" },
        },
      ]);
    });
    const connected = await instance.login("user", "password");
    expect(connected).toMatchObject({ accessToken: "access", refreshToken: "refresh" });
    const result = await instance.fetchLogbook(connected, vi.fn());
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      externalId: "kilter:log:normalized-log",
      climbedOn: "2026-10-01",
      wallAngle: { value: 40, unit: "degrees" },
      climb: { externalId: "normalized-climb" },
      notes: "Personal rating",
      reportedGrades: [
        { value: "V6", system: "v_scale" },
        { value: "7A", system: "font" },
      ],
    });
  });

  it("returns a structured authentication failure for rejected credentials", async () => {
    await expect(
      new KilterBoardClient(async () => new Response(null, { status: 401 })).login(
        "user",
        "password",
      ),
    ).rejects.toMatchObject({
      name: "ProviderAuthError",
      authFailureReason: "authentication_failed",
      message: expect.stringContaining("Reconnect"),
    });
  });

  it("accepts distinct log identities and a matching rating with no comment", async () => {
    const result = await client([
      { ...log, climbRating: { angle: 40 } },
      { ...log, logUuid: "second" },
    ]).fetchLogbook(tokens, vi.fn());
    expect(result.entries.map((entry) => entry.externalId)).toEqual([
      "kilter:log:log-one",
      "kilter:log:second",
    ]);
    expect(result.entries[0]?.notes).toBeNull();
  });
  it("sends the full password grant and computes expiry from seconds", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const instance = new KilterBoardClient(async (input, init) => {
        expect(String(input)).toBe(
          "https://idp.kiltergrips.com/realms/kilter/protocol/openid-connect/token",
        );
        expect(init?.method).toBe("POST");
        expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
          grant_type: "password",
          scope: "openid offline_access",
          username: "email",
          password: "secret",
          client_id: "kilter",
        });
        expect(new Headers(init?.headers).get("accept")).toBe("application/json");
        expect(new Headers(init?.headers).get("content-type")).toBe(
          "application/x-www-form-urlencoded",
        );
        return Response.json({
          access_token: " access ",
          refresh_token: " refresh ",
          expires_in: 300,
          scope: "new-scope",
        });
      });
      expect(await instance.login("email", "secret")).toEqual({
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: new Date(now + 300000),
        scopes: "new-scope",
      });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it.each([400, 401, 403, 500])("reports token failure HTTP %s", async (status) => {
    await expect(
      new KilterBoardClient(async () => new Response(null, { status })).login("user", "pass"),
    ).rejects.toThrow(status === 500 ? /token request failed.*500/ : /login failed.*Reconnect/);
  });

  it("requires refreshable authorization at login and when refreshing", async () => {
    await expect(
      new KilterBoardClient(async () =>
        Response.json({ access_token: "access", expires_in: 300 }),
      ).login("user", "pass"),
    ).rejects.toThrow(/did not issue a refreshable/);
    const fetchFn = vi.fn<typeof fetch>();
    await expect(
      new KilterBoardClient(fetchFn).fetchLogbook(
        { ...tokens, refreshToken: null, expiresAt: new Date(0) },
        vi.fn(),
      ),
    ).rejects.toThrow(/requires a refreshable/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("retains omitted refresh facts and account identity while persisting before data requests", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const signal = new AbortController().signal;
    const persist = vi.fn();
    try {
      const instance = new KilterBoardClient(async (input, init) => {
        expect(init?.signal).toBe(signal);
        expect(new Headers(init?.headers).get("accept")).toBe("application/json");
        if (String(input).includes("/token"))
          return Response.json({ access_token: "new", expires_in: 100 });
        expect(persist).toHaveBeenCalledWith({
          accessToken: "new",
          refreshToken: "refresh",
          scopes: tokens.scopes,
          expiresAt: new Date(now + 100000),
          providerAccountId: "owner",
        });
        expect(new Headers(init?.headers).get("authorization")).toBe(
          String(input).endsWith("/logs") ? "Bearer new" : null,
        );
        return Response.json([]);
      });
      await instance.fetchLogbook(
        { ...tokens, expiresAt: new Date(now), providerAccountId: "owner" },
        persist,
        signal,
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("propagates credential persistence failures before reading the logbook", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      Response.json({ access_token: "new", refresh_token: "new-refresh", expires_in: 300 }),
    );
    await expect(
      new KilterBoardClient(fetchFn).fetchLogbook(
        { ...tokens, expiresAt: new Date(0) },
        vi.fn().mockRejectedValue(new Error("storage unavailable")),
      ),
    ).rejects.toThrow("storage unavailable");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])(
    "reconnects when refreshed authorization is rejected (%s)",
    async (status) => {
      const fetchFn = vi.fn<typeof fetch>(async (input) =>
        String(input).includes("/token")
          ? Response.json({ access_token: "new", expires_in: 300 })
          : new Response(null, { status }),
      );
      await expect(
        new KilterBoardClient(fetchFn).fetchLogbook({ ...tokens, expiresAt: new Date(0) }, vi.fn()),
      ).rejects.toThrow(/authorization expired or was rejected/);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["logs", "grades"])("reports failed %s requests", async (endpoint) => {
    const instance = new KilterBoardClient(async (input) =>
      String(input).endsWith(`/${endpoint}`)
        ? new Response(null, { status: 503 })
        : Response.json([]),
    );
    await expect(instance.fetchLogbook(tokens, vi.fn())).rejects.toThrow(
      endpoint === "logs" ? /logbook request failed.*503/ : /grade request failed.*503/,
    );
  });

  it("maps board, climb and optional facts without losing unknown grades", async () => {
    const source = {
      ...log,
      angle: 0,
      attempts: 1,
      wallUuid: "wall",
      climbName: "  named  ",
      currentDifficultyId: 0,
      climbRating: { angle: 0, difficultyGradeId: null, comment: "  note  " },
      createdAt: "2026-10-02T00:30:00+02:00",
    };
    const result = await client(
      [source],
      [{ difficultyGradeId: 0, vScale: "unrecognized", fontScale: " " }],
    ).fetchLogbook(tokens, vi.fn());
    expect(result.entries[0]).toMatchObject({
      climbedOn: "2026-10-01",
      discipline: "rock_climbing",
      sourceName: "Kilter Board",
      board: { name: "Kilter Board", externalId: "wall" },
      wallAngle: { value: 0, unit: "degrees" },
      notes: "  note  ",
      reportedGrades: [{ value: "unrecognized", system: null }],
      reportedAttemptCounts: [{ scope: "climb", count: 1 }],
      climb: { externalId: "problem", kind: "boulder", setting: "indoor", name: "  named  " },
    });
  });

  it("keeps blank or null optional facts absent", async () => {
    const result = await client([
      {
        ...log,
        attempts: 0,
        angle: null,
        wallUuid: "",
        climbName: " ",
        currentDifficultyId: null,
        climbRating: { angle: 40, comment: "ignored" },
      },
    ]).fetchLogbook(tokens, vi.fn());
    expect(result.entries[0]?.wallAngle).toBeUndefined();
    expect(result.entries[0]?.reportedAttemptCounts).toBeUndefined();
    expect(result.entries[0]?.reportedGrades).toEqual([]);
    expect(result.entries[0]?.climb?.name).toBeUndefined();
    expect(result.entries[0]?.board).toEqual({ name: "Kilter Board", externalId: null });
    expect(result.entries[0]?.notes).toBeNull();
  });

  it("ignores blank matching rating comments and retains unknown catalog grades", async () => {
    const result = await client(
      [{ ...log, climbRating: { angle: 40, comment: " " } }],
      [{ difficultyGradeId: 20, vScale: " ", fontScale: "unknown" }],
    ).fetchLogbook(tokens, vi.fn());
    expect(result.entries[0]?.notes).toBeNull();
    expect(result.entries[0]?.reportedGrades).toEqual([{ value: "unknown", system: null }]);
  });

  it.each([-91, 91])("rejects impossible angles %s", async (angle) => {
    await expect(client([{ ...log, angle }]).fetchLogbook(tokens, vi.fn())).rejects.toThrow();
  });
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
    expect(result.entries[0]?.attempts).toStrictEqual([{ scope: "climb" }]);
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
