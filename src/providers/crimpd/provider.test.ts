import { readFile, stat } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TokenSet } from "../../auth/oauth.ts";
import {
  crimpdSetHeader,
  crimpdSetRow,
  crimpdWorkoutHeader,
  crimpdWorkoutRow,
} from "../climbing-file-test-helpers.ts";
import { SyncRun } from "../sync-run.ts";
import { SyncWindow } from "../sync-window.ts";
import { createMockDatabase } from "../test-helpers.ts";
import { CrimpdProvider, importCrimpdExportFile } from "./provider.ts";

const mocks = vi.hoisted(() => ({
  load: vi.fn(async (): Promise<TokenSet | null> => null),
  save: vi.fn(async () => {}),
  ensure: vi.fn(async () => {}),
  archive: vi.fn(),
  upsert: vi.fn(async (..._args: unknown[]) => ({ id: "activity-1" })),
  graph: vi.fn(async () => ({ recordsSynced: 0, logEntryIds: [] })),
  capture: vi.fn(),
  exercise: vi.fn(async () => "exercise-id"),
  log: vi.fn(
    async (
      _db: unknown,
      _id: string,
      _type: string,
      work: () => Promise<{ recordCount: number; result: number }>,
    ) => {
      const result = await work();
      expect(result.recordCount).toBe(result.result);
      return result.result;
    },
  ),
}));
vi.mock("../../db/tokens.ts", () => ({
  loadTokens: mocks.load,
  saveTokens: mocks.save,
  ensureProvider: mocks.ensure,
}));
vi.mock("../../db/sync-log.ts", () => ({ withSyncLog: mocks.log }));
vi.mock("../../db/provider-activity-sync.ts", () => ({ upsertProviderActivity: mocks.upsert }));
vi.mock("../../db/climbing-log-sync.ts", () => ({ persistClimbingLogEntries: mocks.graph }));
vi.mock("../../lib/error-reporting.ts", () => ({ captureException: mocks.capture }));
vi.mock("./archive.ts", () => ({ readCrimpdArchive: mocks.archive }));
vi.mock("../../db/exercise-provenance.ts", () => ({
  resolveUserExerciseWithProvenance: mocks.exercise,
}));
const accountTokens: TokenSet = {
  accessToken: "old-access",
  refreshToken: "old-refresh",
  expiresAt: new Date("2099-01-01"),
  providerAccountId: "account",
  scopes: null,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockResolvedValue(null);
  mocks.archive.mockResolvedValue({
    workoutsCsv: `${crimpdWorkoutHeader}\n${crimpdWorkoutRow()}`,
    setsCsv: crimpdSetHeader,
  });
});
afterEach(() => vi.useRealTimers());

