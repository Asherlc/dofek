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

let configuration: SettingConfiguration | undefined;
const buttonConfigurations: ButtonConfiguration[] = [];
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
  vi.stubGlobal("TextInput", (value: unknown) => value);
  vi.stubGlobal("ToggleSwitch", (value: unknown) => value);
  await import("./index.ts");
});

beforeEach(() => {
  buttonConfigurations.length = 0;
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
  it("shows pairing, authoritative status, and connection management controls", () => {
    buildWith({
      [STORAGE_KEYS.DOFEK_CONNECTION_STATUS]: JSON.stringify({
        state: "connected",
        reason: "Verified by Dofek",
      }),
    });

    expect(buttonConfigurations.map(({ label }) => label)).toEqual(
      expect.arrayContaining([
        "Create QR / short code",
        "Log in and connect",
        "Check connection",
        "Disconnect Dofek",
      ]),
    );
    expect(JSON.stringify(renderedViews)).toContain("Connection: connected");
    expect(JSON.stringify(renderedViews)).toContain("Reason: Verified by Dofek");
  });

  it("sends pairing, verification, and disconnect commands", () => {
    const settingsStorage = buildWith({});

    button("Create QR / short code").onClick();
    button("Check connection").onClick();
    button("Disconnect Dofek").onClick();

    expect(settingsStorage.setItem).toHaveBeenCalledWith(STORAGE_KEYS.CMD_START_PAIRING, "1");
    expect(settingsStorage.setItem).toHaveBeenCalledWith(STORAGE_KEYS.CMD_CHECK_CONNECTION, "1");
    expect(settingsStorage.setItem).toHaveBeenCalledWith(STORAGE_KEYS.CMD_DISCONNECT, "1");
  });
});
