import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DOFEK_SERVER_URL, STORAGE_KEYS } from "../../src/storage-keys.ts";

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
  style?: Record<string, string>;
  onClick(): void;
}

interface TextInputConfiguration {
  title: string;
  value?: string;
  onChange(value: string): void;
}

const createdImages: FakeImage[] = [];

class FakeImage {
  readonly height: number;
  readonly width: number;
  src = "";
  alt = "";
  style: Record<string, string> = {};

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    createdImages.push(this);
  }
}

let configuration: SettingConfiguration | undefined;
const buttonConfigurations: ButtonConfiguration[] = [];
const inputConfigurations: TextInputConfiguration[] = [];
const renderedValues: unknown[] = [];

function isSettingConfiguration(value: unknown): value is SettingConfiguration {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "state") === "object" &&
    typeof Reflect.get(value, "build") === "function"
  );
}

beforeAll(async () => {
  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal("AppSettingsPage", (value: unknown) => {
    if (!isSettingConfiguration(value)) {
      throw new Error("Invalid setting configuration");
    }
    configuration = value;
  });
  vi.stubGlobal("View", (style: unknown, children: unknown[]) => {
    const value = { style, children };
    renderedValues.push(value);
    return value;
  });
  vi.stubGlobal("Button", (value: ButtonConfiguration) => {
    buttonConfigurations.push(value);
    return value;
  });
  vi.stubGlobal("TextInput", (value: TextInputConfiguration) => {
    inputConfigurations.push(value);
    return value;
  });
  await import("./index.ts");
});

