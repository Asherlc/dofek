import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DOFEK_SERVER_URL, STORAGE_KEYS } from "../../src/storage-keys.ts";

interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface SettingState {
  serverUrl: string;
  email: string;
  password: string;
  connectionStatus: string;
}

interface SettingConfiguration {
  state: SettingState;
  build(this: SettingConfiguration, props: { settingsStorage: SettingsStorage }): unknown;
}

interface InputConfiguration {
  title: string;
  value?: string;
  placeholder?: string;
  onChange(value: string): void;
}

interface ButtonConfiguration {
  label: string;
  onClick(): void;
}

let configuration: SettingConfiguration | undefined;
const inputConfigurations: InputConfiguration[] = [];
const buttonConfigurations: ButtonConfiguration[] = [];
const viewConfigurations: Array<{ style: Record<string, unknown>; children: unknown[] }> = [];

beforeAll(async () => {
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
});

function buildWith(values: Readonly<Record<string, string | null>>) {
  if (!configuration) throw new Error("setting configuration was not registered");
  const settingsStorage = {
    getItem: vi.fn((key: string) => values[key] ?? null),
    setItem: vi.fn(),
  };
  const rendered = configuration.build.call(configuration, { settingsStorage });
  return { rendered, settingsStorage };
}

describe("workout extension settings", () => {
  it("loads saved settings and renders every control", () => {
    const { rendered } = buildWith({
      [STORAGE_KEYS.DOFEK_SERVER_URL]: "https://dofek.example.test",
      [STORAGE_KEYS.DOFEK_EMAIL]: "athlete@example.test",
      [STORAGE_KEYS.DOFEK_CONNECTION_STATUS]: JSON.stringify({ state: "connected" }),
    });

    expect(configuration?.state).toEqual({
      serverUrl: "https://dofek.example.test",
      email: "athlete@example.test",
      password: "",
      connectionStatus: "connected",
    });
    expect(inputConfigurations).toHaveLength(3);
    expect(inputConfigurations[0]).toMatchObject({
      title: "Dofek Server URL",
      value: "https://dofek.example.test",
    });
    expect(inputConfigurations[1]).toMatchObject({
      title: "Dofek Email",
      value: "athlete@example.test",
    });
    expect(inputConfigurations[2]).toMatchObject({
      title: "Dofek Password",
      placeholder: "Enter your Dofek password",
    });
    expect(buttonConfigurations).toHaveLength(1);
    expect(buttonConfigurations[0]).toMatchObject({
      label: "Connect Dofek",
      color: "primary",
      style: { marginTop: "1em" },
    });
    expect(viewConfigurations).toEqual([
      {
        style: { style: { fontSize: "1.4rem", fontWeight: "bold", marginBottom: "1em" } },
        children: ["Dofek Workout Sync"],
      },
      {
        style: { style: { marginTop: "1em" } },
        children: ["Connection: connected"],
      },
      {
        style: { style: { marginTop: "1em", color: "#888" } },
        children: [
          "Enable Dofek Workout inside the watch Workout app. Live samples are buffered and retried when the phone is unavailable.",
        ],
      },
      expect.objectContaining({ style: { style: { padding: "1em" } } }),
    ]);
    expect(rendered).toMatchObject({ style: { style: { padding: "1em" } } });
  });

  it("uses defaults and safely reports malformed saved status", () => {
    buildWith({ [STORAGE_KEYS.DOFEK_CONNECTION_STATUS]: "{" });

    expect(configuration?.state.serverUrl).toBe(DEFAULT_DOFEK_SERVER_URL);
    expect(configuration?.state.email).toBe("");
    expect(configuration?.state.connectionStatus).toBe("invalid saved status");

    buildWith({ [STORAGE_KEYS.DOFEK_CONNECTION_STATUS]: JSON.stringify({ other: true }) });
    expect(configuration?.state.connectionStatus).toBe("invalid saved status");

    expect(() =>
      buildWith({ [STORAGE_KEYS.DOFEK_CONNECTION_STATUS]: JSON.stringify("connected") }),
    ).not.toThrow();
    expect(() =>
      buildWith({ [STORAGE_KEYS.DOFEK_CONNECTION_STATUS]: JSON.stringify(null) }),
    ).not.toThrow();
    expect(configuration?.state.connectionStatus).toBe("invalid saved status");
  });

  it("persists edits and sends a nonce-bearing login command", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_720_000_000_000);
    const { settingsStorage } = buildWith({});

    inputConfigurations[0]?.onChange("https://new.example.test");
    inputConfigurations[1]?.onChange("new@example.test");
    inputConfigurations[2]?.onChange("secret");
    buttonConfigurations[0]?.onClick();

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
});
