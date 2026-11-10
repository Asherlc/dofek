import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => {
  const subscription = { waitForFirstSync: vi.fn<(...args: unknown[]) => Promise<void>>() };
  const database = {
    connect: vi.fn(),
    syncStream: vi.fn(() => ({ subscribe: vi.fn(async () => subscription) })),
    registerListener: vi.fn<
      (listener: {
        statusChanged: (status: { dataFlowStatus: { downloadError?: Error } }) => void;
      }) => () => void
    >(() => () => undefined),
    getAll: vi.fn<(query: string) => Promise<unknown[]>>(),
    close: vi.fn(),
  };
  const create = vi.fn(function MockPowerSyncDatabase(_options: {
    database: { dbFilename: string };
    remoteOptions: { fetchImplementation: typeof fetch };
  }) {
    return database;
  });
  return { database, subscription, create };
});
vi.mock("@powersync/node", async (original) => ({
  ...(await original<typeof import("@powersync/node")>()),
  PowerSyncDatabase: sdk.create,
}));

import { KilterBoardDirectory } from "./kilter-board-directory.ts";

const wall = { wall_uuid: "wall", name: "Main board", gym_uuid: "gym" };
const gym = { gym_uuid: "gym", name: "Climbing gym", latitude: 0, longitude: -122.1 };
const credentials = async () => ({ token: "access", expiresAt: new Date("2099-01-01") });
const mirror = () => dirname(sdk.create.mock.calls[0]?.[0].database.dbFilename ?? "missing");

beforeEach(() => {
  vi.clearAllMocks();
  sdk.database.connect.mockResolvedValue(undefined);
  sdk.database.close.mockResolvedValue(undefined);
  sdk.subscription.waitForFirstSync.mockResolvedValue(undefined);
  sdk.database.getAll.mockImplementation(async (query) =>
    query.includes("FROM walls") ? [wall] : [gym],
  );
});
afterEach(() => vi.restoreAllMocks());

