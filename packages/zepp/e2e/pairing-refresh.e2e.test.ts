import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createImuChunkEnvelope } from "../src/imu-upload.ts";
import { STORAGE_KEYS } from "../src/storage-keys.ts";

interface RuntimeWidget {
  kind: string;
  properties: Record<string, unknown>;
  setProperty(property: string, value: unknown): void;
}

interface WatchCallPayload {
  method: string;
  params?: Record<string, unknown>;
}

interface SideRuntime {
  call(payload: WatchCallPayload): void;
  onRequest(
    request: { method: string; params?: Record<string, unknown> },
    respond: (error: unknown, result: unknown) => void,
  ): void;
  startPairing(): Promise<Record<string, unknown> | null>;
  disconnect(): Promise<void>;
  verifyConnection(): Promise<void>;
  onReceivedFile(file: {
    fileName?: string;
    filePath?: string;
    params?: Record<string, unknown>;
    on(
      event: string,
      callback: (event: { data: Record<string, unknown> }) => void,
    ): void;
  }): void;
}

interface WatchRuntime {
  state: {
    hasCredentials: boolean;
    healthOwnership?: Promise<{ release(): Promise<void> }>;
    transferTask?: unknown;
  };
  acquireHealthOwnership(): void;
  build(): void;
  onCall(payload: WatchCallPayload): void;
  onInit(): void;
  request(request: { method: string; params?: Record<string, unknown> }): Promise<unknown>;
  sendFile(
    path: string,
    params: Record<string, unknown>,
  ): { on(event: string, callback: (event: { data: Record<string, unknown> }) => void): void };
  startTransfer(transfer: {
    observedHzX100: number;
    path: string;
    sampleCount: number;
    sessionStartMs: number;
    slot: "A" | "B";
  }): void;
}

let sideConfiguration: SideRuntime | undefined;
let watchConfiguration: WatchRuntime | undefined;

function requireSideConfiguration(): SideRuntime {
  if (!sideConfiguration) throw new Error("Side Service was not registered");
  return sideConfiguration;
}

function requireWatchConfiguration(): WatchRuntime {
  if (!watchConfiguration) throw new Error("watch page was not registered");
  return watchConfiguration;
}

beforeAll(async () => {
  vi.stubGlobal("Logger", {
    getLogger: () => ({ error: vi.fn(), log: vi.fn() }),
  });
  vi.stubGlobal("DOFEK_COMPANION_CONNECTION_TYPE", "zepp-main");
  vi.stubGlobal("AppSideService", (configuration: SideRuntime) => {
    sideConfiguration = configuration;
  });
  vi.stubGlobal("Page", (configuration: WatchRuntime) => {
    watchConfiguration = configuration;
  });

  await import("../app-side/index.ts");
  await import("../page/index.ts");
});

