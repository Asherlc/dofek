import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DOFEK_SERVER_URL, STORAGE_KEYS } from "./storage-keys.ts";

interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface SettingsState {
  serverUrl: string;
  email: string;
  password: string;
  connectionStatus: string;
}

interface SettingsConfiguration {
  state: SettingsState;
  build(this: SettingsConfiguration, props: { settingsStorage: SettingsStorage }): unknown;
}

interface InputOptions {
  title: string;
  value?: string;
  placeholder?: string;
  onChange(value: string): void;
}

interface ButtonOptions {
  label: string;
  onClick(): void;
}

let configuration: SettingsConfiguration | undefined;
const textInputMock = vi.fn((options: InputOptions) => options);
const buttonMock = vi.fn((options: ButtonOptions) => options);
const viewMock = vi.fn((style: Record<string, unknown>, children: unknown[]) => ({
  style,
  children,
}));

beforeAll(async () => {
  vi.stubGlobal("AppSettingsPage", (value: SettingsConfiguration) => {
    configuration = value;
  });
  vi.stubGlobal("View", viewMock);
  vi.stubGlobal("TextInput", textInputMock);
  vi.stubGlobal("Button", buttonMock);
  await import("../workout-extension/setting/index.ts");
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("workout extension settings", () => {
  it("loads persisted settings and writes edited credentials", () => {
    if (!configuration) throw new Error("settings configuration was not registered");
    const values = new Map<string, string>([
      [STORAGE_KEYS.DOFEK_SERVER_URL, "https://custom.example"],
      [STORAGE_KEYS.DOFEK_EMAIL, "athlete@example.com"],
      [STORAGE_KEYS.DOFEK_CONNECTION_STATUS, JSON.stringify({ state: "connected" })],
    ]);
    const settingsStorage: SettingsStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    };

    const page = configuration.build.call(configuration, { settingsStorage });

    expect(configuration.state).toMatchObject({
      serverUrl: "https://custom.example",
      email: "athlete@example.com",
      connectionStatus: "connected",
    });
    expect(textInputMock.mock.calls.map(([options]) => options)).toEqual([
      expect.objectContaining({ title: "Dofek Server URL", value: "https://custom.example" }),
      expect.objectContaining({ title: "Dofek Email", value: "athlete@example.com" }),
      expect.objectContaining({
        title: "Dofek Password",
        placeholder: "Enter your Dofek password",
      }),
    ]);
    expect(buttonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "Connect Dofek",
        color: "primary",
        style: { marginTop: "1em" },
      }),
    );
    expect(viewMock).toHaveBeenCalledWith(
      { style: { fontSize: "1.4rem", fontWeight: "bold", marginBottom: "1em" } },
      ["Dofek Workout Sync"],
    );
    expect(viewMock).toHaveBeenCalledWith({ style: { marginTop: "1em" } }, [
      "Connection: connected",
    ]);
    expect(viewMock).toHaveBeenCalledWith({ style: { marginTop: "1em", color: "#888" } }, [
      "Enable Dofek Workout inside the watch Workout app. Live samples are buffered and retried when the phone is unavailable.",
    ]);
    expect(page).toMatchObject({ style: { style: { padding: "1em" } } });
    textInputMock.mock.calls[0]?.[0].onChange("https://next.example");
    textInputMock.mock.calls[1]?.[0].onChange("next@example.com");
    textInputMock.mock.calls[2]?.[0].onChange("secret");
    buttonMock.mock.calls[0]?.[0].onClick();

    expect(values.get(STORAGE_KEYS.DOFEK_SERVER_URL)).toBe("https://next.example");
    expect(values.get(STORAGE_KEYS.DOFEK_EMAIL)).toBe("next@example.com");
    expect(JSON.parse(values.get(STORAGE_KEYS.CMD_LOGIN_PASSWORD) ?? "null")).toMatchObject({
      email: "next@example.com",
      password: "secret",
    });
    expect(configuration.state.password).toBe("");
  });

  it("uses defaults and surfaces malformed saved connection state", () => {
    if (!configuration) throw new Error("settings configuration was not registered");
    const settingsStorage: SettingsStorage = {
      getItem: (key) => (key === STORAGE_KEYS.DOFEK_CONNECTION_STATUS ? "not-json" : null),
      setItem: vi.fn(),
    };

    configuration.build.call(configuration, { settingsStorage });

    expect(configuration.state).toMatchObject({
      serverUrl: DEFAULT_DOFEK_SERVER_URL,
      email: "",
      connectionStatus: "invalid saved status",
    });
  });

  it("ignores saved status objects without a state field", () => {
    if (!configuration) throw new Error("settings configuration was not registered");
    configuration.state.connectionStatus = "not connected";
    configuration.build.call(configuration, {
      settingsStorage: {
        getItem: (key) =>
          key === STORAGE_KEYS.DOFEK_CONNECTION_STATUS ? JSON.stringify({ other: true }) : null,
        setItem: vi.fn(),
      },
    });
    expect(configuration.state.connectionStatus).toBe("not connected");
  });

  it.each([
    null,
    "null",
    '"connected"',
    "[]",
  ])("ignores absent or non-object saved status %s", (rawStatus) => {
    if (!configuration) throw new Error("settings configuration was not registered");
    configuration.state.connectionStatus = "not connected";
    configuration.build.call(configuration, {
      settingsStorage: {
        getItem: (key) => (key === STORAGE_KEYS.DOFEK_CONNECTION_STATUS ? rawStatus : null),
        setItem: vi.fn(),
      },
    });
    expect(configuration.state.connectionStatus).toBe("not connected");
  });
});
