import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { Schema } from "@powersync/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => {
  const subscription = { waitForFirstSync: vi.fn<(...args: unknown[]) => Promise<void>>() };
  const subscribe = vi.fn(async () => subscription);
  const dispose = vi.fn();
  const database = {
    connect: vi.fn(),
    waitForFirstSync: vi.fn(),
    syncStream: vi.fn(() => ({ subscribe })),
    registerListener: vi.fn<
      (listener: {
        statusChanged: (status: {
          dataFlowStatus: { downloadError?: { name: string; message: string; stack?: string } };
        }) => void;
      }) => () => void
    >(() => dispose),
    getAll: vi.fn<(query: string) => Promise<unknown[]>>(),
    close: vi.fn(),
  };
  const create = vi.fn(function MockPowerSyncDatabase(_options: {
    database: { dbFilename: string; implementation: { type: string } };
    remoteOptions: { fetchImplementation: typeof fetch };
    schema: Schema;
  }) {
    return database;
  });
  return { database, subscription, subscribe, dispose, create };
});
vi.mock("node:fs/promises", async (original) => {
  const filesystem = await original<typeof import("node:fs/promises")>();
  return { ...filesystem, mkdtemp: vi.fn(filesystem.mkdtemp) };
});
vi.mock("@powersync/node", async (original) => ({
  ...(await original<typeof import("@powersync/node")>()),
  PowerSyncDatabase: sdk.create,
}));

import { KilterBoardDirectory } from "./kilter-board-directory.ts";

const wall = { wall_uuid: "wall", name: "Main board", gym_uuid: "gym" };
const gym = { gym_uuid: "gym", name: "Climbing gym", latitude: 0, longitude: -122.1 };
const nativeLog = { log_uuid: "native-log", climb_uuid: "problem", angle: 45, attempts: 3 };
const credentials = async () => ({ token: "access", expiresAt: new Date("2099-01-01") });
const mirror = () => dirname(sdk.create.mock.calls[0]?.[0].database.dbFilename ?? "missing");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  sdk.database.connect.mockResolvedValue(undefined);
  sdk.subscribe.mockResolvedValue(sdk.subscription);
  sdk.database.close.mockResolvedValue(undefined);
  sdk.subscription.waitForFirstSync.mockResolvedValue(undefined);
  sdk.database.getAll.mockImplementation(async (query) =>
    query.includes("FROM logs") ? [nativeLog] : query.includes("FROM walls") ? [wall] : [gym],
  );
});
afterEach(() => vi.restoreAllMocks());

