import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSettingsPage } from "./settings-page.ts";
import { STORAGE_KEYS } from "./storage-keys.ts";
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
        [STORAGE_KEYS.DOFEK_API_TOKEN]: "test-token",
        [STORAGE_KEYS.DOFEK_CONNECTION_STATUS]: JSON.stringify({ state: "connected" }),
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
        [STORAGE_KEYS.DOFEK_CONNECTION_STATUS]: JSON.stringify({ state: "pairing" }),
        [STORAGE_KEYS.PAIRING_SHORT_CODE]: "ABC234",
        [STORAGE_KEYS.PAIRING_VERIFICATION_URL]: url,
        [STORAGE_KEYS.PAIRING_QR_IMAGE_URL]: "https://dofek.example/pairing.svg",
        [STORAGE_KEYS.PAIRING_EXPIRES_AT]: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
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
      expect(storage.getItem(STORAGE_KEYS.CMD_DISCONNECT)).toBe("1");
      if (app === "zepp-workout") expect(renderContract(tree)).toMatchSnapshot();
    });

    it("shows a valid pairing code when no QR image is available", () => {
      const url = "https://dofek.example/zepp-pairing?code=ABC234";
      const { images, links, text, tree } = render(app, {
        [STORAGE_KEYS.DOFEK_CONNECTION_STATUS]: JSON.stringify({ state: "pairing" }),
        [STORAGE_KEYS.PAIRING_SHORT_CODE]: "ABC234",
        [STORAGE_KEYS.PAIRING_VERIFICATION_URL]: url,
        [STORAGE_KEYS.PAIRING_EXPIRES_AT]: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      });
      expect(images).toEqual([]);
      expect(links).toContainEqual(expect.objectContaining({ source: url }));
      expect(text).toContain("ABC234");
      if (app === "zepp-main") expect(renderContract(tree)).toMatchSnapshot();
    });

    it("preserves pairing, login, and server configuration commands", () => {
      const { buttons, inputs, storage, tree } = render(app);
      buttons.find(({ label }) => label === "Create pairing code")?.onClick();
      expect(storage.getItem(STORAGE_KEYS.CMD_START_PAIRING)).toBe("1");
      inputs.find(({ label }) => label === "Server URL")?.onChange("https://custom.example");
      inputs.find(({ label }) => label === "Email")?.onChange("athlete@example.test");
      inputs.find(({ label }) => label === "Password")?.onChange("test-password");
      buttons.find(({ label }) => label === "Log in")?.onClick();
      expect(storage.getItem(STORAGE_KEYS.DOFEK_SERVER_URL)).toBe("https://custom.example");
      expect(JSON.parse(storage.getItem(STORAGE_KEYS.CMD_LOGIN_PASSWORD) ?? "{}")).toEqual({
        email: "athlete@example.test",
        password: "test-password",
        nonce: expect.any(Number),
      });
      if (app === "zepp-main") expect(renderContract(tree)).toMatchSnapshot();
    });

    it("shows connected actions and surfaces each delivery error", () => {
      const { text, buttons, storage } = render(app, {
        [STORAGE_KEYS.DOFEK_API_TOKEN]: "test-token",
        [STORAGE_KEYS.DOFEK_CONNECTION_STATUS]: JSON.stringify({ state: "connected" }),
        [STORAGE_KEYS.IMU_SYNC_STATUS]: JSON.stringify({
          state: "error",
          reason: "Phone upload failed",
        }),
        [STORAGE_KEYS.TRANSFER_PROGRESS]: JSON.stringify({
          state: "error",
          reason: "Transfer canceled",
        }),
      });
      expect(text).toContain("Connected");
      expect(text).toContain("Phone upload failed");
      expect(text).toContain("Transfer canceled");
      buttons.find(({ label }) => label === "Check connection")?.onClick();
      buttons.find(({ label }) => label === "Disconnect")?.onClick();
      expect(storage.getItem(STORAGE_KEYS.CMD_CHECK_CONNECTION)).toBe("1");
      expect(storage.getItem(STORAGE_KEYS.CMD_DISCONNECT)).toBe("1");
      expect(buttons.map(({ label }) => label)).not.toContain("Create pairing code");
    });

    it("keeps actionable connection errors visible and allows checking an existing token", () => {
      const { text, buttons } = render(app, {
        [STORAGE_KEYS.DOFEK_API_TOKEN]: "test-token",
        [STORAGE_KEYS.DOFEK_CONNECTION_STATUS]: JSON.stringify({
          state: "error",
          reason: "Reconnect your watch",
        }),
      });
      expect(text).toContain("Reconnect your watch");
      expect(buttons.map(({ label }) => label)).toContain("Check connection");
      expect(buttons.map(({ label }) => label)).not.toContain("Log in");
    });

    it("reports malformed stored status and renders the recovery controls", () => {
      const { text, buttons } = render(app, { [STORAGE_KEYS.DOFEK_CONNECTION_STATUS]: "{" });
      expect(text).toContain("Stored settings data is invalid");
      expect(buttons.map(({ label }) => label)).toContain("Create pairing code");
    });

    it("hides pairing details without valid expiry data", () => {
      const { images, text, tree } = render(app, {
        [STORAGE_KEYS.DOFEK_CONNECTION_STATUS]: JSON.stringify({
          state: "pairing",
          reason: "Waiting for approval on your phone",
        }),
        [STORAGE_KEYS.PAIRING_SHORT_CODE]: "ABC234",
        [STORAGE_KEYS.PAIRING_VERIFICATION_URL]: "https://dofek.example/pair",
      });
      expect(images).toEqual([]);
      expect(text).not.toContain("ABC234");
      expect(text).not.toContain("Expires");
      expect(text).toContain("Pairing code expired");
      if (app === "zepp-main") expect(renderContract(tree)).toMatchSnapshot();
    });

    it("hides expired and malformed pairing details", () => {
      for (const expiresAt of ["invalid", "2020-01-01T00:00:00Z"]) {
        const { images, links, text } = render(app, {
          [STORAGE_KEYS.DOFEK_CONNECTION_STATUS]: JSON.stringify({ state: "pairing" }),
          [STORAGE_KEYS.PAIRING_SHORT_CODE]: "STALE1",
          [STORAGE_KEYS.PAIRING_VERIFICATION_URL]: "https://dofek.example/stale",
          [STORAGE_KEYS.PAIRING_QR_IMAGE_URL]: "https://dofek.example/stale.svg",
          [STORAGE_KEYS.PAIRING_EXPIRES_AT]: expiresAt,
        });
        expect(images).toEqual([]);
        expect(links).toEqual([]);
        expect(text).not.toContain("STALE1");
        expect(text).not.toContain("Invalid Date");
        expect(text).toContain("Pairing code expired");
      }
    });

    it("keeps delivery failures visible while disconnected", () => {
      const values: Record<string, string> = {
        [STORAGE_KEYS.IMU_SYNC_STATUS]: JSON.stringify({ state: "error", reason: "Upload failed" }),
        [STORAGE_KEYS.TRANSFER_PROGRESS]: JSON.stringify({
          state: "error",
          reason: "Transfer failed",
        }),
      };
      if (app === "zepp-main") {
        values[STORAGE_KEYS.HEALTH_SERVICE_STATUS] = JSON.stringify({
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
        [STORAGE_KEYS.DOFEK_API_TOKEN]: "   ",
        [STORAGE_KEYS.DOFEK_CONNECTION_STATUS]: JSON.stringify({ state: "connected" }),
      });
      expect(text).toContain("Not connected");
      expect(buttons.map(({ label }) => label)).toContain("Create pairing code");
      expect(buttons.map(({ label }) => label)).not.toContain("Check connection");
    });
  });
}