describe("Crimpd account connection", () => {
  it("is available without deployment credentials", () => {
    expect(new CrimpdProvider().validate()).toBeNull();
  });
  it.each([
    ["Flexibility", "stretching"],
    ["Core", "strength"],
    ["", "other"],
  ])("imports %s workouts with their source facts", async (target, activityType) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01"));
    mocks.archive.mockResolvedValue({
      workoutsCsv: `${crimpdWorkoutHeader}\n${crimpdWorkoutRow({ TYPE: "Custom", TARGET: target, NOTES: "source note" })}`,
      setsCsv: crimpdSetHeader,
    });
    const { db } = createMockDatabase();
    expect(await importCrimpdExportFile(db, "export.zip", "owner")).toEqual({
      provider: "crimpd",
      recordsSynced: 1,
      errors: [],
      duration: 0,
    });
    const values = {
      activityType: { canonicalType: activityType, modality: null, providerType: "Custom" },
      startedAt: new Date("2026-09-01T23:30:00Z"),
      endedAt: null,
      name: "Board climbing",
      notes: "source note",
      sourceName: "Crimpd",
      raw: expect.objectContaining({ TARGET: target }),
    };
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.anything(),
      { providerId: "crimpd", userId: "owner", externalId: "workout-1", ...values },
      values,
    );
  });
  it.each([false, true])(
    "attaches new climbs while preserving existing attachments=%s",
    async (existing) => {
      mocks.archive.mockResolvedValue({
        workoutsCsv: `${crimpdWorkoutHeader}\n${crimpdWorkoutRow({ TYPE: "Custom" })}`,
        setsCsv: `${crimpdSetHeader}\n${crimpdSetRow()}`,
      });
      const { db } = createMockDatabase({ tokensResult: existing ? [{ id: "climb-id" }] : [] });
      expect(await importCrimpdExportFile(db, "export.zip", "owner")).toMatchObject({
        recordsSynced: 1,
        errors: [],
      });
      expect(mocks.graph).toHaveBeenCalledWith(expect.anything(), {
        providerId: "crimpd",
        userId: "owner",
        entries: [
          expect.objectContaining({
            ...(existing ? {} : { activityId: "activity-1" }),
            externalId: expect.any(String),
          }),
        ],
      });
      expect(mocks.upsert.mock.calls[0]?.[1]).toMatchObject({
        activityType: { canonicalType: "climbing", modality: null, providerType: "Custom" },
      });
    },
  );
  it("imports recorded strength sets with exercise provenance", async () => {
    mocks.archive.mockResolvedValue({
      workoutsCsv: `${crimpdWorkoutHeader}\n${crimpdWorkoutRow()}`,
      setsCsv: `${crimpdSetHeader}\n${crimpdSetRow({ ASCENT: "", GRADE: "", LOCATION: "", BOARD: "", EXERCISE: "Pull ups", REPS: "5", NOTES: "strict" })}`,
    });
    const { db, spies } = createMockDatabase();
    expect(await importCrimpdExportFile(db, "export.zip", "owner")).toMatchObject({
      recordsSynced: 1,
    });
    expect(mocks.exercise).toHaveBeenCalledWith(expect.anything(), {
      userId: "owner",
      providerId: "crimpd",
      name: "Pull ups",
      providerExerciseName: "Pull ups",
      providerExerciseId: null,
      equipment: null,
      exerciseType: null,
      muscleGroups: null,
    });
    expect(spies.values).toHaveBeenCalledWith({
      activityId: "activity-1",
      exerciseId: "exercise-id",
      exerciseIndex: 0,
      setIndex: 0,
      reps: 5,
      distanceMeters: null,
      notes: "strict",
      raw: expect.objectContaining({ REPS: "5" }),
    });
  });
  it("connects per-user credentials through the current login endpoint", async () => {
    const provider = new CrimpdProvider(async (input) => {
      expect(String(input)).toBe("https://api.crimpd.com/auth/jwt");
      return Response.json({
        success: true,
        user: { _id: "owner" },
        token: "access",
        refreshToken: "refresh",
        expiresIn: 3600,
        refreshExpiresIn: 7200,
      });
    });
    const setup = provider.authSetup();
    expect(setup.apiBaseUrl).toBe("https://api.crimpd.com");
    expect(await setup.automatedLogin?.("climber", "password")).toMatchObject({
      accessToken: "access",
      refreshToken: "refresh",
      providerAccountId: "owner",
    });
  });

  it("rejects a sync without an explicit owner", async () => {
    const { db } = createMockDatabase();
    const result = await new CrimpdProvider().sync(new SyncRun({ db, window: SyncWindow.full() }));
    expect(result).toMatchObject({
      recordsSynced: 0,
      errors: [expect.objectContaining({ message: "Crimpd sync requires a user context." })],
    });
  });

  it("tells an unconnected owner how to connect before requesting an export", async () => {
    const { db } = createMockDatabase();
    const provider = new CrimpdProvider(async () => {
      throw new Error("An unconnected account must not request data");
    });
    const result = await provider.sync(
      new SyncRun({ db, userId: "owner", window: SyncWindow.full() }),
    );
    expect(result).toMatchObject({
      recordsSynced: 0,
      errors: [
        expect.objectContaining({ message: expect.stringMatching(/Connect.*Data Sources/) }),
      ],
    });
  });
  it.each([false, true])(
    "downloads and imports through private temporary storage, renewing when expired=%s",
    async (expired) => {
      vi.useFakeTimers();
      const start = new Date("2026-11-01T00:00:00Z");
      vi.setSystemTime(start);
      mocks.load.mockResolvedValue({
        ...accountTokens,
        expiresAt: expired ? start : accountTokens.expiresAt,
      });
      let path = "";
      mocks.archive.mockImplementation(async (filePath: string) => {
        path = filePath;
        expect(await readFile(filePath)).toEqual(Buffer.from([80, 75, 3, 4]));
        expect((await stat(filePath)).mode & 0o777).toBe(0o600);
        return {
          workoutsCsv: `${crimpdWorkoutHeader}\n${crimpdWorkoutRow()}`,
          setsCsv: crimpdSetHeader,
        };
      });
      const provider = new CrimpdProvider(async (input, init) => {
        if (String(input).endsWith("/auth/refresh"))
          return Response.json({
            success: true,
            user: { _id: "account" },
            token: "new-access",
            refreshToken: "new-refresh",
            expiresIn: 3600,
          });
        expect(new Headers(init?.headers).get("authorization")).toBe(
          expired ? "Bearer new-access" : "Bearer old-access",
        );
        if (expired)
          expect(mocks.save).toHaveBeenCalledWith(
            expect.anything(),
            "crimpd",
            expect.objectContaining({ refreshToken: "new-refresh" }),
            "owner",
          );
        vi.setSystemTime(new Date(start.getTime() + 17));
        return new Response(new Uint8Array([80, 75, 3, 4]), {
          headers: { "content-type": "application/zip" },
        });
      });
      const { db } = createMockDatabase();
      expect(
        await provider.sync(new SyncRun({ db, userId: "owner", window: SyncWindow.full() })),
      ).toEqual({ provider: "crimpd", recordsSynced: 1, errors: [], duration: 17 });
      expect(mocks.log).toHaveBeenCalledWith(
        db,
        "crimpd",
        "activity",
        expect.any(Function),
        "owner",
      );
      expect(mocks.upsert).toHaveBeenCalledTimes(1);
      expect(mocks.graph).toHaveBeenCalledWith(expect.anything(), {
        providerId: "crimpd",
        userId: "owner",
        entries: [],
      });
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  it("renews rejected access once and reports a rejected replacement", async () => {
    mocks.load.mockResolvedValue(accountTokens);
    let renewals = 0;
    const provider = new CrimpdProvider(async (input) => {
      if (String(input).endsWith("/auth/refresh")) {
        renewals++;
        return Response.json({
          success: true,
          user: { _id: "account" },
          token: "new-access",
          refreshToken: "new-refresh",
          expiresIn: 3600,
        });
      }
      return new Response(null, { status: 401 });
    });
    const { db } = createMockDatabase();
    const result = await provider.sync(
      new SyncRun({ db, userId: "owner", window: SyncWindow.full() }),
    );
    expect(renewals).toBe(1);
    expect(result).toMatchObject({
      recordsSynced: 0,
      errors: [expect.objectContaining({ message: expect.stringMatching(/Reconnect/) })],
    });
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.archive).not.toHaveBeenCalled();
    expect(mocks.capture).toHaveBeenCalledWith(expect.any(Error), {
      tags: { provider: "crimpd", phase: "activity" },
    });
  });
  it("propagates retryable transport failures to the queue", async () => {
    mocks.load.mockResolvedValue(accountTokens);
    const { db } = createMockDatabase();
    await expect(
      new CrimpdProvider(async () => new Response(null, { status: 503 })).sync(
        new SyncRun({ db, userId: "owner", window: SyncWindow.full() }),
      ),
    ).rejects.toMatchObject({ statusCode: 503 });
  });
  it("propagates cancellation without reporting a provider exception", async () => {
    mocks.load.mockResolvedValue(accountTokens);
    const controller = new AbortController();
    const reason = new Error("Cancelled by owner");
    const { db } = createMockDatabase();
    const provider = new CrimpdProvider(async () => {
      controller.abort(reason);
      return new Response(new Uint8Array([80, 75]), {
        headers: { "content-type": "application/zip" },
      });
    });
    await expect(
      provider.sync(
        new SyncRun({ db, userId: "owner", window: SyncWindow.full(), signal: controller.signal }),
      ),
    ).rejects.toThrow(reason);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.archive).not.toHaveBeenCalled();
  });
  it.each([new Error("archive rejected"), "archive rejected"])(
    "reports import failure and removes its private file",
    async (failure) => {
      mocks.load.mockResolvedValue(accountTokens);
      let path = "";
      mocks.archive.mockImplementation(async (filePath: string) => {
        path = filePath;
        throw failure;
      });
      const { db } = createMockDatabase();
      const result = await new CrimpdProvider(
        async () =>
          new Response(new Uint8Array([80, 75]), {
            headers: { "content-type": "application/zip" },
          }),
      ).sync(new SyncRun({ db, userId: "owner", window: SyncWindow.full() }));
      expect(result.errors).toEqual([{ message: "archive rejected", cause: failure }]);
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});
