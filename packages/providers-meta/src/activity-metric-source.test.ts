import { describe, expect, it } from "vitest";
import {
  activityMetricSourcePresentation,
  activityMetricSourceSchema,
  activityMetricSourceText,
} from "./activity-metric-source.ts";

describe("activityMetricSourcePresentation", () => {
  it.each(["apple_health", "apple-health"])(
    "resolves Apple model names through %s without changing source identity",
    (providerId) => {
      const sourceName = "  Watch6,9  ";
      expect(
        activityMetricSourcePresentation(
          providerId,
          sourceName,
          "Apple Watch Series 7 (GPS + Cellular, 45mm) (via Apple Health)",
        ),
      ).toEqual({
        displayName: "Apple Watch Series 7 (GPS + Cellular, 45mm)",
        providerId,
        sourceName,
        attribution: { kind: "apple_health", label: "Apple Health" },
      });
    },
  );

  it("resolves a reported Bluetooth device model without changing its identity or attribution", () => {
    expect(
      activityMetricSourcePresentation(
        "ble_heart_rate",
        "fr955",
        "Heart Rate Monitor · Forerunner 955",
      ),
    ).toEqual({
      displayName: "Forerunner 955",
      providerId: "ble_heart_rate",
      sourceName: "fr955",
      attribution: { kind: "bluetooth", label: "Bluetooth" },
    });
  });

  it.each(["  Asher’s Apple Watch  ", "Watch99,99", "COROS PACE 3"])(
    "preserves custom and unknown Apple Health sources: %s",
    (sourceName) => {
      expect(
        activityMetricSourcePresentation(
          "apple_health",
          sourceName,
          `${sourceName} (via Apple Health)`,
        ),
      ).toEqual({
        displayName: sourceName.trim(),
        providerId: "apple_health",
        sourceName,
        attribution: { kind: "apple_health", label: "Apple Health" },
      });
    },
  );

  it.each([
    ["apple_health", "Zepp", "Zepp (via Apple Health)", "Zepp", "apple_health", "Apple Health"],
    [
      "apple-health",
      "Apple Watch",
      "Apple Watch (via Apple Health)",
      "Apple Watch",
      "apple_health",
      "Apple Health",
    ],
    ["whoop", null, "WHOOP (Cloud)", "WHOOP", "cloud", "Cloud"],
    ["whoop_ble", "opaque-strap", "WHOOP (Bluetooth)", "WHOOP", "bluetooth", "Bluetooth"],
    [
      "ble_heart_rate",
      "Polar H10",
      "Heart Rate Monitor (Bluetooth) · Polar H10",
      "Polar H10",
      "bluetooth",
      "Bluetooth",
    ],
    [
      "ble_heart_rate",
      null,
      "Heart Rate Monitor (Bluetooth)",
      "Heart Rate Monitor",
      "bluetooth",
      "Bluetooth",
    ],
  ])(
    "presents %s / %s from explicit metadata",
    (providerId, sourceName, label, displayName, kind, attributionLabel) => {
      expect(activityMetricSourcePresentation(providerId ?? "", sourceName, label ?? "")).toEqual({
        displayName,
        providerId,
        sourceName,
        attribution: { kind, label: attributionLabel },
      });
    },
  );

  it.each([null, "", "   ", "Apple Health", " apple HEALTH ", "HealthKit", " healthkit "])(
    "shows Apple Health without redundant transport attribution for self-source %j",
    (sourceName) => {
      expect(activityMetricSourcePresentation("apple_health", sourceName, "Apple Health")).toEqual({
        displayName: "Apple Health",
        providerId: "apple_health",
        sourceName,
        attribution: null,
      });
    },
  );

  it.each([
    [
      "unknown",
      "WHOOP (Cloud)",
      "WHOOP (Cloud) · recorded by Apple Watch",
      "WHOOP (Cloud) · recorded by Apple Watch",
    ],
    ["garmin", "Edge 530", "Garmin · recorded by Edge 530", "Edge 530"],
    [
      "fit-file",
      "Export platform",
      "FIT File · file created by Export platform",
      "Export platform",
    ],
    ["strava", null, "Strava", "Strava"],
    ["peloton", null, "Peloton", "Peloton"],
  ])(
    "uses a compact name for %s without inferring transport",
    (providerId, sourceName, label, displayName) => {
      expect(activityMetricSourcePresentation(providerId ?? "", sourceName, label ?? "")).toEqual({
        displayName,
        providerId,
        sourceName,
        attribution: null,
      });
    },
  );

  it("uses the structured recorder name instead of parsing qualified label text", () => {
    expect(
      activityMetricSourcePresentation(
        "strava",
        null,
        "Strava · recorded by Peloton Bike",
        "Peloton Bike",
      ),
    ).toEqual({
      displayName: "Peloton Bike",
      providerId: "strava",
      sourceName: null,
      attribution: null,
    });
  });

  it("validates a source with required structured presentation and retains its full label", () => {
    const source = {
      id: "opaque-source-id",
      label: "Zepp (via Apple Health)",
      presentation: {
        displayName: "Zepp",
        providerId: "apple_health",
        sourceName: "Zepp",
        attribution: { kind: "apple_health", label: "Apple Health" },
      },
    };
    expect(activityMetricSourceSchema.parse(source)).toEqual(source);
    expect(
      activityMetricSourceSchema.safeParse({ id: source.id, label: source.label }).success,
    ).toBe(false);
  });
});

describe("activityMetricSourceText", () => {
  it.each([
    ["peloton", null, "Peloton", null],
    ["strava", null, "Strava", null],
    ["whoop", null, "WHOOP (Cloud)", null],
    ["whoop_ble", "opaque-strap", "WHOOP (Bluetooth)", null],
    ["apple_health", "Peloton", "Peloton (via Apple Health)", null],
    ["apple_health", " peloton ", "peloton (via Apple Health)", null],
    ["apple_health", null, "Apple Health", null],
    [
      "apple_health",
      "Asher’s Apple Watch",
      "Asher’s Apple Watch (via Apple Health)",
      "Asher’s Apple Watch",
    ],
    ["garmin", "Edge 530", "Garmin · Edge 530", "Edge 530"],
    ["fit-file", null, "FIT File", "FIT File"],
    ["unknown", null, "Imported recording", "Imported recording"],
  ])("shows only distinguishing text beside the %s logo", (providerId, sourceName, label, text) => {
    const presentation = activityMetricSourcePresentation(
      providerId ?? "",
      sourceName,
      label ?? "",
    );
    expect(activityMetricSourceText(presentation)).toBe(text);
  });

  it("keeps the recorder name beside a different provider's logo", () => {
    const presentation = activityMetricSourcePresentation(
      "strava",
      null,
      "Strava · recorded by Peloton Bike",
      "Peloton Bike",
    );
    expect(activityMetricSourceText(presentation)).toBe("Peloton Bike");
  });
});
