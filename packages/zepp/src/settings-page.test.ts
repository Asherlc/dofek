import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSettingsPage } from "./settings-page.ts";
import { STORAGE_KEYS as K } from "./storage-keys.ts";
import { createSettingsComponents, createSettingsStorage } from "./test-helpers.ts";

beforeEach(() => vi.unstubAllGlobals());

function render(app: "zepp-main" | "zepp-workout", values: Record<string, string> = {}) {
  const ui = createSettingsComponents();
  const storage = createSettingsStorage(values);
  const page = createSettingsPage(app);
  const tree = page.build({ settingsStorage: storage });
  return { ...ui, storage, page, tree, text: JSON.stringify(tree) };
}

function renderContract(tree: unknown) {
  const text: string[] = [];
  const controls: Array<Record<string, unknown>> = [];
  const styleCounts = new Map<string, number>();

  function visit(value: unknown) {
    if (typeof value === "string") {
      text.push(value.startsWith("Expires ") ? "Expires <localized time>" : value);
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (typeof value !== "object" || value === null) return;

    const record = Object.fromEntries(Object.entries(value));
    const props = record.props;
    if (typeof props === "object" && props !== null && "style" in props) {
      const style = JSON.stringify(Reflect.get(props, "style"));
      styleCounts.set(style, (styleCounts.get(style) ?? 0) + 1);
    }
    for (const type of ["button", "input", "link", "image"] as const) {
      const component = record[type];
      if (typeof component === "object" && component !== null) {
        controls.push({
          type,
          ...Object.fromEntries(
            Object.entries(component).filter(([, entry]) => typeof entry !== "function"),
          ),
        });
      }
    }
    visit(record.children);
  }

  visit(tree);
  return { text, controls, styles: Object.fromEntries([...styleCounts].sort()) };
}

for (const app of ["zepp-main", "zepp-workout"] as const) {
  describe(app, () => {
    it("puts the connection and pairing before app controls and advanced details", () => {
      const { text, buttons, tree } = render(app, {
        [K.DOFEK_API_TOKEN]: "test-token",
        [K.DOFEK_CONNECTION_STATUS]: JSON.stringify({ state: "connected" }),
      });
      const appSection = app === "zepp-main" ? "Watch recorder" : "Set up on your watch";
      expect(text.indexOf("Connect to Dofek")).toBeLessThan(text.indexOf(appSection));
      expect(text.indexOf(appSection)).toBeLessThan(text.indexOf("Sync activity"));
      expect(text.indexOf("Sync activity")).toBeLessThan(text.indexOf("Advanced"));
      expect(text).toContain("Connected");
      expect(buttons.map(({ label }) => label)).toContain("Disconnect");
      if (app === "zepp-main") expect(renderContract(tree)).toMatchSnapshot();
    });

    it("shows the shared QR card and a same-phone pairing link", () => {
      const url = "https://dofek.example/zepp-pairing?code=ABC234";
      const { images, links, text, buttons, storage, tree } = render(app, {
        [K.DOFEK_CONNECTION_STATUS]: JSON.stringify({ state: "pairing" }),
        [K.PAIRING_SHORT_CODE]: "ABC234",
        [K.PAIRING_VERIFICATION_URL]: url,
        [K.PAIRING_QR_IMAGE_URL]: "https://dofek.example/pairing.svg",
        [K.PAIRING_EXPIRES_AT]: "2026-09-07T20:00:00Z",
      });
      expect(images).toEqual([
        expect.objectContaining({ src: "https://dofek.example/pairing.svg" }),
      ]);
      expect(links).toContainEqual(expect.objectContaining({ source: url }));
      expect(text).toContain("Open Dofek to finish pairing");
      expect(text).toContain("ABC234");
      expect(text).toContain("Expires");
      expect(buttons.map(({ label }) => label)).toContain("Cancel pairing");
      buttons.find(({ label }) => label === "Cancel pairing")?.onClick();
      expect(storage.getItem(K.CMD_DISCONNECT)).toBe("1");
      if (app === "zepp-workout") expect(renderContract(tree)).toMatchSnapshot();
    });

    it("preserves pairing, login, and server configuration commands", () => {
      const { buttons, inputs, storage, tree } = render(app);
      buttons.find(({ label }) => label === "Create pairing code")?.onClick();
      expect(storage.getItem(K.CMD_START_PAIRING)).toBe("1");
      inputs.find(({ label }) => label === "Server URL")?.onChange("https://custom.example");
      inputs.find(({ label }) => label === "Email")?.onChange("athlete@example.test");
      inputs.find(({ label }) => label === "Password")?.onChange("test-password");
      buttons.find(({ label }) => label === "Log in")?.onClick();
      expect(storage.getItem(K.DOFEK_SERVER_URL)).toBe("https://custom.example");
      expect(JSON.parse(storage.getItem(K.CMD_LOGIN_PASSWORD) ?? "{}")).toEqual({
        email: "athlete@example.test",
        password: "test-password",
        nonce: expect.any(Number),
      });
      if (app === "zepp-main") expect(renderContract(tree)).toMatchSnapshot();
    });

    it("shows connected actions and surfaces each delivery error", () => {
      const { text, buttons, storage } = render(app, {
        [K.DOFEK_API_TOKEN]: "test-token",
        [K.DOFEK_CONNECTION_STATUS]: JSON.stringify({ state: "connected" }),
        [K.IMU_SYNC_STATUS]: JSON.stringify({ state: "error", reason: "Phone upload failed" }),
        [K.TRANSFER_PROGRESS]: JSON.stringify({ state: "error", reason: "Transfer canceled" }),
      });
      expect(text).toContain("Connected");
      expect(text).toContain("Phone upload failed");
      expect(text).toContain("Transfer canceled");
      buttons.find(({ label }) => label === "Check connection")?.onClick();
      buttons.find(({ label }) => label === "Disconnect")?.onClick();
      expect(storage.getItem(K.CMD_CHECK_CONNECTION)).toBe("1");
      expect(storage.getItem(K.CMD_DISCONNECT)).toBe("1");
      expect(buttons.map(({ label }) => label)).not.toContain("Create pairing code");
    });

    it("keeps actionable connection errors visible and allows checking an existing token", () => {
      const { text, buttons } = render(app, {
        [K.DOFEK_API_TOKEN]: "test-token",
        [K.DOFEK_CONNECTION_STATUS]: JSON.stringify({
          state: "error",
          reason: "Reconnect your watch",
        }),
      });
      expect(text).toContain("Reconnect your watch");
      expect(buttons.map(({ label }) => label)).toContain("Check connection");
      expect(buttons.map(({ label }) => label)).not.toContain("Log in");
    });

    it("reports malformed stored status and renders the recovery controls", () => {
      const { text, buttons } = render(app, { [K.DOFEK_CONNECTION_STATUS]: "{" });
      expect(text).toContain("Stored settings data is invalid");
      expect(buttons.map(({ label }) => label)).toContain("Create pairing code");
    });

    it("renders pairing details without optional QR or expiry data", () => {
      const { images, text, tree } = render(app, {
        [K.DOFEK_CONNECTION_STATUS]: JSON.stringify({
          state: "pairing",
          reason: "Waiting for approval on your phone",
        }),
        [K.PAIRING_SHORT_CODE]: "ABC234",
        [K.PAIRING_VERIFICATION_URL]: "https://dofek.example/pair",
      });
      expect(images).toEqual([]);
      expect(text).toContain("ABC234");
      expect(text).not.toContain("Expires");
      if (app === "zepp-main") expect(renderContract(tree)).toMatchSnapshot();
    });

    it("keeps delivery failures visible while disconnected", () => {
      const values: Record<string, string> = {
        [K.IMU_SYNC_STATUS]: JSON.stringify({ state: "error", reason: "Upload failed" }),
        [K.TRANSFER_PROGRESS]: JSON.stringify({ state: "error", reason: "Transfer failed" }),
      };
      if (app === "zepp-main") {
        values[K.HEALTH_SERVICE_STATUS] = JSON.stringify({
          state: "error",
          reason: "Background collection stopped",
        });
      }

      const { text } = render(app, values);
      expect(text).toContain("Sync activity");
      expect(text).toContain("Upload failed");
      expect(text).toContain("Transfer failed");
      if (app === "zepp-main") expect(text).toContain("Background collection stopped");
    });

    it("treats whitespace credentials as disconnected", () => {
      const { text, buttons } = render(app, {
        [K.DOFEK_API_TOKEN]: "   ",
        [K.DOFEK_CONNECTION_STATUS]: JSON.stringify({ state: "connected" }),
      });
      expect(text).toContain("Not connected");
      expect(buttons.map(({ label }) => label)).toContain("Create pairing code");
      expect(buttons.map(({ label }) => label)).not.toContain("Check connection");
    });
  });
}

it("preserves recorder start/stop, file transfer, and health sync", () => {
  const { text, buttons, storage } = render("zepp-main", {
    [K.DOFEK_API_TOKEN]: "test-token",
    [K.DOFEK_CONNECTION_STATUS]: JSON.stringify({ state: "connected" }),
    [K.SESSION_STATUS]: JSON.stringify({
      state: "recording",
      sampleCount: 42,
      observedHzX100: 2500,
      hasGyro: true,
    }),
    [K.HEALTH_SERVICE_STATUS]: JSON.stringify({
      state: "error",
      reason: "Health service did not start",
    }),
    [K.TRANSFER_PROGRESS]: JSON.stringify({ state: "sending", pct: 37 }),
    [K.LAST_EXPORT_PATH]: "data://session.bin",
  });
  expect(text).toContain("Recording");
  expect(text).toContain("42");
  expect(text).toContain("25.00 Hz");
  expect(text).toContain("37%");
  expect(text).toContain("Health service did not start");
  expect(text).toContain("data://session.bin");
  buttons.find(({ label }) => label === "Stop & transfer")?.onClick();
  buttons.find(({ label }) => label === "Transfer saved session")?.onClick();
  buttons.find(({ label }) => label === "Sync now")?.onClick();
  expect(storage.getItem(K.CMD_LOGGING)).toBe("stop");
  expect(storage.getItem(K.CMD_TRANSFER)).toBe("1");
  expect(storage.getItem(K.CMD_SYNC_HEALTH)).toBe("1");
});

it("accepts only integer sample-rate modes from zero through two", () => {
  const { inputs, storage } = render("zepp-main");
  const sampleRate = inputs.find(({ label }) => label.startsWith("Sample rate mode"));
  if (!sampleRate) throw new Error("Sample rate input was not rendered");

  for (const valid of ["0", "1", "2"]) {
    sampleRate.onChange(valid);
    expect(storage.getItem(K.PREF_FREQ_MODE)).toBe(valid);
  }
  for (const invalid of ["-1", "3", "1.5", "invalid"]) {
    sampleRate.onChange(invalid);
    expect(storage.getItem(K.PREF_FREQ_MODE)).toBe("2");
  }
});

it("ignores empty and non-object stored status values", () => {
  for (const stored of ["", "null", '"value"', '["value"]']) {
    const { text } = render("zepp-main", { [K.DOFEK_CONNECTION_STATUS]: stored });
    expect(text).toContain("Not connected");
    expect(text).not.toContain("Stored settings data is invalid");
  }
});

it("requires both pairing-code fields before showing pairing details", () => {
  const partialPairingValues: Array<Record<string, string>> = [
    { [K.PAIRING_SHORT_CODE]: "ABC234" },
    { [K.PAIRING_VERIFICATION_URL]: "https://dofek.example/pair" },
  ];
  for (const values of partialPairingValues) {
    const { links, text } = render("zepp-main", {
      [K.DOFEK_CONNECTION_STATUS]: JSON.stringify({ state: "pairing" }),
      ...values,
    });
    expect(text).toContain("Create a code, then open Dofek");
    expect(text).not.toContain("ABC234");
    expect(links).toEqual([]);
  }
});

it("toggles an existing one-shot command off", () => {
  const { buttons, storage } = render("zepp-main", { [K.CMD_START_PAIRING]: "1" });
  buttons.find(({ label }) => label === "Create pairing code")?.onClick();
  expect(storage.getItem(K.CMD_START_PAIRING)).toBe("0");
});

it("submits an empty password when login is clicked before typing", () => {
  const { buttons, storage } = render("zepp-main");
  buttons.find(({ label }) => label === "Log in")?.onClick();
  expect(JSON.parse(storage.getItem(K.CMD_LOGIN_PASSWORD) ?? "{}")).toEqual({
    email: "",
    password: "",
    nonce: expect.any(Number),
  });
});

it("styles connection and delivery errors distinctly from retry information", () => {
  const { tree } = render("zepp-main", {
    [K.DOFEK_API_TOKEN]: "test-token",
    [K.DOFEK_CONNECTION_STATUS]: JSON.stringify({ state: "error", reason: "Reconnect" }),
    [K.IMU_SYNC_STATUS]: JSON.stringify({ state: "retrying", reason: "Trying again" }),
    [K.TRANSFER_PROGRESS]: JSON.stringify({ state: "error", reason: "Transfer failed" }),
  });
  expect(renderContract(tree)).toMatchSnapshot();
});
