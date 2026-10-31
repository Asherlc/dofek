import { describe, expect, it, vi } from "vitest";
import { AuroraBoardClient } from "./aurora-board-client.ts";

const tokens = {
  accessToken: "session",
  refreshToken: null,
  expiresAt: new Date("2099-01-01"),
  scopes: null,
  providerAccountId: "42",
};
const ascent = {
  uuid: "same-id",
  user_id: 42,
  climb_uuid: "problem",
  angle: 40,
  climbed_at: "2026-10-01 23:30:00",
  is_listed: true,
  attempt_id: 2,
  bid_count: 9,
  difficulty: 20,
};
const bid = {
  uuid: "same-id",
  user_id: 42,
  climb_uuid: "problem",
  angle: 40,
  climbed_at: "2026-10-02 00:00:00",
  bid_count: 3,
};
function client(fetchFn: typeof fetch) {
  return new AuroraBoardClient("tension", "Tension Board", "https://tensionboardapp2.com", fetchFn);
}

describe("AuroraBoardClient", () => {
  it("initializes schemas that preserve normalized session, cursor, attempt and record facts", async () => {
    vi.resetModules();
    const { AuroraBoardClient: FreshAuroraBoardClient } = await import("./aurora-board-client.ts");
    let syncCalls = 0;
    const instance = new FreshAuroraBoardClient(
      "tension",
      "Tension Board",
      "https://tensionboardapp2.com",
      async (input, init) => {
        if (String(input).endsWith("/sessions"))
          return Response.json({ session: { token: " session ", user_id: 42 } });
        syncCalls++;
        if (syncCalls === 1)
          return Response.json({
            ascents: [{ ...ascent, uuid: " normalized-ascent ", climb_uuid: " normalized-climb " }],
            bids: [],
            attempts: [{ id: 2, name: " Redpoint " }],
            user_syncs: [{ table_name: " ascents ", last_synchronized_at: " 2026-10-02 " }],
            _complete: false,
          });
        expect(new URLSearchParams(String(init?.body)).get("ascents")).toBe("2026-10-02");
        return Response.json({ _complete: true });
      },
    );
    const connected = await instance.login("user", "password");
    expect(connected.accessToken).toBe("session");
    const result = await instance.fetchLogbook(connected, vi.fn());
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      externalId: "tension:ascent:normalized-ascent",
      wallAngle: { value: 40, unit: "degrees" },
      climb: { externalId: "normalized-climb" },
      attempts: [{ scope: "climb", sourceCompleted: true, sourceResult: "Redpoint" }],
    });
    expect(syncCalls).toBe(2);
  });

  it("returns a structured authentication failure for rejected sessions", async () => {
    await expect(
      client(async () => new Response(null, { status: 401 })).login("user", "password"),
    ).rejects.toMatchObject({
      name: "ProviderAuthError",
      authFailureReason: "session_expired",
      message: expect.stringContaining("Reconnect"),
    });
  });

  it("retains listed bids even when their ascent-listing flag is false", async () => {
    const result = await client(async () =>
      Response.json({ ascents: [], bids: [{ ...bid, is_listed: false }], _complete: true }),
    ).fetchLogbook(tokens, vi.fn());
    expect(result.absentExternalIds).toEqual([]);
    expect(result.entries).toHaveLength(1);
  });

  it.each([
    { ...ascent, climb_uuid: undefined },
    { ...ascent, climbed_at: "bad" },
  ])("validates a page before a later tombstone can replace it (%j)", async (invalid) => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      Response.json({
        ascents: [invalid],
        bids: [],
        _complete: false,
        user_syncs: [{ table_name: "ascents", last_synchronized_at: "2026-10-02" }],
      }),
    );
    fetchFn
      .mockResolvedValueOnce(
        Response.json({
          ascents: [invalid],
          bids: [],
          _complete: false,
          user_syncs: [{ table_name: "ascents", last_synchronized_at: "2026-10-02" }],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          ascents: [{ uuid: ascent.uuid, user_id: 42, is_listed: false }],
          bids: [],
          _complete: true,
        }),
      );
    await expect(client(fetchFn).fetchLogbook(tokens, vi.fn())).rejects.toThrow();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("rejects a cursor that stalls after previously advancing", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      Response.json({
        ascents: [],
        bids: [],
        _complete: false,
        user_syncs: [{ table_name: "ascents", last_synchronized_at: "2026-10-02" }],
      }),
    );
    await expect(client(fetchFn).fetchLogbook(tokens, vi.fn())).rejects.toThrow(
      /pagination did not advance/,
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it.each([401, 403, 422, 500])(
    "rejects failed login HTTP %s with a useful error",
    async (status) => {
      await expect(
        client(async () => new Response(null, { status })).login("user", "secret"),
      ).rejects.toThrow(status === 500 ? /login failed.*500/ : /Tension Board session.*Reconnect/);
    },
  );

  it("sends login and sync transport headers and preserves the supplied abort signal", async () => {
    const signal = new AbortController().signal;
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("accept")).toBe("application/json");
      if (String(input).endsWith("/sessions")) {
        expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
        expect(new Headers(init?.headers).get("cookie")).toBeNull();
        return Response.json({ session: { token: " token ", user_id: 42 } });
      }
      expect(String(input)).toBe("https://tensionboardapp2.com/sync");
      expect(init?.signal).toBe(signal);
      expect(new Headers(init?.headers).get("content-type")).toBe(
        "application/x-www-form-urlencoded",
      );
      return Response.json({ ascents: [], bids: [], _complete: true });
    });
    const instance = client(fetchFn);
    expect(await instance.login("user", "secret")).toMatchObject({
      accessToken: "token",
      expiresAt: new Date("2099-12-31T00:00:00.000Z"),
    });
    await instance.fetchLogbook(tokens, vi.fn(), signal);
  });

  it.each([undefined, "", "x42", "42x"])(
    "rejects invalid account identity %s before requesting data",
    async (providerAccountId) => {
      const fetchFn = vi.fn<typeof fetch>();
      await expect(
        client(fetchFn).fetchLogbook({ ...tokens, providerAccountId }, vi.fn()),
      ).rejects.toThrow(/Reconnect/);
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it("reports non-authentication sync failures", async () => {
    await expect(
      client(async () => new Response(null, { status: 503 })).fetchLogbook(tokens, vi.fn()),
    ).rejects.toThrow(/logbook request failed.*503/);
  });

  it.each([false, 0, "0", "false"])(
    "recognizes ascent tombstone %s without requiring deleted facts",
    async (is_listed) => {
      const result = await client(async () =>
        Response.json({
          ascents: [{ uuid: " deleted ", user_id: 42, is_listed }],
          bids: [],
          _complete: true,
        }),
      ).fetchLogbook(tokens, vi.fn());
      expect(result).toEqual({
        entries: [],
        absentExternalIds: ["tension:ascent:deleted"],
        authoritative: false,
      });
    },
  );

  it.each([undefined, null, 0, 1])(
    "maps optional facts and positive bid counts exactly (%s)",
    async (count) => {
      const raw = {
        ...bid,
        angle: 0,
        wall_uuid: "wall",
        comment: "  note  ",
        bid_count: count,
        climbed_at: "2026-10-02T00:30:00+02:00",
      };
      const result = await client(async () =>
        Response.json({ ascents: [], bids: [raw], _complete: true }),
      ).fetchLogbook(tokens, vi.fn());
      expect(result.entries[0]).toMatchObject({
        climbedOn: "2026-10-01",
        discipline: "rock_climbing",
        sourceName: "Tension Board",
        board: { name: "Tension Board", externalId: "wall" },
        wallAngle: { value: 0, unit: "degrees" },
        notes: "  note  ",
        climb: { externalId: "problem", kind: "boulder", setting: "indoor" },
      });
      expect(result.entries[0]?.reportedAttemptCounts).toEqual(
        count === 1 ? [{ scope: "climb", count: 1 }] : undefined,
      );
    },
  );

  it("omits absent angles, blank comments and unknown attempt results", async () => {
    const result = await client(async () =>
      Response.json({
        ascents: [{ ...ascent, angle: null, comment: "  ", attempt_id: null }],
        bids: [],
        _complete: true,
      }),
    ).fetchLogbook(tokens, vi.fn());
    expect(result.entries[0]?.wallAngle).toBeUndefined();
    expect(result.entries[0]?.board).toEqual({ name: "Tension Board", externalId: null });
    expect(result.entries[0]?.notes).toBeNull();
    expect(result.entries[0]?.attempts).toStrictEqual([{ scope: "climb", sourceCompleted: true }]);
  });

  it.each([{ ascents: [] }, { bids: [] }])(
    "requires evidence of each requested table (%j)",
    async (tables) => {
      await expect(
        client(async () => Response.json({ ...tables, _complete: true })).fetchLogbook(
          tokens,
          vi.fn(),
        ),
      ).rejects.toThrow(/omitted/);
    },
  );

  it("accepts table evidence from shared cursors and ignores unrelated tables", async () => {
    const result = await client(async () =>
      Response.json({
        _complete: true,
        shared_syncs: ["ascents", "bids", "unknown"].map((table_name) => ({
          table_name,
          last_synchronized_at: "2026-10-02",
          ...(table_name === "unknown" ? { user_id: 99 } : {}),
        })),
      }),
    ).fetchLogbook(tokens, vi.fn());
    expect(result.entries).toEqual([]);
  });

  it("rejects foreign cursor ownership", async () => {
    await expect(
      client(async () =>
        Response.json({
          ascents: [],
          bids: [],
          _complete: true,
          user_syncs: [{ table_name: "ascents", user_id: 99, last_synchronized_at: "2026-10-02" }],
        }),
      ).fetchLogbook(tokens, vi.fn()),
    ).rejects.toThrow(/cursor for another account/);
  });

  it.each(["1970-01-01 00:00:00.000000", "1969-01-01"])(
    "rejects stalled or backwards cursors %s",
    async (last_synchronized_at) => {
      await expect(
        client(async () =>
          Response.json({
            ascents: [],
            bids: [],
            _complete: false,
            user_syncs: [{ table_name: "ascents", last_synchronized_at }],
          }),
        ).fetchLogbook(tokens, vi.fn()),
      ).rejects.toThrow(/pagination did not advance/);
    },
  );

  it.each([-91, 91])("rejects impossible wall angles %s", async (angle) => {
    await expect(
      client(async () =>
        Response.json({ ascents: [{ ...ascent, angle }], bids: [], _complete: true }),
      ).fetchLogbook(tokens, vi.fn()),
    ).rejects.toThrow();
  });
  it("reads separate ascents/bids, native IDs, UTC dates, and raw unknown grades/counts", async () => {
    const instance = client(async () =>
      Response.json({
        ascents: [ascent],
        bids: [bid],
        attempts: [{ id: 2, position: 2, name: "Redpoint" }],
        _complete: true,
      }),
    );
    const result = await instance.fetchLogbook(tokens, vi.fn());
    expect(result.authoritative).toBe(false);
    expect(result.entries).toEqual([
      expect.objectContaining({
        externalId: "tension:ascent:same-id",
        climbedOn: "2026-10-01",
        raw: ascent,
        reportedGrades: [],
        attempts: [{ scope: "climb", sourceCompleted: true, sourceResult: "Redpoint" }],
      }),
      expect.objectContaining({
        externalId: "tension:bid:same-id",
        climbedOn: "2026-10-02",
        raw: bid,
        reportedAttemptCounts: [{ scope: "climb", count: 3 }],
        attempts: [{ scope: "climb", sourceCompleted: false }],
      }),
    ]);
    expect(result.entries[0]?.reportedAttemptCounts).toBeUndefined();
    expect(result.entries[0]?.climb?.name).toBeUndefined();
  });

  it("authenticates per board host with an opaque session and source account ID", async () => {
    const instance = client(async (input, init) => {
      expect(String(input)).toBe("https://tensionboardapp2.com/sessions");
      expect(JSON.parse(String(init?.body))).toEqual({
        username: "climber",
        password: "secret",
        tou: "accepted",
        pp: "accepted",
        ua: "app",
      });
      return Response.json({ session: { user_id: 42, token: "session-token" } });
    });
    expect(await instance.login("climber", "secret")).toMatchObject({
      accessToken: "session-token",
      refreshToken: null,
      scopes: null,
      providerAccountId: "42",
    });
  });

  it("merges per-table cursors and resolves explicit tombstones without inferring absence", async () => {
    const calls: URLSearchParams[] = [];
    const instance = client(async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("cookie")).toBe("token=session");
      expect(headers.get("user-agent")).toContain("CFNetwork");
      calls.push(new URLSearchParams(String(init?.body)));
      return Response.json(
        calls.length === 1
          ? {
              ascents: [ascent],
              bids: [bid],
              _complete: false,
              user_syncs: [
                {
                  table_name: "ascents",
                  user_id: 42,
                  last_synchronized_at: "2026-10-02 00:00:00.000000",
                },
              ],
            }
          : {
              ascents: [{ uuid: "same-id", user_id: 42, is_listed: false }],
              bids: [],
              _complete: true,
            },
      );
    });
    const result = await instance.fetchLogbook(tokens, vi.fn());
    expect(calls[0]?.get("ascents")).toBe("1970-01-01 00:00:00.000000");
    expect(calls[1]?.get("ascents")).toBe("2026-10-02 00:00:00.000000");
    expect(calls[1]?.get("bids")).toBe(calls[0]?.get("bids"));
    expect(result.absentExternalIds).toEqual(["tension:ascent:same-id"]);
    expect(result.entries).toHaveLength(1);
  });

  it.each([
    { ascents: [], bids: [] },
    { _complete: true },
    { ascents: {}, bids: [], _complete: true },
    { ascents: [], bids: [], _complete: false },
    { ascents: [{ ...ascent, user_id: 99 }], bids: [], _complete: true },
    { ascents: [{ ...ascent, climbed_at: "bad" }], bids: [], _complete: true },
  ])("rejects malformed, incomplete, or wrong-owner responses (%j)", async (response) => {
    await expect(
      client(async () => Response.json(response)).fetchLogbook(tokens, vi.fn()),
    ).rejects.toThrow();
  });

  it.each([401, 403])("surfaces session expiry (%s) as a reconnect requirement", async (status) => {
    await expect(
      client(async () => new Response(null, { status })).fetchLogbook(tokens, vi.fn()),
    ).rejects.toThrow(/reconnect/i);
  });

  it("does not synthesize a result from an unknown attempt_id", async () => {
    const result = await client(async () =>
      Response.json({ ascents: [ascent], bids: [], _complete: true }),
    ).fetchLogbook(tokens, vi.fn());
    expect(result.entries[0]?.attempts).toEqual([{ scope: "climb", sourceCompleted: true }]);
  });

  it("fails instead of importing a truncated logbook when every page stays incomplete", async () => {
    let calls = 0;
    const instance = client(async () => {
      calls++;
      return Response.json({
        ascents: [],
        bids: [],
        _complete: false,
        user_syncs: [
          {
            user_id: 42,
            table_name: "ascents",
            last_synchronized_at: `2026-10-01 00:00:00.${String(calls).padStart(6, "0")}`,
          },
        ],
      });
    });
    await expect(instance.fetchLogbook(tokens, vi.fn())).rejects.toThrow(/100 pages/);
    expect(calls).toBe(100);
  });
});