it("preserves recorder start/stop, file transfer, and health sync", () => {
  const { text, buttons, storage } = render("zepp-main", {
    [STORAGE_KEYS.DOFEK_API_TOKEN]: "test-token",
    [STORAGE_KEYS.DOFEK_CONNECTION_STATUS]: JSON.stringify({ state: "connected" }),
    [STORAGE_KEYS.SESSION_STATUS]: JSON.stringify({
      state: "recording",
      sampleCount: 42,
      observedHzX100: 2500,
      hasGyro: true,
    }),
    [STORAGE_KEYS.HEALTH_SERVICE_STATUS]: JSON.stringify({
      state: "error",
      reason: "Health service did not start",
    }),
    [STORAGE_KEYS.TRANSFER_PROGRESS]: JSON.stringify({ state: "sending", pct: 37 }),
    [STORAGE_KEYS.LAST_EXPORT_PATH]: "data://session.bin",
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
  expect(storage.getItem(STORAGE_KEYS.CMD_LOGGING)).toBe("stop");
  expect(storage.getItem(STORAGE_KEYS.CMD_TRANSFER)).toBe("1");
  expect(storage.getItem(STORAGE_KEYS.CMD_SYNC_HEALTH)).toBe("1");
});

it("accepts only integer sample-rate modes from zero through two", () => {
  const { inputs, storage } = render("zepp-main");
  const sampleRate = inputs.find(({ label }) => label.startsWith("Sample rate mode"));
  if (!sampleRate) throw new Error("Sample rate input was not rendered");

  for (const valid of ["0", "1", "2"]) {
    sampleRate.onChange(valid);
    expect(storage.getItem(STORAGE_KEYS.PREF_FREQ_MODE)).toBe(valid);
  }
  for (const invalid of ["-1", "3", "1.5", "invalid"]) {
    sampleRate.onChange(invalid);
    expect(storage.getItem(STORAGE_KEYS.PREF_FREQ_MODE)).toBe("2");
  }
});

it("treats an empty stored status as absent", () => {
  const { text } = render("zepp-main", { [STORAGE_KEYS.DOFEK_CONNECTION_STATUS]: "" });
  expect(text).toContain("Not connected");
  expect(text).not.toContain("Stored settings data is invalid");
});

it("surfaces non-object stored status values", () => {
  for (const stored of ["null", '"value"', '["value"]']) {
    const { text } = render("zepp-main", { [STORAGE_KEYS.DOFEK_CONNECTION_STATUS]: stored });
    expect(text).toContain("Needs attention");
    expect(text).toContain("Stored settings data is invalid");
    expect(text).toContain("value:");
  }
});

it("surfaces schema-invalid stored status fields", () => {
  const { text } = render("zepp-main", {
    [STORAGE_KEYS.SESSION_STATUS]: JSON.stringify({
      state: "recording",
      observedHzX100: "fast",
      hasGyro: "yes",
    }),
  });
  expect(text).toContain("Stored settings data is invalid");
  expect(text).toContain("observedHzX100");
  expect(text).toContain("hasGyro");
  expect(text).not.toContain("NaN Hz");
});

it("treats a pairing code expiring now as expired", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-07T12:00:00Z"));
  try {
    const { links, text } = render("zepp-main", {
      [STORAGE_KEYS.DOFEK_CONNECTION_STATUS]: JSON.stringify({ state: "pairing" }),
      [STORAGE_KEYS.PAIRING_SHORT_CODE]: "STALE1",
      [STORAGE_KEYS.PAIRING_VERIFICATION_URL]: "https://dofek.example/stale",
      [STORAGE_KEYS.PAIRING_EXPIRES_AT]: "2026-09-07T12:00:00Z",
    });
    expect(text).toContain("Pairing code expired");
    expect(text).not.toContain("STALE1");
    expect(links).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

it("requires both pairing-code fields before showing pairing details", () => {
  const partialPairingValues: Array<Record<string, string>> = [
    { [STORAGE_KEYS.PAIRING_SHORT_CODE]: "ABC234" },
    {
      [STORAGE_KEYS.PAIRING_SHORT_CODE]: "ABC234",
      [STORAGE_KEYS.PAIRING_EXPIRES_AT]: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    },
    {
      [STORAGE_KEYS.PAIRING_VERIFICATION_URL]: "https://dofek.example/pair",
      [STORAGE_KEYS.PAIRING_EXPIRES_AT]: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    },
  ];
  for (const values of partialPairingValues) {
    const { links, text } = render("zepp-main", {
      [STORAGE_KEYS.DOFEK_CONNECTION_STATUS]: JSON.stringify({ state: "pairing" }),
      ...values,
    });
    expect(text).toContain("Pairing code expired");
    expect(text).not.toContain("ABC234");
    expect(links).toEqual([]);
  }
});

it("toggles an existing one-shot command off", () => {
  const { buttons, storage } = render("zepp-main", { [STORAGE_KEYS.CMD_START_PAIRING]: "1" });
  buttons.find(({ label }) => label === "Create pairing code")?.onClick();
  expect(storage.getItem(STORAGE_KEYS.CMD_START_PAIRING)).toBe("0");
});

it("submits an empty password when login is clicked before typing", () => {
  const { buttons, storage } = render("zepp-main");
  buttons.find(({ label }) => label === "Log in")?.onClick();
  expect(JSON.parse(storage.getItem(STORAGE_KEYS.CMD_LOGIN_PASSWORD) ?? "{}")).toEqual({
    email: "",
    password: "",
    nonce: expect.any(Number),
  });
});

it("styles connection and delivery errors distinctly from retry information", () => {
  const { tree } = render("zepp-main", {
    [STORAGE_KEYS.DOFEK_API_TOKEN]: "test-token",
    [STORAGE_KEYS.DOFEK_CONNECTION_STATUS]: JSON.stringify({ state: "error", reason: "Reconnect" }),
    [STORAGE_KEYS.IMU_SYNC_STATUS]: JSON.stringify({ state: "retrying", reason: "Trying again" }),
    [STORAGE_KEYS.TRANSFER_PROGRESS]: JSON.stringify({ state: "error", reason: "Transfer failed" }),
  });
  expect(renderContract(tree)).toMatchSnapshot();
});
