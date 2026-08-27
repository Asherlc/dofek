import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncDatabase } from "../db/index.ts";
import { ProviderInvalidCredentialsError } from "./auth-errors.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";

const mocks = vi.hoisted(() => ({
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

  it("syncs sessions and preserves route lead versus boulder unknown style", async () => {
    mocks.loadTokens.mockResolvedValue({
      accessToken: "access-token",
      scopes: JSON.stringify({ kayaUserId: "42" }),
    });
    mocks.listSessions.mockResolvedValue([session("session-1")]);
    mocks.ascents.mockResolvedValue([
      ascent("route-1", { lead: true, climbType: "Routes", grade: "5.11a" }),
      ascent("boulder-1", { lead: false, climbType: "Boulders", grade: "V5" }),
      ascent("missing-grade", { lead: false, climbType: "Routes", grade: null }),
    ]);
    mocks.upsertActivity.mockResolvedValue({ id: "activity-1" });
    const db = database();

    const result = await new KayaSyncProvider().sync(run(db));

    expect(mocks.ensureProvider).toHaveBeenCalledWith(
      db,
      "kaya",
      "Kaya",
      "https://kaya-beta.kayaclimb.com",
      userId,
    );
    expect(mocks.upsertActivity).toHaveBeenCalledTimes(1);
    expect(mocks.listSessions).toHaveBeenCalledWith("42");
    expect(mocks.ascents).toHaveBeenCalledWith("42");
    expect(result).toMatchObject({
      provider: "kaya",
      recordsSynced: 3,
      errors: [{ message: "Kaya ascent is missing a grade", externalId: "missing-grade" }],
    });
    expect(db.insertValues).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ externalId: "route-1", lead: true, climbType: "route" }),
        expect.objectContaining({
          externalId: "boulder-1",
          lead: null,
          climbType: "boulder",
          attemptCount: 2,
          sent: true,
        }),
      ]),
    );
  });

  it("stores Kaya's supplied time offset, session context, and ascent feedback", async () => {
    const db = database();
    const kayaSession = {
      ...session("session-1"),
      notes: "Worked the steep wall.",
      board: { id: "board-1", name: "Training Board", latitude: 40.01, longitude: -105.27 },
      destination: { id: "destination-1", name: "Boulder Canyon", latitude: 40, longitude: -105.3 },
    };
    const ascentBase = ascent("ascent-1", { lead: true, climbType: "Routes", grade: "5.11a" });
    const kayaAscent = {
      ...ascentBase,
      comment: "Felt smooth.",
      rating: 4,
      stiffness: 3,
      gym: { id: "gym-2", name: "Session Gym" },
      climb: {
        ...ascentBase.climb,
        gym: null,
      },
    };
    mocks.loadTokens.mockResolvedValue({
      accessToken: "access-token",
      scopes: JSON.stringify({ kayaUserId: "42" }),
    });
    mocks.listSessions.mockResolvedValue([kayaSession]);
    mocks.ascents.mockResolvedValue([kayaAscent]);
    mocks.upsertActivity.mockResolvedValue({ id: "activity-1" });

    await new KayaSyncProvider().sync(run(db));

    expect(mocks.upsertActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        notes: "Worked the steep wall.",
        localTimeSource: "provider_offset",
        startUtcOffsetMinutes: 0,
        endUtcOffsetMinutes: 0,
        raw: expect.objectContaining({
          board: expect.objectContaining({ name: "Training Board" }),
          destination: expect.objectContaining({ name: "Boulder Canyon" }),
        }),
      }),
      expect.objectContaining({
        notes: "Worked the steep wall.",
        localTimeSource: "provider_offset",
        startUtcOffsetMinutes: 0,
        endUtcOffsetMinutes: 0,
      }),
    );
    expect(db.insertValues).toHaveBeenCalledWith([
      expect.objectContaining({
        locationName: "Session Gym",
        raw: expect.objectContaining({ comment: "Felt smooth.", rating: 4, stiffness: 3 }),
      }),
    ]);
  });

  it("leaves a climbing-entry location empty when Kaya supplies no location", async () => {
    const db = database();
    const ascentWithoutLocation = {
      ...ascent("ascent-1", { lead: true, climbType: "Routes", grade: "5.11a" }),
      climb: {
        ...ascent("ascent-1", { lead: true, climbType: "Routes", grade: "5.11a" }).climb,
        gym: null,
      },
    };
    mocks.loadTokens.mockResolvedValue({
      accessToken: "access-token",
      scopes: JSON.stringify({ kayaUserId: "42" }),
    });
    mocks.listSessions.mockResolvedValue([{ ...session("session-1"), gym: null }]);
    mocks.ascents.mockResolvedValue([ascentWithoutLocation]);
    mocks.upsertActivity.mockResolvedValue({ id: "activity-1" });

    await new KayaSyncProvider().sync(run(db));

    expect(db.insertValues).toHaveBeenCalledWith([expect.objectContaining({ locationName: null })]);
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

  it("skips entry writes when an activity is unavailable or a session has no ascents", async () => {
    const db = database();
    mocks.loadTokens.mockResolvedValue({
      accessToken: "access-token",
      scopes: JSON.stringify({ kayaUserId: "42" }),
    });
    mocks.listSessions.mockResolvedValue([session("session-1"), session("session-2")]);
    mocks.ascents.mockResolvedValue([
      ascent("missing-activity", { lead: true, climbType: "Routes", grade: "5.10a" }),
    ]);
    mocks.upsertActivity.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "activity-2" });

    await expect(new KayaSyncProvider().sync(run(db))).resolves.toMatchObject({ recordsSynced: 0 });
    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(db.insertValues).not.toHaveBeenCalled();
  });

  it("normalizes optional ascent fields and falls back to the session gym", async () => {
    const db = database();
    const noGymAscent = ascent("project", {
      lead: true,
      climbType: "Routes",
      grade: "5.10a",
      ascentType: "Project",
      attempts: null,
    });
    noGymAscent.climb.gym = null;
    mocks.loadTokens.mockResolvedValue({
      accessToken: "access-token",
      scopes: JSON.stringify({ kayaUserId: "42" }),
    });
    mocks.listSessions.mockResolvedValue([session("session-1")]);
    mocks.ascents.mockResolvedValue([noGymAscent]);
    mocks.upsertActivity.mockResolvedValue({ id: "activity-1" });

    await new KayaSyncProvider().sync(run(db));

    expect(db.insertValues).toHaveBeenCalledWith([
      expect.objectContaining({ attemptCount: 1, locationName: "Kaya Gym", sent: false }),
    ]);
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

  it("captures upstream sync failures in the result", async () => {
    const error = "Kaya unavailable";
    mocks.loadTokens.mockResolvedValue({
      accessToken: "access-token",
      scopes: JSON.stringify({ kayaUserId: "42" }),
    });
    mocks.listSessions.mockRejectedValue(error);
    mocks.ascents.mockResolvedValue([]);

    await expect(new KayaSyncProvider().sync(run(database()))).resolves.toMatchObject({
      recordsSynced: 0,
      errors: [{ message: "Kaya unavailable" }],
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

function database(): SyncDatabase & { insertValues: ReturnType<typeof vi.fn> } {
  const insertValues = vi.fn().mockResolvedValue(undefined);
  const deleteFrom = vi.fn();
  const insertInto = vi.fn();
  deleteFrom.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
  insertInto.mockReturnValue({ values: insertValues });
  return {
    delete: deleteFrom,
    execute: vi.fn(),
    insert: insertInto,
    insertValues,
    select: vi.fn(),
  };
}

function session(id: string) {
  return {
    id,
    start_time: "2026-08-01T10:00:00.000Z",
    end_time: "2026-08-01T11:00:00.000Z",
    gym: { id: "gym-1", name: "Kaya Gym" },
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
    },
  };
}

function climbGym(): { id: string; name: string } | null {
  return { id: "gym-1", name: "Kaya Gym" };
}