afterAll(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Zepp pairing refresh", () => {
  it("moves an open watch page from its pairing QR to connected as soon as pairing is claimed", async () => {
    vi.useFakeTimers();
    const values = new Map<string, string>();
    const settingsStorage = {
      addListener: vi.fn(),
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      removeItem: vi.fn((key: string) => values.delete(key)),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    };
    vi.stubGlobal("settings", { settingsStorage });

    const widgets: RuntimeWidget[] = [];
    const deletedWidgets: RuntimeWidget[] = [];
    vi.stubGlobal(
      "createWidget",
      (kind: string, properties: Record<string, unknown>): RuntimeWidget => {
        const widget = {
          kind,
          properties: { ...properties },
          setProperty(property: string, value: unknown) {
            this.properties[property] = value;
          },
        };
        widgets.push(widget);
        return widget;
      },
    );
    vi.stubGlobal("deleteWidget", (widget: RuntimeWidget) => {
      deletedWidgets.push(widget);
    });

    const pairing = {
      expiresAt: "2099-01-01T00:00:00.000Z",
      pairingId: "pairing-1",
      qrImageUrl: "https://app.example.test/api/companion-pairing/qr/pairing-1.svg",
      shortCode: "ABC234",
      verificationUrl: "https://app.example.test/zepp-pairing?code=ABC234",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: { url?: string }) => {
        if (request.url?.endsWith("/api/companion-pairing/start")) {
          return { status: 200, body: pairing };
        }
        if (request.url?.includes("/api/companion-pairing/status/")) {
          return {
            status: 200,
            body: { state: "claimed", companionToken: "companion-token" },
          };
        }
        return { status: 200, body: { ok: true } };
      }),
    );

    const side = Object.assign({}, requireSideConfiguration());
    const watchConfig = requireWatchConfiguration();
    const watch = Object.assign({}, watchConfig, { state: { ...watchConfig.state } });
    const calls: WatchCallPayload[] = [];
    side.call = (payload) => {
      calls.push(payload);
      watch.onCall(payload);
    };
    watch.request = (request) =>
      new Promise((resolve, reject) => {
        side.onRequest(request, (error, result) => {
          if (error) reject(error);
          else resolve(result);
        });
      });

    await side.startPairing();
    watch.build();
    watch.onInit();
    await Promise.resolve();

    const pairingQr = widgets.find((widget) => widget.kind === "qrcode");
    expect(pairingQr?.properties.content).toBe(pairing.verificationUrl);
    expect(watch.state.hasCredentials).toBe(false);

    await vi.advanceTimersByTimeAsync(3_000);

    const connectionButton = widgets.find(
      (widget) => widget.kind === "button" && widget.properties.text === "Disconnect Dofek",
    );
    expect(calls).toContainEqual({ method: "dofek.connectionChanged", params: {} });
    expect(values.get(STORAGE_KEYS.DOFEK_API_TOKEN)).toBe("companion-token");
    expect(watch.state.hasCredentials).toBe(true);
    expect(connectionButton).toBeDefined();
    expect(deletedWidgets).toContain(pairingQr);
  });

  it("does not create a new pairing challenge after disconnecting", async () => {
    const values = new Map<string, string>();
    const settingsStorage = {
      addListener: vi.fn(),
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      removeItem: vi.fn((key: string) => values.delete(key)),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    };
    vi.stubGlobal("settings", { settingsStorage });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const side = Object.assign({}, requireSideConfiguration());
    const watchConfig = requireWatchConfiguration();
    const watch = Object.assign({}, watchConfig, { state: { ...watchConfig.state } });
    side.call = (payload) => watch.onCall(payload);
    watch.request = (request) =>
      new Promise((resolve, reject) => {
        side.onRequest(request, (error, result) => {
          if (error) reject(error);
          else resolve(result);
        });
      });

    await side.disconnect();
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("notifies an open watch page when a mismatched credential is cleared", async () => {
    const values = new Map<string, string>([
      [STORAGE_KEYS.DOFEK_API_TOKEN, "wrong-app-token"],
    ]);
    const settingsStorage = {
      addListener: vi.fn(),
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      removeItem: vi.fn((key: string) => values.delete(key)),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    };
    vi.stubGlobal("settings", { settingsStorage });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 200,
        body: { state: "connected", connectionType: "zepp-workout" },
      })),
    );

    const side = Object.assign({}, requireSideConfiguration());
    const calls: WatchCallPayload[] = [];
    side.call = (payload) => calls.push(payload);

    await expect(side.verifyConnection()).rejects.toThrow(
      "Saved credentials belong to a different Zepp app",
    );
    expect(calls).toContainEqual({ method: "dofek.connectionChanged", params: {} });
  });

  it("retains the SDK reason when a received IMU file transfer fails", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("settings", {
      settingsStorage: {
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        removeItem: vi.fn((key: string) => values.delete(key)),
        setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      },
    });
    const side = Object.assign({}, requireSideConfiguration());

    side.onReceivedFile({
      fileName: "normal_a.bin",
      params: { segmentId: "segment-1", source: "zepp" },
      on(event, callback) {
        if (event === "change") {
          callback({
            data: { readyState: "error", error: "Bluetooth connection was interrupted." },
          });
        }
      },
    });

    expect(JSON.parse(values.get(STORAGE_KEYS.TRANSFER_PROGRESS) ?? "{}")).toEqual({
      state: "error",
      reason: "Bluetooth connection was interrupted.",
      segmentId: "segment-1",
      source: "zepp",
    });
  });

  it("records a received IMU file transfer cancellation", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("settings", {
      settingsStorage: {
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        removeItem: vi.fn((key: string) => values.delete(key)),
        setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      },
    });
    const side = Object.assign({}, requireSideConfiguration());

    side.onReceivedFile({
      fileName: "normal_a.bin",
      params: { segmentId: "segment-1", source: "zepp" },
      on(event, callback) {
        if (event === "change") callback({ data: { readyState: "canceled" } });
      },
    });

    expect(JSON.parse(values.get(STORAGE_KEYS.TRANSFER_PROGRESS) ?? "{}")).toEqual({
      state: "error",
      reason: "IMU transfer was canceled.",
      segmentId: "segment-1",
      source: "zepp",
    });
  });

  it("persists a synchronous App Service start failure", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("settings", {
      settingsStorage: {
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        removeItem: vi.fn((key: string) => values.delete(key)),
        setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      },
    });
    vi.stubGlobal("appServiceStop", vi.fn(() => 2));
    vi.stubGlobal("appServiceStart", vi.fn(() => {
      throw new Error("App Service unavailable");
    }));
    const watchConfig = requireWatchConfiguration();
    const watch = Object.assign({}, watchConfig, {
      state: { ...watchConfig.state },
      collectAndDeliverHealth: vi.fn(),
    });

    watch.acquireHealthOwnership();
    const ownership = await watch.state.healthOwnership;

    await expect(ownership?.release()).rejects.toThrow("App Service unavailable");
    expect(JSON.parse(values.get(STORAGE_KEYS.HEALTH_SERVICE_STATUS) ?? "{}")).toEqual({
      state: "error",
      reason: "App Service unavailable",
    });
  });

  it("keeps the normal transfer barrier until phone persistence is confirmed", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("settings", {
      settingsStorage: {
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        removeItem: vi.fn((key: string) => values.delete(key)),
        setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      },
    });
    const callbacks = new Map<string, (event: { data: Record<string, unknown> }) => void>();
    const task = {
      on: vi.fn((event: string, callback: (event: { data: Record<string, unknown> }) => void) => {
        callbacks.set(event, callback);
      }),
    };
    let confirmPersistence: ((value: { ok: true }) => void) | undefined;
    const watchConfig = requireWatchConfiguration();
    const transfer = {
      observedHzX100: 2_500,
      path: "data://normal_a.bin",
      sampleCount: 120,
      sessionStartMs: 1_720_000_000_000,
      slot: "A" as const,
    };
    const watch = Object.assign({}, watchConfig, {
      state: { ...watchConfig.state, pendingImuA: transfer },
      sendFile: vi.fn(() => task),
      request: vi.fn(
        () =>
          new Promise<{ ok: true }>((resolve) => {
            confirmPersistence = resolve;
          }),
      ),
    });

    watch.startTransfer(transfer);
    callbacks.get("change")?.({ data: { readyState: "transferred" } });

    expect(watch.state.transferTask).toBe(task);
    confirmPersistence?.({ ok: true });
    await vi.waitFor(() => expect(watch.state.transferTask).toBeNull());
    expect(watch.state.pendingImuA).toBeNull();
  });

  it("does not acknowledge a watch binary backup until the phone registry contains it", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("settings", {
      settingsStorage: {
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        removeItem: vi.fn((key: string) => values.delete(key)),
        setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      },
    });
    const side = Object.assign({}, requireSideConfiguration());
    const response = await new Promise<{ error: unknown; result: unknown }>((resolve) => {
      side.onRequest(
        {
          method: "imu.transferComplete",
          params: { segmentId: "segment-missing", source: "zepp" },
        },
        (error, result) => resolve({ error, result }),
      );
    });

    expect(response.error).toMatchObject({
      message: "Phone has not persisted the IMU binary backup yet.",
    });
    expect(response.result).toBeNull();
  });

  it("surfaces registry persistence failure instead of marking a received backup done", () => {
    const values = new Map<string, string>();
    values.set(STORAGE_KEYS.IMU_SYNC_STATUS, JSON.stringify({ state: "done", uploaded: 1 }));
    const persistenceError = new Error("Settings storage unavailable");
    vi.stubGlobal("settings", {
      settingsStorage: {
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        removeItem: vi.fn((key: string) => values.delete(key)),
        setItem: vi.fn((key: string, value: string) => {
          if (key === STORAGE_KEYS.PHONE_IMU_FILES) throw persistenceError;
          values.set(key, value);
        }),
      },
    });
    const side = Object.assign({}, requireSideConfiguration());

    side.onReceivedFile({
      fileName: "normal_a.bin",
      filePath: "data://inbox/normal_a.bin",
      params: { segmentId: "segment-1", source: "zepp", sampleCount: "120" },
      on(event, callback) {
        if (event === "change") callback({ data: { readyState: "transferred" } });
      },
    });

    expect(JSON.parse(values.get(STORAGE_KEYS.TRANSFER_PROGRESS) ?? "{}")).toMatchObject({
      state: "error",
      segmentId: "segment-1",
      source: "zepp",
      reason: "Settings storage unavailable",
    });
    expect(JSON.parse(values.get(STORAGE_KEYS.IMU_SYNC_STATUS) ?? "{}")).toMatchObject({
      state: "done",
      uploaded: 1,
    });
  });

  it("keeps a binary transfer failure visible after a successful chunk drain", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("settings", {
      settingsStorage: {
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        removeItem: vi.fn((key: string) => values.delete(key)),
        setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      },
    });
    const side = Object.assign({}, requireSideConfiguration());
    side.onReceivedFile({
      params: { segmentId: "segment-1", source: "zepp" },
      on(event, callback) {
        if (event === "change") {
          callback({ data: { readyState: "error", error: "Bluetooth interrupted" } });
        }
      },
    });

    const envelope = createImuChunkEnvelope({
      connectionType: "zepp",
      installId: "install-1",
      segmentId: "segment-1",
      sessionStartMs: 1_720_000_000_000,
      samples: [{ tMs: 0, ax: 1, ay: 2, az: 3, gx: 4, gy: 5, gz: 6 }],
    });
    await new Promise<void>((resolve, reject) => {
      side.onRequest({ method: "imu.uploadChunk", params: { envelope } }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    await Promise.resolve();

    expect(JSON.parse(values.get(STORAGE_KEYS.TRANSFER_PROGRESS) ?? "{}")).toMatchObject({
      state: "error",
      reason: "Bluetooth interrupted",
    });
  });
});