describe("KilterBoardDirectory", () => {
  it("reads the board/gym subscription, renews credentials through the caller and removes its mirror", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
    expect(await new KilterBoardDirectory(transport).fetch(credentials)).toEqual({
      walls: [wall],
      gyms: [gym],
    });
    const network = sdk.create.mock.calls[0]?.[0].remoteOptions.fetchImplementation;
    const sdkAbort = new AbortController();
    await network?.("https://sync1.kiltergrips.com/sync/stream", { signal: sdkAbort.signal });
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(sdk.database.syncStream).toHaveBeenCalledWith("global_gyms");
    const [connector, options] = sdk.database.connect.mock.calls[0] ?? [];
    expect(options).toMatchObject({ includeDefaultStreams: false });
    expect(await connector.fetchCredentials()).toEqual({
      endpoint: "https://sync1.kiltergrips.com",
      ...(await credentials()),
    });
    expect(sdk.subscription.waitForFirstSync).toHaveBeenCalledOnce();
    expect(sdk.database.close).toHaveBeenCalledOnce();
    expect(existsSync(mirror())).toBe(false);
  });

  it("preserves unknown names, homewall gym associations and incomplete coordinates", async () => {
    sdk.database.getAll.mockImplementation(async (query) =>
      query.includes("FROM walls")
        ? [{ wall_uuid: "wall", name: " ", gym_uuid: null }]
        : [{ gym_uuid: "gym", name: null, latitude: null, longitude: null }],
    );
    expect(await new KilterBoardDirectory().fetch(credentials)).toEqual({
      walls: [{ wall_uuid: "wall", name: null, gym_uuid: null }],
      gyms: [{ gym_uuid: "gym", name: null, latitude: null, longitude: null }],
    });
  });

  it.each([
    { walls: [{ name: "Board" }] },
    { walls: [wall, wall] },
    { walls: [{ ...wall, wall_uuid: "" }] },
  ])("rejects malformed or ambiguous wall identities and cleans up (%j)", async ({ walls }) => {
    sdk.database.getAll.mockImplementation(async (query) =>
      query.includes("FROM walls") ? walls : [gym],
    );
    await expect(new KilterBoardDirectory().fetch(credentials)).rejects.toThrow();
    expect(sdk.database.close).toHaveBeenCalledOnce();
    expect(existsSync(mirror())).toBe(false);
  });

  it.each([
    { gyms: [{ ...gym, latitude: 91 }] },
    { gyms: [gym, gym] },
    { gyms: [{ ...gym, gym_uuid: "" }] },
  ])("rejects invalid gym facts (%j)", async ({ gyms }) => {
    sdk.database.getAll.mockImplementation(async (query) =>
      query.includes("FROM walls") ? [wall] : gyms,
    );
    await expect(new KilterBoardDirectory().fetch(credentials)).rejects.toThrow();
    expect(existsSync(mirror())).toBe(false);
  });

  it("propagates sync errors instead of waiting for reconnects", async () => {
    const failure = new Error("Directory authorization rejected");
    sdk.subscription.waitForFirstSync.mockImplementationOnce(async () => {
      sdk.database.registerListener.mock.calls[0]?.[0].statusChanged({
        dataFlowStatus: { downloadError: failure },
      });
    });
    await expect(new KilterBoardDirectory().fetch(credentials)).rejects.toBe(failure);
    expect(existsSync(mirror())).toBe(false);
  });

  it("treats SDK abort completion as cancellation rather than a successful empty directory", async () => {
    const controller = new AbortController();
    sdk.subscription.waitForFirstSync.mockImplementationOnce(async () => controller.abort());
    await expect(
      new KilterBoardDirectory().fetch(credentials, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(existsSync(mirror())).toBe(false);
  });

  it("propagates the first-sync deadline", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
    sdk.subscription.waitForFirstSync.mockImplementationOnce(async () =>
      deadline.abort(new DOMException("Deadline", "TimeoutError")),
    );
    await expect(new KilterBoardDirectory().fetch(credentials)).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(existsSync(mirror())).toBe(false);
  });

  it("does not start work when already cancelled", async () => {
    await expect(
      new KilterBoardDirectory().fetch(credentials, AbortSignal.abort()),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it.each(["caller", "deadline"])(
    "cancels pending SDK credentials on %s cancellation and closes the mirror",
    async (kind) => {
      const controller = new AbortController();
      if (kind === "deadline")
        vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(controller.signal);
      let release: (value: Awaited<ReturnType<typeof credentials>>) => void = () => undefined;
      const credential = new Promise<Awaited<ReturnType<typeof credentials>>>((resolve) => {
        release = resolve;
      });
      sdk.database.connect.mockImplementationOnce(async (connector) => {
        await connector.fetchCredentials();
      });
      const completion = new KilterBoardDirectory()
        .fetch(() => credential, kind === "caller" ? controller.signal : undefined)
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      try {
        await vi.waitFor(() => expect(sdk.database.connect).toHaveBeenCalledOnce());
        controller.abort();
        await vi.waitFor(() => expect(sdk.database.close).toHaveBeenCalledOnce());
        expect(await completion).toEqual({ error: controller.signal.reason });
        expect(existsSync(mirror())).toBe(false);
      } finally {
        release(await credentials());
        await completion;
      }
    },
  );

  it("removes the disposable directory even when connection or close fails", async () => {
    sdk.database.connect.mockRejectedValueOnce(new Error("Unavailable"));
    await expect(new KilterBoardDirectory().fetch(credentials)).rejects.toThrow("Unavailable");
    expect(existsSync(mirror())).toBe(false);
    sdk.database.close.mockRejectedValueOnce(new Error("Close failed"));
    await expect(new KilterBoardDirectory().fetch(credentials)).rejects.toThrow("Close failed");
    expect(
      existsSync(dirname(sdk.create.mock.calls[1]?.[0].database.dbFilename ?? "missing")),
    ).toBe(false);
  });
});