beforeEach(() => {
  buttonConfigurations.length = 0;
  createdImages.length = 0;
  inputConfigurations.length = 0;
  renderedValues.length = 0;
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

function input(title: string): TextInputConfiguration {
  const value = inputConfigurations.find((candidate) => candidate.title === title);
  if (!value) throw new Error(`Text input "${title}" was not rendered`);
  return value;
}

describe("Zepp Workout Extension settings", () => {
  it("renders stored pairing details, verified status, and the QR image", () => {
    buildWith({
      [STORAGE_KEYS.DOFEK_SERVER_URL]: "https://dofek.example.test",
      [STORAGE_KEYS.DOFEK_EMAIL]: "user@example.test",
      [STORAGE_KEYS.DOFEK_CONNECTION_STATUS]: JSON.stringify({
        state: "connected",
        reason: "Verified by Dofek",
      }),
      [STORAGE_KEYS.PAIRING_SHORT_CODE]: "ABC-123",
      [STORAGE_KEYS.PAIRING_VERIFICATION_URL]: "https://dofek.example.test/settings?zeppPair=ABC-123",
      [STORAGE_KEYS.PAIRING_QR_IMAGE_URL]: "https://dofek.example.test/pairing.svg",
      [STORAGE_KEYS.PAIRING_EXPIRES_AT]: "2026-07-28T20:00:00.000Z",
    });

    const rendered = JSON.stringify(renderedValues);
    expect(rendered).toContain("Short code: ABC-123");
    expect(rendered).toContain("Open: https://dofek.example.test/settings?zeppPair=ABC-123");
    expect(rendered).toContain("Expires:");
    expect(rendered).toContain("Connection: connected");
    expect(rendered).toContain("Reason: Verified by Dofek");
    expect(input("Dofek Server URL").value).toBe("https://dofek.example.test");
    expect(input("Dofek Email").value).toBe("user@example.test");
    expect(
      renderedValues.find((value) => JSON.stringify(value).includes("Short code: ABC-123")),
    ).toMatchObject({
      style: { style: { marginTop: "1em", lineHeight: "1.5rem" } },
    });
    expect(
      renderedValues.find((value) => JSON.stringify(value).includes("Connection: connected")),
    ).toMatchObject({
      style: { style: { marginTop: "1em" } },
    });
    expect(createdImages).toContainEqual(
      expect.objectContaining({
        src: "https://dofek.example.test/pairing.svg",
        alt: "Dofek Workout pairing QR code",
        width: 220,
        height: 220,
      }),
    );
  });

  it.each([JSON.stringify([]), JSON.stringify("connected"), "null"])(
    "treats non-object stored status %s as disconnected",
    (rawStatus) => {
      buildWith({
        [STORAGE_KEYS.DOFEK_CONNECTION_STATUS]: rawStatus,
      });

      expect(JSON.stringify(renderedValues)).toContain("Connection: not connected");
      expect(configuration?.state.connectionStatus).toEqual({});
    },
  );

  it("surfaces malformed stored connection status", () => {
    buildWith({
      [STORAGE_KEYS.DOFEK_CONNECTION_STATUS]: "{invalid",
    });

    const rendered = JSON.stringify(renderedValues);
    expect(rendered).toContain("Connection: error");
    expect(rendered).toContain("Stored connection status is invalid");
  });

  it("renders the empty pairing state with default settings", () => {
    buildWith({});

    const rendered = JSON.stringify(renderedValues);
    expect(rendered).toContain("Create a code, then scan the QR or enter the code in Dofek.");
    expect(rendered).toContain("Connection: not connected");
    expect(input("Dofek Server URL").value).toBe(DEFAULT_DOFEK_SERVER_URL);
    expect(input("Dofek Email").value).toBe("");
    expect(
      renderedValues.find((value) =>
        JSON.stringify(value).includes("Create a code, then scan the QR"),
      ),
    ).toMatchObject({
      style: { style: { marginTop: "1em", color: "#888" } },
    });
    expect(renderedValues).toContainEqual({ style: {}, children: [] });
    expect(createdImages).toEqual([]);
  });

  it.each([
    [{ [STORAGE_KEYS.PAIRING_SHORT_CODE]: "ABC-123" }],
    [{ [STORAGE_KEYS.PAIRING_VERIFICATION_URL]: "https://dofek.example.test/settings" }],
  ])("waits for both pairing fields before showing pairing details", (values) => {
    buildWith(values);

    const rendered = JSON.stringify(renderedValues);
    expect(rendered).toContain("Create a code, then scan the QR or enter the code in Dofek.");
    expect(rendered).not.toContain("Short code:");
    expect(rendered).not.toContain("Open:");
  });

  it("updates fields and sends pairing, login, verification, and disconnect commands", () => {
    const settingsStorage = buildWith({
      [STORAGE_KEYS.CMD_START_PAIRING]: "1",
    });

    input("Dofek Server URL").onChange("https://new.example.test");
    input("Dofek Email").onChange("new@example.test");
    input("Dofek Password").onChange("secret-password");
    button("Create QR / short code").onClick();
    button("Log in and connect").onClick();
    button("Check connection").onClick();
    button("Disconnect Dofek").onClick();

    expect(button("Create QR / short code").style).toEqual({ marginTop: "1em" });
    expect(button("Check connection").style).toEqual({ marginTop: "1em" });
    expect(button("Disconnect Dofek").style).toEqual({ marginTop: "1em" });
    expect(settingsStorage.setItem).toHaveBeenCalledWith(
      STORAGE_KEYS.DOFEK_SERVER_URL,
      "https://new.example.test",
    );
    expect(settingsStorage.setItem).toHaveBeenCalledWith(
      STORAGE_KEYS.DOFEK_EMAIL,
      "new@example.test",
    );
    expect(settingsStorage.setItem).toHaveBeenCalledWith(STORAGE_KEYS.CMD_START_PAIRING, "0");
    expect(settingsStorage.setItem).toHaveBeenCalledWith(STORAGE_KEYS.CMD_CHECK_CONNECTION, "1");
    expect(settingsStorage.setItem).toHaveBeenCalledWith(STORAGE_KEYS.CMD_DISCONNECT, "1");

    const loginCall = settingsStorage.setItem.mock.calls.find(
      ([key]) => key === STORAGE_KEYS.CMD_LOGIN_PASSWORD,
    );
    expect(loginCall).toBeDefined();
    expect(JSON.parse(loginCall?.[1] ?? "{}")).toEqual({
      email: "new@example.test",
      password: "secret-password",
      nonce: expect.any(Number),
    });
    expect(configuration?.state.password).toBe("");
  });
});
