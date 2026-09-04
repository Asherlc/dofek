import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_KEYS } from "../src/storage-keys.ts";

interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface SettingConfiguration {
  state: Record<string, unknown>;
  build(this: SettingConfiguration, props: { settingsStorage: SettingsStorage }): unknown;
}

interface ButtonConfiguration {
  label: string;
  onClick(): void;
}

interface TextInputConfiguration {
  label?: string;
  title?: string;
}

interface ImageConfiguration {
  src: string;
  alt?: string;
  width?: number;
  height?: number;
}

interface ToggleConfiguration {
  label: string;
  value?: boolean;
  checked?: boolean;
}

let configuration: SettingConfiguration | undefined;
const buttonConfigurations: ButtonConfiguration[] = [];
const imageConfigurations: ImageConfiguration[] = [];
const textInputConfigurations: TextInputConfiguration[] = [];
const toggleConfigurations: ToggleConfiguration[] = [];
const renderedViews: unknown[] = [];

function isSettingConfiguration(value: unknown): value is SettingConfiguration {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "state") === "object" &&
    typeof Reflect.get(value, "build") === "function"
  );
}

beforeAll(async () => {
  vi.stubGlobal("AppSettingsPage", (value: unknown) => {
    if (!isSettingConfiguration(value)) {
      throw new Error("Invalid setting configuration");
    }
    configuration = value;
  });
  vi.stubGlobal("View", (style: unknown, children: unknown[]) => {
    const value = { style, children };
    renderedViews.push(value);
    return value;
  });
  vi.stubGlobal("Button", (value: ButtonConfiguration) => {
    buttonConfigurations.push(value);
    return value;
  });
  vi.stubGlobal("TextInput", (value: TextInputConfiguration) => {
    textInputConfigurations.push(value);
    return value;
  });
  vi.stubGlobal("Image", (value: ImageConfiguration) => {
    imageConfigurations.push(value);
    return value;
  });
  vi.stubGlobal("Toggle", (value: ToggleConfiguration) => {
    toggleConfigurations.push(value);
    return value;
  });
  await import("./index.ts");
});

beforeEach(() => {
  buttonConfigurations.length = 0;
  imageConfigurations.length = 0;
  textInputConfigurations.length = 0;
  toggleConfigurations.length = 0;
  renderedViews.length = 0;
});

function buildWith(values: Readonly<Record<string, string | null>>) {
  if (!configuration) throw new Error("setting configuration was not registered");
  const settingsStorage = {
    getItem: vi.fn((key: string) => values[key] ?? null),
    setItem: vi.fn(),
  };
  configuration.build.call(configuration, { settingsStorage });
  return settingsStorage;
}

function button(label: string): ButtonConfiguration {
  const value = buttonConfigurations.find((candidate) => candidate.label === label);
  if (!value) throw new Error(`Button "${label}" was not rendered`);
  return value;
}

describe("normal Zepp app settings", () => {
  it("builds with the documented Zepp Settings component globals", () => {
    expect(() => buildWith({})).not.toThrow();
  });

  it("passes the gyroscope state through the documented Toggle value property", () => {
    buildWith({ [STORAGE_KEYS.PREF_ENABLE_GYRO]: "true" });

    expect(toggleConfigurations).toHaveLength(1);
    expect(toggleConfigurations[0]).toEqual(
      expect.objectContaining({ label: "Include gyroscope", value: true }),
    );
    expect(toggleConfigurations[0]?.checked).toBeUndefined();
  });

  it("uses the documented label property for text inputs", () => {
    buildWith({});

    expect(textInputConfigurations.map(({ label }) => label)).toEqual([
      "Sample rate mode (0=LOW, 1=NORMAL, 2=HIGH)",
      "Dofek Server URL",
      "Dofek Email",
      "Dofek Password",
    ]);
    expect(textInputConfigurations.every(({ title }) => title === undefined)).toBe(true);
  });

  it("renders pairing QR codes with the Zepp Image component", () => {
    expect(() =>
      buildWith({
        [STORAGE_KEYS.PAIRING_QR_IMAGE_URL]: "https://dofek.example/pairing.svg",
      }),
    ).not.toThrow();
    expect(imageConfigurations).toEqual([
      {
        src: "https://dofek.example/pairing.svg",
        alt: "Dofek pairing QR code",
        width: 220,
        height: 220,
        style: { margin: "0 auto 1em", display: "block" },
      },
    ]);
  });

  it("shows only management controls for a verified connection", () => {
    buildWith({
      [STORAGE_KEYS.DOFEK_API_TOKEN]: "verified-token",
      [STORAGE_KEYS.DOFEK_CONNECTION_STATUS]: JSON.stringify({
        state: "connected",
        reason: "Verified by Dofek",
      }),
    });

    expect(buttonConfigurations.map(({ label }) => label)).not.toContain("Create QR / short code");
    expect(buttonConfigurations.map(({ label }) => label)).not.toContain("Log in and connect");
    expect(buttonConfigurations.map(({ label }) => label)).toEqual(
      expect.arrayContaining(["Check connection", "Disconnect Dofek", "Sync health data now"]),
    );
    expect(JSON.stringify(renderedViews)).toContain("Connection: connected");
    expect(JSON.stringify(renderedViews)).toContain("Reason: Verified by Dofek");
  });

  it("shows only pairing and login actions while disconnected", () => {
    buildWith({});

    expect(buttonConfigurations.map(({ label }) => label)).toEqual(
      expect.arrayContaining(["Create QR / short code", "Log in and connect"]),
    );
    expect(buttonConfigurations.map(({ label }) => label)).not.toContain("Check connection");
    expect(buttonConfigurations.map(({ label }) => label)).not.toContain("Disconnect Dofek");
    expect(buttonConfigurations.map(({ label }) => label)).not.toContain("Sync health data now");
  });

  it("requires disconnect before reconnecting when an errored token remains", () => {
    buildWith({
      [STORAGE_KEYS.DOFEK_API_TOKEN]: "stored-token",
      [STORAGE_KEYS.DOFEK_CONNECTION_STATUS]: JSON.stringify({
        state: "error",
        reason: "Phone temporarily offline",
      }),
    });

    expect(buttonConfigurations.map(({ label }) => label)).toEqual(
      expect.arrayContaining(["Check connection", "Disconnect Dofek"]),
    );
    expect(buttonConfigurations.map(({ label }) => label)).not.toContain("Create QR / short code");
    expect(buttonConfigurations.map(({ label }) => label)).not.toContain("Log in and connect");
  });

  it("sends pairing, verification, and disconnect commands from their respective states", () => {
    const settingsStorage = buildWith({});

    button("Create QR / short code").onClick();
    expect(settingsStorage.setItem).toHaveBeenCalledWith(STORAGE_KEYS.CMD_START_PAIRING, "1");

    const connectedStorage = buildWith({
      [STORAGE_KEYS.DOFEK_API_TOKEN]: "verified-token",
      [STORAGE_KEYS.DOFEK_CONNECTION_STATUS]: JSON.stringify({ state: "connected" }),
    });
    button("Check connection").onClick();
    button("Disconnect Dofek").onClick();
    expect(connectedStorage.setItem).toHaveBeenCalledWith(STORAGE_KEYS.CMD_CHECK_CONNECTION, "1");
    expect(connectedStorage.setItem).toHaveBeenCalledWith(STORAGE_KEYS.CMD_DISCONNECT, "1");
  });
});
