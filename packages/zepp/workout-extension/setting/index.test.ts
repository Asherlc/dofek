import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DOFEK_SERVER_URL, STORAGE_KEYS } from "../../src/storage-keys.ts";

interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface SettingState {
  serverUrl: string;
  email: string;
  password: string;
  apiToken: string | null;
  connectionStatus: Record<string, unknown>;
  pairingShortCode: string | null;
  pairingVerificationUrl: string | null;
  pairingQrImageUrl: string | null;
  pairingExpiresAt: string | null;
  imuSyncStatus: Record<string, unknown>;
  transferProgress: Record<string, unknown>;
}

interface SettingConfiguration {
  state: SettingState;
  build(this: SettingConfiguration, props: { settingsStorage: SettingsStorage }): unknown;
}

interface InputConfiguration {
  label: string;
  value?: string;
  placeholder?: string;
  onChange(value: string): void;
}

interface ButtonConfiguration {
  label: string;
  color?: string;
  style?: Record<string, string>;
  onClick(): void;
}

interface ImageConfiguration {
  src: string;
  alt?: string;
  width?: number;
  height?: number;
  style?: Record<string, string>;
}

let configuration: SettingConfiguration | undefined;
const inputConfigurations: InputConfiguration[] = [];
const buttonConfigurations: ButtonConfiguration[] = [];
const viewConfigurations: Array<{ style: Record<string, unknown>; children: unknown[] }> = [];
const createdImages: ImageConfiguration[] = [];

beforeAll(async () => {
  vi.stubGlobal("Image", (value: ImageConfiguration) => {
    createdImages.push(value);
    return value;
  });
  vi.stubGlobal("AppSettingsPage", (value: SettingConfiguration) => {
    configuration = value;
  });
  vi.stubGlobal("View", (style: Record<string, unknown>, children: unknown[]) => {
    const value = { style, children };
    viewConfigurations.push(value);
    return value;
  });
  vi.stubGlobal("TextInput", (value: InputConfiguration) => {
    inputConfigurations.push(value);
    return value;
  });
  vi.stubGlobal("Button", (value: ButtonConfiguration) => {
    buttonConfigurations.push(value);
    return value;
  });
  await import("./index.ts");
});

beforeEach(() => {
  inputConfigurations.length = 0;
  buttonConfigurations.length = 0;
  viewConfigurations.length = 0;
  createdImages.length = 0;
});

function buildWith(values: Readonly<Record<string, string | null>>) {
  if (!configuration) throw new Error("setting configuration was not registered");
  configuration.state = {
    serverUrl: DEFAULT_DOFEK_SERVER_URL,
    email: "",
    password: "",
    apiToken: null,
    connectionStatus: {},
    pairingShortCode: null,
    pairingVerificationUrl: null,
    pairingQrImageUrl: null,
    pairingExpiresAt: null,
    imuSyncStatus: {},
    transferProgress: {},
  };
  const settingsStorage = {
    getItem: vi.fn((key: string) => values[key] ?? null),
    setItem: vi.fn(),
  };
  const rendered = configuration.build.call(configuration, { settingsStorage });
  return { rendered, settingsStorage };
}

