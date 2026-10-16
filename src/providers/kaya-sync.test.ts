import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClimbingLogSessionsSyncInput } from "../db/climbing-log-session-sync.ts";
import type { SyncDatabase } from "../db/index.ts";
import { ProviderInvalidCredentialsError } from "./auth-errors.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import { makeTransactionalTestDatabase } from "./test-helpers.ts";

const mocks = vi.hoisted(() => ({
  persistSessions: vi.fn(async (_db: SyncDatabase, input: ClimbingLogSessionsSyncInput) => ({
    logEntryIds: [],
    recordsSynced:
      input.standaloneEntries.length +
      input.sessions.reduce((count, session) => count + session.entries.length, 0),
  })),
  ascents: vi.fn(),
  captureException: vi.fn(),
  ensureProvider: vi.fn(),
  kayaClient: vi.fn(),
  listSessions: vi.fn(),
  loadTokens: vi.fn(),
  refreshAccessToken: vi.fn(),
  saveTokens: vi.fn(),
  signIn: vi.fn(),
  upsertActivity: vi.fn(),
}));

vi.mock("../db/climbing-log-session-sync.ts", () => ({
  persistClimbingLogSessions: mocks.persistSessions,
}));
vi.mock("@dofek/kaya-client", () => {
  class KayaApiError extends Error {
    status: number | undefined;

    constructor(message: string, status?: number) {
      super(message);
      this.status = status;
    }
  }
  class KayaInvalidCredentialsError extends Error {}
  return {
    KayaApiError,
    KayaClient: class {
      constructor(...args: unknown[]) {
        mocks.kayaClient(...args);
      }

      listSessions = mocks.listSessions;
      listAscents = mocks.ascents;
    },
    KayaInvalidCredentialsError,
    refreshKayaAccessToken: mocks.refreshAccessToken,
    signInToKaya: mocks.signIn,
  };
});

vi.mock("../db/provider-activity-sync.ts", () => ({
  upsertProviderActivity: mocks.upsertActivity,
}));
vi.mock("../db/tokens.ts", () => ({
  ensureProvider: mocks.ensureProvider,
  loadTokens: mocks.loadTokens,
  saveTokens: mocks.saveTokens,
}));
vi.mock("../lib/error-reporting.ts", () => ({ captureException: mocks.captureException }));

import { KayaApiError, KayaInvalidCredentialsError } from "@dofek/kaya-client";
import { KayaSyncProvider } from "./kaya-sync.ts";

const userId = "00000000-0000-4000-8000-000000000001";