describe("KilterBoardDirectory", () => {
  it("does not read counts before the user's initial app sync completes", async () => {
    const sync = deferred<void>();
    sdk.database.waitForFirstSync.mockReturnValueOnce(sync.promise);
    const completion = new KilterBoardDirectory().fetch(credentials);
    try {
      await vi.waitFor(() => expect(sdk.database.waitForFirstSync).toHaveBeenCalledOnce());
      expect(sdk.database.getAll).not.toHaveBeenCalled();
    } finally {
      sync.resolve();
      await completion;
    }
  });
  it.each(
    [
      [{ ...nativeLog, attempts: -1 }],
      [{ ...nativeLog, attempts: 1.5 }],
      [{ ...nativeLog, log_uuid: "" }],
      [{ ...nativeLog, climb_uuid: "" }],
      [nativeLog, nativeLog],
    ].map((logs) => ({ logs })),
  )("rejects invalid app-sync log facts: %j", async ({ logs }) => {
    sdk.database.getAll.mockImplementation(async (query) =>
      query.includes("FROM logs") ? logs : query.includes("FROM walls") ? [wall] : [gym],
    );
    await expect(new KilterBoardDirectory().fetch(credentials)).rejects.toThrow();
    expect(sdk.database.close).toHaveBeenCalledOnce();
    expect(existsSync(mirror())).toBe(false);
  });
  it("waits for user log sync and retains the native attempt count", async () => {
    const log = { log_uuid: "native-log", climb_uuid: "problem", angle: 45, attempts: 3 };
    sdk.database.getAll.mockImplementation(async (query) =>
      query.includes("FROM logs")
        ? [nativeLog]
        : query.includes("FROM walls")
          ? [wall]
          : query.includes("FROM logs")
            ? [log]
            : [gym],
    );
    const result = await new KilterBoardDirectory().fetch(credentials);
    expect(result).toMatchObject({ logs: [log] });
    expect(sdk.database.connect.mock.calls[0]?.[1]).toMatchObject({ includeDefaultStreams: true });
    expect(sdk.database.waitForFirstSync).toHaveBeenCalledOnce();
  });

  it("reads the board/gym subscription, renews credentials through the caller and removes its mirror", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
    expect(await new KilterBoardDirectory(transport).fetch(credentials)).toEqual({
      walls: [wall],
      gyms: [gym],
      logs: [nativeLog],
    });
    const network = sdk.create.mock.calls[0]?.[0].remoteOptions.fetchImplementation;
    const sdkAbort = new AbortController();
    await network?.("https://sync1.kiltergrips.com/sync/stream", { signal: sdkAbort.signal });
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(sdk.database.syncStream).toHaveBeenCalledWith("global_gyms");
    const [connector, options] = sdk.database.connect.mock.calls[0] ?? [];
    expect(options).toMatchObject({ includeDefaultStreams: true });
    expect(await connector.fetchCredentials()).toEqual({
      endpoint: "https://sync1.kiltergrips.com",
      ...(await credentials()),
    });
    expect(sdk.subscription.waitForFirstSync).toHaveBeenCalledOnce();
    expect(sdk.database.close).toHaveBeenCalledOnce();
    expect(sdk.dispose).toHaveBeenCalledOnce();
    expect(existsSync(mirror())).toBe(false);
  });

  it("initializes schemas that retain distinct boards, source names, identities and coordinate boundaries", async () => {
    vi.resetModules();
    const { KilterBoardDirectory: FreshDirectory } = await import("./kilter-board-directory.ts");
    sdk.database.getAll.mockImplementation(async (query) =>
      query.includes("FROM logs")
        ? [nativeLog]
        : query.includes("FROM walls")
          ? [
              { wall_uuid: " wall-a ", name: " Main board ", gym_uuid: " gym-a " },
              { wall_uuid: "wall-b", name: null, gym_uuid: "gym-b" },
              { wall_uuid: "wall-c" },
            ]
          : [
              { gym_uuid: " gym-a ", name: " Gym A ", latitude: -90, longitude: 180 },
              { gym_uuid: "gym-b", name: "Gym B", latitude: 90, longitude: -180 },
              { gym_uuid: "gym-c", name: " " },
            ],
    );
    expect(await new FreshDirectory().fetch(credentials)).toEqual({
      walls: [
        { wall_uuid: "wall-a", name: "Main board", gym_uuid: "gym-a" },
        { wall_uuid: "wall-b", name: null, gym_uuid: "gym-b" },
        { wall_uuid: "wall-c", name: null, gym_uuid: null },
      ],
      gyms: [
        { gym_uuid: "gym-a", name: "Gym A", latitude: -90, longitude: 180 },
        { gym_uuid: "gym-b", name: "Gym B", latitude: 90, longitude: -180 },
        { gym_uuid: "gym-c", name: null, latitude: null, longitude: null },
      ],
      logs: [nativeLog],
    });
  });

  it("provides the SDK with both directory tables and the built-in SQLite engine", async () => {
    await new KilterBoardDirectory().fetch(credentials);
    const options = sdk.create.mock.calls[0]?.[0];
    expect(options?.database.implementation).toEqual({ type: "node:sqlite" });
    expect(options?.schema.toJSON().tables.map(({ name, columns }) => ({ name, columns }))).toEqual(
      [
        {
          name: "gyms",
          columns: [
            { name: "gym_uuid", type: "TEXT" },
            { name: "name", type: "TEXT" },
            { name: "latitude", type: "REAL" },
            { name: "longitude", type: "REAL" },
          ],
        },
        {
          name: "walls",
          columns: [
            { name: "wall_uuid", type: "TEXT" },
            { name: "name", type: "TEXT" },
            { name: "gym_uuid", type: "TEXT" },
          ],
        },
        {
          name: "logs",
          columns: [
            { name: "log_uuid", type: "TEXT" },
            { name: "climb_uuid", type: "TEXT" },
            { name: "angle", type: "REAL" },
            { name: "attempts", type: "INTEGER" },
          ],
        },
      ],
    );
  });

  it.each(["caller", "SDK"])(
    "cancels an active directory request from the %s signal",
    async (source) => {
      const sync = deferred<void>();
      sdk.subscription.waitForFirstSync.mockReturnValueOnce(sync.promise);
      const caller = new AbortController();
      const request = new AbortController();
      const failure = new Error(`${source} cancelled`);
      const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
      const completion = new KilterBoardDirectory(transport).fetch(credentials, caller.signal).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await vi.waitFor(() => expect(sdk.subscription.waitForFirstSync).toHaveBeenCalledOnce());
        const network = sdk.create.mock.calls[0]?.[0].remoteOptions.fetchImplementation;
        await network?.("https://sync1.kiltergrips.com/sync/stream", {
          signal: request.signal,
          headers: { authorization: "SDK credentials" },
        });
        const signal = transport.mock.calls[0]?.[1]?.signal;
        expect(signal?.aborted).toBe(false);
        expect(transport.mock.calls[0]?.[1]?.headers).toEqual({ authorization: "SDK credentials" });
        (source === "caller" ? caller : request).abort(failure);
        expect(signal?.aborted).toBe(true);
        expect(signal?.reason).toBe(failure);
        sync.resolve();
        if (source === "caller") expect(await completion).toEqual({ error: failure });
        else
          expect(await completion).toEqual({
            value: { walls: [wall], gyms: [gym], logs: [nativeLog] },
          });
      } finally {
        sync.resolve();
        await completion;
      }
    },
  );

  it("accepts SDK fetch calls without request options", async () => {
    const sync = deferred<void>();
    sdk.subscription.waitForFirstSync.mockReturnValueOnce(sync.promise);
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
    const completion = new KilterBoardDirectory(transport).fetch(credentials);
    try {
      await vi.waitFor(() => expect(sdk.subscription.waitForFirstSync).toHaveBeenCalledOnce());
      await sdk.create.mock.calls[0]?.[0].remoteOptions.fetchImplementation(
        "https://sync1.kiltergrips.com/sync/stream",
      );
      expect(transport).toHaveBeenCalledOnce();
      expect(transport.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    } finally {
      sync.resolve();
      await completion;
    }
  });

  it("continues after a healthy download status and detaches its listener", async () => {
    sdk.subscription.waitForFirstSync.mockImplementationOnce(async () => {
      sdk.database.registerListener.mock.calls[0]?.[0].statusChanged({ dataFlowStatus: {} });
    });
    expect(await new KilterBoardDirectory().fetch(credentials)).toEqual({
      walls: [wall],
      gyms: [gym],
      logs: [nativeLog],
    });
    expect(sdk.dispose).toHaveBeenCalledOnce();
  });

  it("cancels a pending subscription with the caller's reason", async () => {
    const subscription = deferred<typeof sdk.subscription>();
    sdk.subscribe.mockReturnValueOnce(subscription.promise);
    const controller = new AbortController();
    const failure = new Error("Subscription cancelled");
    const completion = new KilterBoardDirectory().fetch(credentials, controller.signal);
    const rejected = expect(completion).rejects.toBe(failure);
    try {
      await vi.waitFor(() => expect(sdk.subscribe).toHaveBeenCalledOnce());
      controller.abort(failure);
      await rejected;
      expect(sdk.database.close).toHaveBeenCalledOnce();
      expect(sdk.dispose).toHaveBeenCalledOnce();
    } finally {
      subscription.resolve(sdk.subscription);
    }
  });

  it("does not initialize SQLite when cancelled during mirror creation", async () => {
    const filesystem = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const controller = new AbortController();
    const failure = new Error("Mirror creation cancelled");
    let directory = "";
    vi.mocked(mkdtemp).mockImplementationOnce(async (prefix) => {
      directory = await filesystem.mkdtemp(prefix);
      controller.abort(failure);
      return directory;
    });
    await expect(new KilterBoardDirectory().fetch(credentials, controller.signal)).rejects.toBe(
      failure,
    );
    expect(sdk.create).not.toHaveBeenCalled();
    expect(existsSync(directory)).toBe(false);
  });

  it("rejects cancellation during the final directory read", async () => {
    const controller = new AbortController();
    const failure = new Error("Read cancelled");
    sdk.database.getAll.mockImplementation(async (query) => {
      if (query.includes("FROM walls")) return [wall];
      controller.abort(failure);
      return [gym];
    });
    await expect(new KilterBoardDirectory().fetch(credentials, controller.signal)).rejects.toBe(
      failure,
    );
    expect(existsSync(mirror())).toBe(false);
  });

  it("accepts a mirror already removed during SDK shutdown", async () => {
    sdk.database.close.mockImplementationOnce(async () => rm(mirror(), { recursive: true }));
    expect(await new KilterBoardDirectory().fetch(credentials)).toEqual({
      walls: [wall],
      gyms: [gym],
      logs: [nativeLog],
    });
  });

  it("preserves unknown names, home wall gym associations and incomplete coordinates", async () => {
    sdk.database.getAll.mockImplementation(async (query) =>
      query.includes("FROM logs")
        ? [nativeLog]
        : query.includes("FROM walls")
          ? [{ wall_uuid: "wall", name: " ", gym_uuid: null }]
          : [{ gym_uuid: "gym", name: null, latitude: null, longitude: null }],
    );
    expect(await new KilterBoardDirectory().fetch(credentials)).toEqual({
      walls: [{ wall_uuid: "wall", name: null, gym_uuid: null }],
      gyms: [{ gym_uuid: "gym", name: null, latitude: null, longitude: null }],
      logs: [nativeLog],
    });
  });

  it.each([
    { walls: [{ name: "Board" }] },
    { walls: [wall, wall] },
    { walls: [{ ...wall, wall_uuid: "" }] },
  ])("rejects malformed or ambiguous wall identities and cleans up (%j)", async ({ walls }) => {
    sdk.database.getAll.mockImplementation(async (query) =>
      query.includes("FROM logs") ? [nativeLog] : query.includes("FROM walls") ? walls : [gym],
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
      query.includes("FROM logs") ? [nativeLog] : query.includes("FROM walls") ? [wall] : gyms,
    );
    await expect(new KilterBoardDirectory().fetch(credentials)).rejects.toThrow();
    expect(existsSync(mirror())).toBe(false);
  });

  it("propagates serialized sync errors as errors instead of waiting for reconnects", async () => {
    const downloadError = { name: "Error", message: "Connection aborted", stack: "Error: at sdk" };
    sdk.subscription.waitForFirstSync.mockImplementationOnce(async () => {
      sdk.database.registerListener.mock.calls[0]?.[0].statusChanged({
        dataFlowStatus: { downloadError },
      });
    });
    const error = await new KilterBoardDirectory().fetch(credentials).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: "Kilter Board app sync failed: Connection aborted",
      cause: downloadError,
    });
    expect(existsSync(mirror())).toBe(false);
  });

  it("treats SDK abort completion as cancellation rather than a successful empty directory", async () => {
    const controller = new AbortController();
    sdk.subscription.waitForFirstSync.mockImplementationOnce(async () => controller.abort());
    await expect(
      new KilterBoardDirectory().fetch(credentials, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(sdk.database.getAll).not.toHaveBeenCalled();
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
