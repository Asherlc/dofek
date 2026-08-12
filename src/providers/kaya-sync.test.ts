import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncDatabase } from "../db/index.ts";
import { ProviderInvalidCredentialsError } from "./auth-errors.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";

const mocks = vi.hoisted(() => ({
  ascents: vi.fn(),
  captureException: vi.fn(),
  ensureProvider: vi.fn(),
  listSessions: vi.fn(),
  loadTokens: vi.fn(),
  signIn: vi.fn(),
  upsertActivity: vi.fn(),
}));

vi.mock("@dofek/kaya-client", () => {
  class KayaInvalidCredentialsError extends Error {}
  return {
    KayaClient: class {
      listSessions = mocks.listSessions;
      listAscents = mocks.ascents;
    },
    KayaInvalidCredentialsError,
    signInToKaya: mocks.signIn,
  };
});

vi.mock("../db/provider-activity-sync.ts", () => ({
  upsertProviderActivity: mocks.upsertActivity,
}));
vi.mock("../db/tokens.ts", () => ({
  ensureProvider: mocks.ensureProvider,
  loadTokens: mocks.loadTokens,
}));
vi.mock("../lib/error-reporting.ts", () => ({ captureException: mocks.captureException }));

import { KayaInvalidCredentialsError } from "@dofek/kaya-client";
import { KayaSyncProvider } from "./kaya-sync.ts";

const userId = "00000000-0000-4000-8000-000000000001";

describe("KayaSyncProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureProvider.mockResolvedValue("kaya");
  });

  it("authenticates Kaya credentials and persists the Kaya user ID in scopes", async () => {
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
    expect(tokens?.expiresAt).toBeInstanceOf(Date);
  });

  it("normalizes invalid credentials for the shared connection flow", async () => {
    mocks.signIn.mockRejectedValue(new KayaInvalidCredentialsError());

    await expect(
      new KayaSyncProvider().authSetup().automatedLogin?.("climber@example.com", "secret"),
    ).rejects.toBeInstanceOf(ProviderInvalidCredentialsError);
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
    expect(result).toMatchObject({
      provider: "kaya",
      recordsSynced: 3,
      errors: [{ message: "Kaya ascent is missing a grade", externalId: "missing-grade" }],
    });
    expect(db.insertValues).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ externalId: "route-1", lead: true, climbType: "route" }),
        expect.objectContaining({ externalId: "boulder-1", lead: null, climbType: "boulder" }),
      ]),
    );
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

  it("captures upstream sync failures in the result", async () => {
    const error = new Error("Kaya unavailable");
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

function run(db: ReturnType<typeof database>): SyncRun {
  return new SyncRun({
    db,
    userId,
    window: SyncWindow.fromIsoRange({
      sinceIso: "2026-08-01T00:00:00.000Z",
      untilIso: "2026-08-02T00:00:00.000Z",
    }),
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

function ascent(id: string, options: { lead: boolean; climbType: string; grade: string | null }) {
  return {
    id,
    session_id: "session-1",
    date: "2026-08-01T10:30:00.000Z",
    attempts: 2,
    ascent_type: { id: "redpoint", name: "Redpoint" },
    climb: {
      id: `climb-${id}`,
      name: "Kaya Climb",
      lead: options.lead,
      climb_type: { id: options.climbType, name: options.climbType },
      grade: options.grade
        ? { id: `grade-${id}`, name: options.grade, climb_type_group: "route" }
        : null,
      gym: { id: "gym-1", name: "Kaya Gym" },
    },
  };
}
