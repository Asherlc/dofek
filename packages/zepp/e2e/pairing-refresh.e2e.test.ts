import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
  verifyConnection(): Promise<void>;
}

interface WatchRuntime {
  state: {
    hasCredentials: boolean;
  };
  build(): void;
  onCall(payload: WatchCallPayload): void;
  onInit(): void;
  request(request: { method: string; params?: Record<string, unknown> }): Promise<unknown>;
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
    const responses = [
      { status: 200, body: pairing },
      {
        status: 200,
        body: { state: "claimed", companionToken: "companion-token" },
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const response = responses.shift();
        if (!response) throw new Error("Unexpected Zepp fetch");
        return response;
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

  it("notifies the watch when verification clears credentials for another Zepp app", async () => {
    const values = new Map<string, string>([[STORAGE_KEYS.DOFEK_API_TOKEN, "companion-token"]]);
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
      "Saved credentials belong to a different Zepp app. Connect again.",
    );

    expect(values.has(STORAGE_KEYS.DOFEK_API_TOKEN)).toBe(false);
    expect(calls).toContainEqual({ method: "dofek.connectionChanged", params: {} });
  });

  it("does not start a new pairing session after a connection-change disconnect notification", async () => {
    const watchConfig = requireWatchConfiguration();
    const watch = Object.assign({}, watchConfig, { state: { ...watchConfig.state } });
    watch.request = vi.fn(async (request) => {
      if (request.method === "imu.getPreferences") {
        return { hasCredentials: false, pairing: null };
      }
      return null;
    });

    watch.onCall({ method: "dofek.connectionChanged", params: {} });

    await vi.waitFor(() =>
      expect(watch.request).toHaveBeenCalledWith({ method: "imu.getPreferences", params: {} }),
    );
    expect(watch.request).not.toHaveBeenCalledWith({ method: "dofek.startPairing", params: {} });
  });
});
