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