function viewContaining(text: string) {
  return viewConfigurations.find((value) => JSON.stringify(value).includes(text));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("workout extension settings", () => {
  it("loads saved settings and renders only management controls when connected", () => {
    const { rendered } = buildWith({
      [STORAGE_KEYS.DOFEK_SERVER_URL]: "https://dofek.example.test",
      [STORAGE_KEYS.DOFEK_EMAIL]: "athlete@example.test",
      [STORAGE_KEYS.DOFEK_API_TOKEN]: "verified-token",
      [STORAGE_KEYS.DOFEK_CONNECTION_STATUS]: JSON.stringify({ state: "connected" }),
    });

    expect(configuration?.state).toEqual({
      serverUrl: "https://dofek.example.test",
      email: "athlete@example.test",
      password: "",
      apiToken: "verified-token",
      connectionStatus: { state: "connected" },
      pairingShortCode: null,
      pairingVerificationUrl: null,
      pairingQrImageUrl: null,
      pairingExpiresAt: null,
      imuSyncStatus: {},
      transferProgress: {},
    });
    expect(inputConfigurations).toHaveLength(0);
    expect(buttonConfigurations).toHaveLength(2);
    expect(buttonConfigurations).toMatchObject([
      { label: "Check connection", color: "secondary", style: { marginTop: "1em" } },
      { label: "Disconnect Dofek", color: "secondary", style: { marginTop: "1em" } },
    ]);
    expect(viewContaining("Connection: connected")).toMatchObject({
      style: { style: { marginTop: "1em" } },
    });
    expect(JSON.stringify(viewConfigurations)).toContain("Motion Extensions");
    expect(rendered).toMatchObject({ style: { style: { padding: "1em" } } });
  });

  it("renders only pairing and login controls while disconnected", () => {
    buildWith({});

    expect(inputConfigurations.map(({ label }) => label)).toEqual([
      "Dofek Server URL",
      "Dofek Email",
      "Dofek Password",
    ]);
    expect(buttonConfigurations.map(({ label }) => label)).toEqual([
      "Create QR / short code",
      "Log in and connect",
    ]);
  });

  it("requires disconnect before reconnecting when an errored token remains", () => {
    buildWith({
      [STORAGE_KEYS.DOFEK_API_TOKEN]: "stored-token",
      [STORAGE_KEYS.DOFEK_CONNECTION_STATUS]: JSON.stringify({ state: "error" }),
    });

    expect(inputConfigurations).toHaveLength(0);
    expect(buttonConfigurations.map(({ label }) => label)).toEqual([
      "Check connection",
      "Disconnect Dofek",
    ]);
  });

  it("shows the shared motion delivery error", () => {
    buildWith({
      [STORAGE_KEYS.IMU_SYNC_STATUS]: JSON.stringify({
        state: "error",
        reason: "IMU data upload failed.",
      }),
    });

    expect(JSON.stringify(viewConfigurations)).toContain("Motion sync: error");
    expect(JSON.stringify(viewConfigurations)).toContain(
      "Motion reason: IMU data upload failed.",
    );
  });

  it("shows binary transfer failures independently from chunk sync", () => {
    buildWith({
      [STORAGE_KEYS.TRANSFER_PROGRESS]: JSON.stringify({
        state: "error",
        reason: "Workout IMU transfer was canceled.",
      }),
    });

    expect(JSON.stringify(viewConfigurations)).toContain("Transfer: error");
    expect(JSON.stringify(viewConfigurations)).toContain(
      "Transfer reason: Workout IMU transfer was canceled.",
    );
  });

  it("renders stored pairing details and the QR image", () => {
    buildWith({
      [STORAGE_KEYS.PAIRING_SHORT_CODE]: "ABC-123",
      [STORAGE_KEYS.PAIRING_VERIFICATION_URL]: "https://dofek.example.test/settings?code=ABC-123",
      [STORAGE_KEYS.PAIRING_QR_IMAGE_URL]: "https://dofek.example.test/pairing.svg",
      [STORAGE_KEYS.PAIRING_EXPIRES_AT]: "2026-07-28T20:00:00.000Z",
    });

    expect(viewContaining("Short code: ABC-123")).toMatchObject({
      style: { style: { marginTop: "1em", lineHeight: "1.5rem" } },
      children: [
        "Short code: ABC-123",
        "Open: https://dofek.example.test/settings?code=ABC-123",
        expect.stringContaining("Expires:"),
      ],
    });
    expect(createdImages).toContainEqual(
      expect.objectContaining({
        src: "https://dofek.example.test/pairing.svg",
        alt: "Dofek Workout pairing QR code",
        width: 220,
        height: 220,
        style: { margin: "0 auto 1em", display: "block" },
      }),
    );
  });

  it("uses defaults and safely reports malformed or non-object saved status", () => {
    buildWith({ [STORAGE_KEYS.DOFEK_CONNECTION_STATUS]: "{" });

    expect(configuration?.state.serverUrl).toBe(DEFAULT_DOFEK_SERVER_URL);
    expect(configuration?.state.email).toBe("");
    expect(configuration?.state.connectionStatus).toMatchObject({
      state: "error",
      reason: expect.stringContaining("Stored connection status is invalid"),
    });

    buildWith({ [STORAGE_KEYS.DOFEK_CONNECTION_STATUS]: JSON.stringify({ other: true }) });
    expect(configuration?.state.connectionStatus).toEqual({ other: true });

    for (const value of ["connected", null, []]) {
      buildWith({ [STORAGE_KEYS.DOFEK_CONNECTION_STATUS]: JSON.stringify(value) });
      expect(configuration?.state.connectionStatus).toEqual({});
    }
  });

  it("renders the empty pairing state until both pairing fields exist", () => {
    const incompletePairingValues: ReadonlyArray<Readonly<Record<string, string | null>>> = [
      {},
      { [STORAGE_KEYS.PAIRING_SHORT_CODE]: "ABC-123" },
      { [STORAGE_KEYS.PAIRING_VERIFICATION_URL]: "https://dofek.example.test/settings" },
    ];
    for (const values of incompletePairingValues) {
      viewConfigurations.length = 0;
      createdImages.length = 0;
      buildWith(values);
      expect(viewContaining("Create a code, then scan the QR")).toMatchObject({
        style: { style: { marginTop: "1em", color: "#888" } },
      });
      expect(viewConfigurations).toContainEqual({ style: {}, children: [] });
      expect(createdImages).toEqual([]);
    }
  });

  it("persists edits and sends a nonce-bearing login command", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_720_000_000_000);
    const { settingsStorage } = buildWith({});

    inputConfigurations[0]?.onChange("https://new.example.test");
    inputConfigurations[1]?.onChange("new@example.test");
    inputConfigurations[2]?.onChange("secret");
    buttonConfigurations.find(({ label }) => label === "Log in and connect")?.onClick();

    expect(settingsStorage.setItem).toHaveBeenNthCalledWith(
      1,
      STORAGE_KEYS.DOFEK_SERVER_URL,
      "https://new.example.test",
    );
    expect(settingsStorage.setItem).toHaveBeenNthCalledWith(
      2,
      STORAGE_KEYS.DOFEK_EMAIL,
      "new@example.test",
    );
    expect(settingsStorage.setItem).toHaveBeenNthCalledWith(
      3,
      STORAGE_KEYS.CMD_LOGIN_PASSWORD,
      JSON.stringify({
        email: "new@example.test",
        password: "secret",
        nonce: 1_720_000_000_000,
      }),
    );
    expect(configuration?.state.password).toBe("");
  });

  it("starts pairing and exposes connection management commands in their respective states", () => {
    const { settingsStorage } = buildWith({
      [STORAGE_KEYS.CMD_START_PAIRING]: "1",
    });

    buttonConfigurations.find(({ label }) => label === "Create QR / short code")?.onClick();

    expect(settingsStorage.setItem).toHaveBeenCalledWith(STORAGE_KEYS.CMD_START_PAIRING, "0");
    const connected = buildWith({
      [STORAGE_KEYS.DOFEK_API_TOKEN]: "verified-token",
      [STORAGE_KEYS.DOFEK_CONNECTION_STATUS]: JSON.stringify({ state: "connected" }),
    });
    buttonConfigurations.find(({ label }) => label === "Check connection")?.onClick();
    buttonConfigurations.find(({ label }) => label === "Disconnect Dofek")?.onClick();
    expect(connected.settingsStorage.setItem).toHaveBeenCalledWith(
      STORAGE_KEYS.CMD_CHECK_CONNECTION,
      "1",
    );
    expect(connected.settingsStorage.setItem).toHaveBeenCalledWith(
      STORAGE_KEYS.CMD_DISCONNECT,
      "1",
    );
  });
});