describe("KayaSyncProvider", () => {
  it.each([
    {
      label: " Onsight ",
      attempt: {
        scope: "climb",
        ropeMethod: "lead",
        qualifier: "free-onsight",
        sourceResult: " Onsight ",
      },
    },
    {
      label: "Flash",
      attempt: {
        scope: "climb",
        ropeMethod: "lead",
        qualifier: "free-flash",
        sourceResult: "Flash",
      },
    },
    {
      label: "Redpoint",
      attempt: {
        scope: "climb",
        ropeMethod: "lead",
        qualifier: "free-send",
        sourceResult: "Redpoint",
      },
    },
    {
      label: "Send",
      attempt: { scope: "climb", ropeMethod: "lead", qualifier: "free-send", sourceResult: "Send" },
    },
    {
      label: "Repeat",
      attempt: {
        scope: "climb",
        ropeMethod: "lead",
        qualifier: "free-send",
        sourceResult: "Repeat",
        hadCompletedBefore: true,
      },
    },
    { label: "Unfamiliar", attempt: { scope: "climb", ropeMethod: "lead" } },
  ])("preserves the exact source meaning of $label", async ({ label, attempt }) => {
    const db = database();
    const source = ascent("facts", {
      lead: true,
      climbType: "Routes",
      grade: " 5.10a ",
      attempts: null,
      ascentType: label,
    });
    mocks.loadTokens.mockResolvedValue({
      accessToken: "token",
      scopes: JSON.stringify({ kayaUserId: "42" }),
    });
    mocks.listSessions.mockResolvedValue([session("session-1")]);
    mocks.ascents.mockResolvedValue([source]);
    mocks.upsertActivity.mockResolvedValue({ id: "activity-1" });
    expect(await new KayaSyncProvider().sync(run(db))).toMatchObject({
      recordsSynced: 1,
      errors: [],
    });
    expect(mocks.persistSessions.mock.calls[0]?.[1].sessions[0]).toMatchObject({ complete: true });
    expect(mocks.persistSessions.mock.calls[0]?.[1].sessions[0]?.entries[0]).toStrictEqual({
      externalId: "kaya:ascent:facts",
      climbedOn: "2026-08-01",
      discipline: "rock_climbing",
      sourceName: "Kaya",
      raw: source,
      board: null,
      wallAngle: null,
      attempts: [attempt],
      climb: {
        externalId: "climb-facts",
        name: "Kaya Climb",
        kind: "route",
        setting: "indoor",
        publishedGrades: [{ value: "5.10a", system: "yds" }],
        areas: [{ externalId: "gym-1", name: "Kaya Gym" }],
      },
    });
  });
  it("retains board, zero angle and explicit null notes and count on a standalone top-rope occurrence", async () => {
    const db = database();
    const base = ascent("board", { lead: false, climbType: "Routes", grade: "5.10a", attempts: 3 });
    const source = {
      ...base,
      session_id: null,
      comment: null,
      climb: { ...base.climb, board: { id: "board-1", name: "Board" }, angle: 0 },
    };
    mocks.loadTokens.mockResolvedValue({
      accessToken: "token",
      scopes: JSON.stringify({ kayaUserId: "42" }),
    });
    mocks.listSessions.mockResolvedValue([]);
    mocks.ascents.mockResolvedValue([source]);
    await new KayaSyncProvider().sync(run(db));
    expect(mocks.persistSessions.mock.calls[0]?.[1].standaloneEntries[0]).toMatchObject({
      notes: null,
      board: { name: "Board", externalId: "board-1" },
      wallAngle: { value: 0, unit: null },
      reportedAttemptCounts: [{ scope: "climb", count: 3 }],
    });
    expect(mocks.persistSessions.mock.calls[0]?.[1].standaloneEntries[0]?.attempts).toStrictEqual([
      { scope: "climb", ropeMethod: "top_rope", qualifier: "free-send", sourceResult: "Redpoint" },
    ]);
  });
  it.each(["0000-01-01", "2026-02-30", "malformed"])(
    "reports an invalid recorded climb date %s",
    async (date) => {
      const db = database();
      const source = {
        ...ascent("date", { lead: true, climbType: "Routes", grade: "5.10a" }),
        date,
      };
      mocks.loadTokens.mockResolvedValue({
        accessToken: "token",
        scopes: JSON.stringify({ kayaUserId: "42" }),
      });
      mocks.listSessions.mockResolvedValue([session("session-1")]);
      mocks.ascents.mockResolvedValue([source]);
      mocks.upsertActivity.mockResolvedValue({ id: "activity-1" });
      const result = await new KayaSyncProvider().sync(run(db));
      expect(result.errors[0]?.message).toContain("invalid climb date");
      expect(mocks.captureException).toHaveBeenCalled();
      expect(mocks.persistSessions).not.toHaveBeenCalled();
    },
  );
  it("includes standalone boundary occurrences and keeps undated records without duplicating known sessions", async () => {
    const db = database();
    const base = ascent("base", { lead: true, climbType: "Routes", grade: "5.10a" });
    const sources = [
      { ...base, id: "since", session_id: "unknown", date: "2026-08-01T00:00:00.000Z" },
      { ...base, id: "until", session_id: null, date: "2026-08-02T00:00:00.000Z" },
      { ...base, id: "before", session_id: null, date: "2026-07-31T23:59:59.999Z" },
      { ...base, id: "after", session_id: null, date: "2026-08-02T00:00:00.001Z" },
      { ...base, id: "undated", session_id: null, date: " " },
      { ...base, id: "attached", session_id: "session-1" },
    ];
    mocks.loadTokens.mockResolvedValue({
      accessToken: "token",
      scopes: JSON.stringify({ kayaUserId: "42" }),
    });
    mocks.listSessions.mockResolvedValue([session("session-1")]);
    mocks.ascents.mockResolvedValue(sources);
    mocks.upsertActivity.mockResolvedValue({ id: "activity-1" });
    expect(await new KayaSyncProvider().sync(run(db))).toMatchObject({
      errors: [],
      recordsSynced: 4,
    });
    const input = mocks.persistSessions.mock.calls[0]?.[1];
    expect(input?.standaloneEntries.map((entry) => [entry.externalId, entry.climbedOn])).toEqual([
      ["kaya:ascent:since", "2026-08-01"],
      ["kaya:ascent:until", "2026-08-02"],
      ["kaya:ascent:undated", null],
    ]);
    expect(input?.sessions[0]?.entries.map((entry) => entry.externalId)).toEqual([
      "kaya:ascent:attached",
    ]);
  });
  it("maps separate send and attempted-summary occurrences to one actual climb", async () => {
    const db = database();
    const sent = ascent("10", {
      lead: false,
      climbType: "Bouldering",
      grade: "V4",
      attempts: null,
      ascentType: "Flash",
    });
    sent.session_id = "1000";
    sent.climb.id = "2001";
    const attempted = { ...sent.climb, id: "1000_2001", attempts: 4 };
    mocks.loadTokens.mockResolvedValue({
      accessToken: "token",
      scopes: JSON.stringify({ kayaUserId: "42" }),
    });
    mocks.listSessions.mockResolvedValue([{ ...session("1000"), attempted_climbs: [attempted] }]);
    mocks.ascents.mockResolvedValue([sent]);
    mocks.upsertActivity.mockResolvedValue({ id: "activity-1" });
    expect(await new KayaSyncProvider().sync(run(db))).toMatchObject({
      recordsSynced: 2,
      errors: [],
    });
    const input = mocks.persistSessions.mock.calls[0]?.[1];
    expect(input?.sessions[0]?.entries).toEqual([
      expect.objectContaining({
        externalId: "kaya:ascent:10",
        attempts: [expect.objectContaining({ scope: "climb", qualifier: "free-flash" })],
        climb: expect.objectContaining({
          externalId: "2001",
          kind: "boulder",
          setting: "indoor",
          publishedGrades: [{ value: "V4", system: "v_scale" }],
        }),
        raw: sent,
      }),
      expect.objectContaining({
        externalId: "kaya:session:1000:attempted:1000_2001",
        attempts: [{ scope: "climb", ropeMethod: null }],
        reportedAttemptCounts: [{ scope: "climb", count: 4 }],
        climb: expect.objectContaining({ externalId: "2001" }),
        raw: attempted,
      }),
    ]);
  });
  it("retains missing grade and method on a recorded source occurrence", async () => {
    const db = database();
    const base = ascent("ungraded", { lead: true, climbType: "Routes", grade: null });
    const source = { ...base, comment: "Source note", climb: { ...base.climb, lead: null } };
    mocks.loadTokens.mockResolvedValue({
      accessToken: "token",
      scopes: JSON.stringify({ kayaUserId: "42" }),
    });
    mocks.listSessions.mockResolvedValue([session("session-1")]);
    mocks.ascents.mockResolvedValue([source]);
    mocks.upsertActivity.mockResolvedValue({ id: "activity-1" });
    expect(await new KayaSyncProvider().sync(run(db))).toMatchObject({
      recordsSynced: 1,
      errors: [],
    });
    expect(mocks.persistSessions.mock.calls[0]?.[1].sessions[0]?.entries[0]).toMatchObject({
      notes: "Source note",
      climbedOn: "2026-08-01",
      climb: { externalId: "climb-ungraded", kind: "route" },
    });
  });
  it("stores gym and outdoor location coordinates on their own areas", async () => {
    const db = database();
    const base = ascent("outdoor", { lead: true, climbType: "Routes", grade: "5.10a" });
    const source = {
      ...base,
      climb: {
        ...base.climb,
        gym: null,
        destination: { id: "destination", name: "Destination", latitude: 0, longitude: -122.25 },
        area: { id: "wall", name: "Wall", latitude: 37.5, longitude: 0 },
      },
    };
    mocks.loadTokens.mockResolvedValue({
      accessToken: "token",
      scopes: JSON.stringify({ kayaUserId: "42" }),
    });
    mocks.listSessions.mockResolvedValue([session("session-1")]);
    mocks.ascents.mockResolvedValue([source]);
    mocks.upsertActivity.mockResolvedValue({ id: "activity-1" });
    expect(await new KayaSyncProvider().sync(run(db))).toMatchObject({
      recordsSynced: 1,
      errors: [],
    });
    expect(mocks.persistSessions.mock.calls[0]?.[1].sessions[0]?.entries[0]?.climb?.areas).toEqual([
      {
        name: "Destination",
        externalId: "destination",
        coordinates: { latitude: 0, longitude: -122.25 },
      },
      { name: "Wall", externalId: "wall", coordinates: { latitude: 37.5, longitude: 0 } },
    ]);
  });
  it.each(["wrong_2001", "1000_", "1000_20_01", "1000_not-an-id"])(
    "rejects ambiguous attempted climb identity %s",
    async (id) => {
      const db = database();
      const source = ascent("source", { lead: false, climbType: "Bouldering", grade: "V4" });
      mocks.loadTokens.mockResolvedValue({
        accessToken: "token",
        scopes: JSON.stringify({ kayaUserId: "42" }),
      });
      mocks.listSessions.mockResolvedValue([
        { ...session("1000"), attempted_climbs: [{ ...source.climb, id, attempts: 2 }] },
      ]);
      mocks.ascents.mockResolvedValue([]);
      mocks.upsertActivity.mockResolvedValue({ id: "activity-1" });
      const result = await new KayaSyncProvider().sync(run(db));
      expect(result.errors[0]?.message).toContain("climb identity");
      expect(mocks.persistSessions).not.toHaveBeenCalled();
    },
  );
  it("retains an ascent without an upstream session", async () => {
    const db = database();
    const base = ascent("standalone", { lead: true, climbType: "Routes", grade: "5.10a" });
    mocks.loadTokens.mockResolvedValue({
      accessToken: "token",
      scopes: JSON.stringify({ kayaUserId: "42" }),
    });
    mocks.listSessions.mockResolvedValue([]);
    mocks.ascents.mockResolvedValue([{ ...base, session_id: null }]);
    expect(await new KayaSyncProvider().sync(run(db))).toMatchObject({
      recordsSynced: 1,
      errors: [],
    });
    expect(mocks.persistSessions.mock.calls[0]?.[1].standaloneEntries).toEqual([
      expect.objectContaining({ externalId: "kaya:ascent:standalone", climbedOn: "2026-08-01" }),
    ]);
    expect(mocks.upsertActivity).not.toHaveBeenCalled();
  });
  it("uses the ascent's occurrence ID independently of its session association", async () => {
    const db = database();
    const source = ascent("same", { lead: true, climbType: "Routes", grade: "5.10a" });
    mocks.loadTokens.mockResolvedValue({
      accessToken: "token",
      scopes: JSON.stringify({ kayaUserId: "42" }),
    });
    mocks.listSessions.mockResolvedValue([session("session-1")]);
    mocks.ascents.mockResolvedValue([source]);
    mocks.upsertActivity.mockResolvedValue({ id: "activity-1" });
    await new KayaSyncProvider().sync(run(db));
    const attached = mocks.persistSessions.mock.calls[0]?.[1].sessions[0]?.entries[0];
    mocks.listSessions.mockResolvedValue([]);
    mocks.ascents.mockResolvedValue([{ ...source, session_id: null }]);
    await new KayaSyncProvider().sync(run(db));
    expect(mocks.persistSessions.mock.calls[1]?.[1].standaloneEntries[0]?.externalId).toBe(
      attached?.externalId,
    );
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureProvider.mockResolvedValue("kaya");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("authenticates Kaya credentials and persists the Kaya user ID in scopes", async () => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-08-01T12:00:00.000Z").valueOf());
    mocks.signIn.mockResolvedValue({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      userId: "42",
    });

    const tokens = await new KayaSyncProvider()
      .authSetup()
      .automatedLogin?.("climber@example.com", "secret");

    expect(tokens).toMatchObject({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      scopes: JSON.stringify({ kayaUserId: "42" }),
    });
    expect(tokens?.expiresAt).toEqual(new Date("2026-08-01T12:25:00.000Z"));
  });

  it("normalizes invalid credentials for the shared connection flow", async () => {
    mocks.signIn.mockRejectedValue(new KayaInvalidCredentialsError());

    await expect(
      new KayaSyncProvider().authSetup().automatedLogin?.("climber@example.com", "secret"),
    ).rejects.toBeInstanceOf(ProviderInvalidCredentialsError);
  });

  it("preserves non-credential authentication errors", async () => {
    const error = new Error("Kaya unavailable");
    mocks.signIn.mockRejectedValue(error);

    await expect(
      new KayaSyncProvider().authSetup().automatedLogin?.("climber@example.com", "secret"),
    ).rejects.toBe(error);
  });

  it("uses the gym timezone for UTC sessions and leaves an unfinished session open", async () => {
    const db = database();
    mocks.loadTokens.mockResolvedValue({
      accessToken: "access-token",
      scopes: JSON.stringify({ kayaUserId: "42" }),
    });
    mocks.listSessions.mockResolvedValue([
      {
        ...session("session-1"),
        start_time: "2026-08-27T14:51:43.000Z",
        end_time: "2026-08-27T14:51:43.000Z",
        gym: {
          id: "gym-1",
          name: "Kaya Gym",
          latitude: 37.7749,
          longitude: -122.4194,
        },
      },
    ]);
    mocks.ascents.mockResolvedValue([]);
    mocks.upsertActivity.mockResolvedValue({ id: "activity-1" });

    await new KayaSyncProvider().sync(
      run(
        db,
        SyncWindow.fromIsoRange({
          sinceIso: "2026-08-27T00:00:00.000Z",
          untilIso: "2026-08-28T00:00:00.000Z",
        }),
      ),
    );

    expect(mocks.upsertActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        endedAt: null,
        timezone: "America/Los_Angeles",
        startUtcOffsetMinutes: -420,
        endUtcOffsetMinutes: null,
        localTimeSource: "provider_timezone",
      }),
      expect.objectContaining({
        endedAt: null,
        timezone: "America/Los_Angeles",
        startUtcOffsetMinutes: -420,
        endUtcOffsetMinutes: null,
        localTimeSource: "provider_timezone",
      }),
    );
  });

  it("falls back to a supplied non-UTC offset when gym coordinates are invalid", async () => {
    const db = database();
    mocks.loadTokens.mockResolvedValue({
      accessToken: "access-token",
      scopes: JSON.stringify({ kayaUserId: "42" }),
    });
    mocks.listSessions.mockResolvedValue([
      {
        ...session("session-1"),
        start_time: "2026-08-01T10:00:00.000-06:00",
        end_time: "2026-08-01T11:00:00.000-06:00",
        gym: { id: "gym-1", name: "Kaya Gym", latitude: 95, longitude: -105.27 },
      },
    ]);
    mocks.ascents.mockResolvedValue([]);
    mocks.upsertActivity.mockResolvedValue({ id: "activity-1" });

    await new KayaSyncProvider().sync(run(db));

    expect(mocks.upsertActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        timezone: null,
        startUtcOffsetMinutes: -360,
        endUtcOffsetMinutes: -360,
        localTimeSource: "provider_offset",
      }),
      expect.anything(),
    );
  });

  it("does not record UTC as an activity-local end offset", async () => {
    const db = database();
    mocks.loadTokens.mockResolvedValue({
      accessToken: "access-token",
      scopes: JSON.stringify({ kayaUserId: "42" }),
    });
    mocks.listSessions.mockResolvedValue([
      {
        ...session("session-1"),
        start_time: "2026-08-01T10:00:00.000-06:00",
        end_time: "2026-08-01T17:00:00.000Z",
      },
    ]);
    mocks.ascents.mockResolvedValue([]);
    mocks.upsertActivity.mockResolvedValue({ id: "activity-1" });

    await new KayaSyncProvider().sync(run(db));

    expect(mocks.upsertActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        startUtcOffsetMinutes: -360,
        endUtcOffsetMinutes: null,
        localTimeSource: "provider_offset",
      }),
      expect.anything(),
    );
  });

  it("clears the end offset when Kaya reports an unfinished offset session", async () => {
    const db = database();
    mocks.loadTokens.mockResolvedValue({
      accessToken: "access-token",
      scopes: JSON.stringify({ kayaUserId: "42" }),
    });
    mocks.listSessions.mockResolvedValue([
      {
        ...session("session-1"),
        start_time: "2026-08-01T10:00:00.000-06:00",
        end_time: "2026-08-01T10:00:00.000-06:00",
      },
    ]);
    mocks.ascents.mockResolvedValue([]);
    mocks.upsertActivity.mockResolvedValue({ id: "activity-1" });

    await new KayaSyncProvider().sync(run(db));

    expect(mocks.upsertActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        endedAt: null,
        startUtcOffsetMinutes: -360,
        endUtcOffsetMinutes: null,
        localTimeSource: "provider_offset",
      }),
      expect.anything(),
    );
  });

  it("preserves a valid Kaya session end time", async () => {
    const db = database();
    mocks.loadTokens.mockResolvedValue({
      accessToken: "access-token",
      scopes: JSON.stringify({ kayaUserId: "42" }),
    });
    mocks.listSessions.mockResolvedValue([
      {
        ...session("session-1"),
        start_time: "2026-08-01T10:00:00.000-06:00",
        end_time: "2026-08-01T11:00:00.000-06:00",
      },
    ]);
    mocks.ascents.mockResolvedValue([]);
    mocks.upsertActivity.mockResolvedValue({ id: "activity-1" });

    await new KayaSyncProvider().sync(run(db));

    expect(mocks.upsertActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ endedAt: new Date("2026-08-01T17:00:00.000Z") }),
      expect.anything(),
    );
  });

  it("drops a malformed Kaya session end time", async () => {
    const db = database();
    mocks.loadTokens.mockResolvedValue({
      accessToken: "access-token",
      scopes: JSON.stringify({ kayaUserId: "42" }),
    });
    mocks.listSessions.mockResolvedValue([
      {
        ...session("session-1"),
        start_time: "2026-08-01T10:00:00.000-06:00",
        end_time: "not-a-date",
      },
    ]);
    mocks.ascents.mockResolvedValue([]);
    mocks.upsertActivity.mockResolvedValue({ id: "activity-1" });

    await new KayaSyncProvider().sync(run(db));

    expect(mocks.upsertActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ endedAt: null, localTimeSource: "provider_offset" }),
      expect.anything(),
    );
  });

  it("falls back to the supplied offset when a gym coordinate is missing", async () => {
    const db = database();
    mocks.loadTokens.mockResolvedValue({
      accessToken: "access-token",
      scopes: JSON.stringify({ kayaUserId: "42" }),
    });
    mocks.listSessions.mockResolvedValue([
      {
        ...session("session-1"),
        start_time: "2026-08-01T10:00:00.000-06:00",
        end_time: "2026-08-01T11:00:00.000-06:00",
        gym: { id: "gym-1", name: "Kaya Gym", latitude: 40, longitude: null },
      },
    ]);
    mocks.ascents.mockResolvedValue([]);
    mocks.upsertActivity.mockResolvedValue({ id: "activity-1" });

    await new KayaSyncProvider().sync(run(db));

    expect(mocks.upsertActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ timezone: null, localTimeSource: "provider_offset" }),
      expect.anything(),
    );
  });

  it("accepts gym coordinates on each geographic boundary", async () => {
    const db = database();
    mocks.loadTokens.mockResolvedValue({
      accessToken: "access-token",
      scopes: JSON.stringify({ kayaUserId: "42" }),
    });
    mocks.listSessions.mockResolvedValue(
      [
        [-90, 0],
        [90, 0],
        [0, -180],
        [0, 180],
      ].map(([latitude, longitude], index) => ({
        ...session(`session-${index}`),
        gym: { id: `gym-${index}`, name: "Kaya Gym", latitude, longitude },
      })),
    );
    mocks.ascents.mockResolvedValue([]);
    mocks.upsertActivity.mockResolvedValue({ id: "activity-1" });

    await new KayaSyncProvider().sync(run(db));

    expect(mocks.upsertActivity).toHaveBeenCalledTimes(4);
    for (const [, activity] of mocks.upsertActivity.mock.calls) {
      expect(activity).toEqual(expect.objectContaining({ localTimeSource: "provider_timezone" }));
    }
  });

  it.each([
    {
      name: "the start timestamp has no UTC offset",
      start_time: "2026-08-01T10:00:00",
      end_time: "2026-08-01T11:00:00.000Z",
    },
    {
      name: "the end timestamp has no UTC offset",
      start_time: "2026-08-01T10:00:00.000Z",
      end_time: "2026-08-01T11:00:00",
    },
  ])("keeps local time unknown when $name", async ({ start_time, end_time }) => {
    const db = database();
    mocks.loadTokens.mockResolvedValue({
      accessToken: "access-token",
      scopes: JSON.stringify({ kayaUserId: "42" }),
    });
    mocks.listSessions.mockResolvedValue([{ ...session("session-1"), start_time, end_time }]);
    mocks.ascents.mockResolvedValue([]);
    mocks.upsertActivity.mockResolvedValue({ id: "activity-1" });

    await new KayaSyncProvider().sync(
      run(
        db,
        SyncWindow.fromIsoRange({
          sinceIso: "2026-07-31T00:00:00.000Z",
          untilIso: "2026-08-03T00:00:00.000Z",
        }),
      ),
    );

    expect(mocks.upsertActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        localTimeSource: "unknown",
        startUtcOffsetMinutes: null,
        endUtcOffsetMinutes: null,
      }),
      expect.objectContaining({
        localTimeSource: "unknown",
        startUtcOffsetMinutes: null,
        endUtcOffsetMinutes: null,
      }),
    );
  });

  it("does not persist an invalid Kaya end timestamp and continues syncing sessions", async () => {
    const db = database();
    mocks.loadTokens.mockResolvedValue({
      accessToken: "access-token",
      scopes: JSON.stringify({ kayaUserId: "42" }),
    });
    mocks.listSessions.mockResolvedValue([
      { ...session("invalid-end"), end_time: "not-a-dateZ" },
      session("following-session"),
    ]);
    mocks.ascents.mockResolvedValue([]);
    mocks.upsertActivity.mockResolvedValue({ id: "activity-1" });

    await new KayaSyncProvider().sync(run(db));

    expect(mocks.upsertActivity).toHaveBeenCalledTimes(2);
    expect(mocks.upsertActivity).toHaveBeenNthCalledWith(
      1,
      db,
      expect.objectContaining({
        externalId: "invalid-end",
        endedAt: null,
        localTimeSource: "unknown",
      }),
      expect.objectContaining({ endedAt: null, localTimeSource: "unknown" }),
    );
    expect(mocks.upsertActivity).toHaveBeenNthCalledWith(
      2,
      db,
      expect.objectContaining({ externalId: "following-session" }),
      expect.anything(),
    );
  });

  it("requires a user ID before accessing Kaya", async () => {
    const db = database();

    await expect(
      new KayaSyncProvider().sync(
        new SyncRun({
          db,
          window: SyncWindow.fromIsoRange({
            sinceIso: "2026-08-01T00:00:00.000Z",
            untilIso: "2026-08-02T00:00:00.000Z",
          }),
        }),
      ),
    ).rejects.toThrow("kaya sync requires a userId");
    expect(mocks.ensureProvider).not.toHaveBeenCalled();
  });

  it("skips sessions before the requested window and keeps a session at its start", async () => {
    const db = database();
    const boundary = session("session-1");
    boundary.start_time = "2026-08-01T00:00:00.000Z";
    mocks.loadTokens.mockResolvedValue({
      accessToken: "access-token",
      scopes: JSON.stringify({ kayaUserId: "42" }),
    });
    mocks.listSessions.mockResolvedValue([
      { ...session("old"), start_time: "2026-07-31T23:59:59.999Z" },
      boundary,
    ]);
    mocks.ascents.mockResolvedValue([
      ascent("boundary-ascent", { lead: true, climbType: "Routes", grade: "5.10a" }),
    ]);
    mocks.upsertActivity.mockResolvedValue({ id: "activity-1" });

    await expect(new KayaSyncProvider().sync(run(db))).resolves.toMatchObject({ recordsSynced: 1 });
    expect(mocks.upsertActivity).toHaveBeenCalledTimes(1);
  });

  it("reports missing stored credentials or Kaya identity", async () => {
    const db = database();
    mocks.loadTokens
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ accessToken: "access-token", scopes: "{}" });

    await expect(new KayaSyncProvider().sync(run(db))).resolves.toMatchObject({
      recordsSynced: 0,
      errors: [{ message: expect.stringContaining("credentials") }],
    });
    await expect(new KayaSyncProvider().sync(run(db))).resolves.toMatchObject({
      recordsSynced: 0,
      errors: [{ message: expect.stringContaining("account identity") }],
    });
  });

  it("refreshes an expired Kaya access token before syncing and persists it", async () => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-08-01T12:00:00.000Z").valueOf());
    const db = database();
    mocks.loadTokens.mockResolvedValue({
      accessToken: "expired-access-token",
      refreshToken: "refresh-token",
      expiresAt: new Date("2026-08-01T11:59:59.999Z"),
      scopes: JSON.stringify({ kayaUserId: "42" }),
    });
    mocks.refreshAccessToken.mockResolvedValue("refreshed-access-token");
    mocks.listSessions.mockResolvedValue([]);
    mocks.ascents.mockResolvedValue([]);

    await expect(new KayaSyncProvider().sync(run(db))).resolves.toMatchObject({
      recordsSynced: 0,
      errors: [],
    });

    expect(mocks.refreshAccessToken).toHaveBeenCalledWith("refresh-token", expect.any(Function));
    expect(mocks.saveTokens).toHaveBeenCalledWith(
      db,
      "kaya",
      expect.objectContaining({
        accessToken: "refreshed-access-token",
        refreshToken: "refresh-token",
        expiresAt: new Date("2026-08-01T12:25:00.000Z"),
        scopes: JSON.stringify({ kayaUserId: "42" }),
      }),
      userId,
    );
    expect(mocks.kayaClient).toHaveBeenCalledWith("refreshed-access-token", expect.any(Function));
  });

  it("refreshes and retries once when Kaya rejects an unexpired access token", async () => {
    const db = database();
    mocks.loadTokens.mockResolvedValue({
      accessToken: "rejected-access-token",
      refreshToken: "refresh-token",
      expiresAt: new Date("2026-08-01T13:00:00.000Z"),
      scopes: JSON.stringify({ kayaUserId: "42" }),
    });
    mocks.refreshAccessToken.mockResolvedValue("refreshed-access-token");
    mocks.listSessions
      .mockRejectedValueOnce(new KayaApiError("Kaya API request failed (401)", 401))
      .mockResolvedValueOnce([]);
    mocks.ascents.mockResolvedValue([]);

    await expect(new KayaSyncProvider().sync(run(db))).resolves.toMatchObject({
      recordsSynced: 0,
      errors: [],
    });

    expect(mocks.refreshAccessToken).toHaveBeenCalledWith("refresh-token", expect.any(Function));
    expect(mocks.listSessions).toHaveBeenCalledTimes(2);
    expect(mocks.saveTokens).toHaveBeenCalledWith(
      db,
      "kaya",
      expect.objectContaining({ accessToken: "refreshed-access-token" }),
      userId,
    );
  });

  it("requires a Kaya reconnect when the stored refresh token is rejected", async () => {
    mocks.loadTokens.mockResolvedValue({
      accessToken: "expired-access-token",
      refreshToken: "revoked-refresh-token",
      expiresAt: new Date("2026-08-01T11:59:59.999Z"),
      scopes: JSON.stringify({ kayaUserId: "42" }),
    });
    mocks.refreshAccessToken.mockRejectedValue(
      new KayaApiError("Kaya token refresh failed (401)", 401),
    );

    await expect(new KayaSyncProvider().sync(run(database()))).resolves.toMatchObject({
      recordsSynced: 0,
      errors: [{ message: "Kaya refresh token was revoked or expired." }],
    });
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it("requires reconnect without reporting an exception when refreshing after an API rejection fails", async () => {
    mocks.loadTokens.mockResolvedValue({
      accessToken: "rejected-access-token",
      refreshToken: "revoked-refresh-token",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      scopes: JSON.stringify({ kayaUserId: "42" }),
    });
    mocks.listSessions.mockRejectedValue(new KayaApiError("Kaya API request failed (401)", 401));
    mocks.ascents.mockResolvedValue([]);
    mocks.refreshAccessToken.mockRejectedValue(
      new KayaApiError("Kaya token refresh failed (401)", 401),
    );

    await expect(new KayaSyncProvider().sync(run(database()))).resolves.toMatchObject({
      recordsSynced: 0,
      errors: [{ message: "Kaya refresh token was revoked or expired." }],
    });
    expect(mocks.listSessions).toHaveBeenCalledTimes(1);
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it.each([
    { error: "Kaya unavailable", message: "Kaya unavailable" },
    { error: null, message: "null" },
    { error: undefined, message: "undefined" },
  ])("captures upstream sync failures in the result: $message", async ({ error, message }) => {
    mocks.loadTokens.mockResolvedValue({
      accessToken: "access-token",
      scopes: JSON.stringify({ kayaUserId: "42" }),
    });
    mocks.listSessions.mockRejectedValue(error);
    mocks.ascents.mockResolvedValue([]);

    await expect(new KayaSyncProvider().sync(run(database()))).resolves.toMatchObject({
      recordsSynced: 0,
      errors: [{ message }],
    });
    expect(mocks.captureException).toHaveBeenCalledWith(error);
  });
});

function run(db: ReturnType<typeof database>, window = defaultWindow()): SyncRun {
  return new SyncRun({
    db,
    userId,
    window,
  });
}

function defaultWindow(): SyncWindow {
  return SyncWindow.fromIsoRange({
    sinceIso: "2026-08-01T00:00:00.000Z",
    untilIso: "2026-08-02T00:00:00.000Z",
  });
}

function database() {
  return makeTransactionalTestDatabase({
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
  });
}

function session(id: string) {
  return {
    id,
    start_time: "2026-08-01T10:00:00.000Z",
    end_time: "2026-08-01T11:00:00.000Z",
    gym: { id: "gym-1", name: "Kaya Gym" },
    attempted_climbs: [],
  };
}

function ascent(
  id: string,
  options: {
    lead: boolean;
    climbType: string;
    grade: string | null;
    ascentType?: string;
    attempts?: number | null;
  },
) {
  return {
    id,
    session_id: "session-1",
    date: "2026-08-01T10:30:00.000Z",
    attempts: options.attempts === undefined ? 2 : options.attempts,
    ascent_type: { id: "redpoint", name: options.ascentType ?? "Redpoint" },
    climb: {
      id: `climb-${id}`,
      name: "Kaya Climb",
      lead: options.lead,
      climb_type: { id: options.climbType, name: options.climbType },
      grade: options.grade
        ? { id: `grade-${id}`, name: options.grade, climb_type_group: "route" }
        : null,
      gym: climbGym(),
      destination: null,
      area: null,
      subarea: null,
      board: null,
      angle: null,
    },
  };
}

function climbGym(): { id: string; name: string } | null {
  return { id: "gym-1", name: "Kaya Gym" };
}
