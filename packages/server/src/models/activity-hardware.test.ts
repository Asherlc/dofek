import { describe, expect, it } from "vitest";
import { normalizeActivityHardware } from "./activity-hardware.ts";

const member = { activityId: "member", providerId: "garmin", sourceName: null, raw: null };
describe("activity hardware", () => {
  it("consolidates partial FIT updates without losing identity or inventing sensor attribution", () => {
    const result = normalizeActivityHardware([
      {
        ...member,
        observations: [
          {
            sequence: 0,
            messageType: "file_id",
            raw: { manufacturer: 1, productName: "Edge 530", serialNumber: 11 },
          },
          {
            sequence: 1,
            messageType: "device_info",
            raw: { deviceIndex: 0, manufacturer: 1, productName: "Edge 530", serialNumber: 11 },
          },
          {
            sequence: 2,
            messageType: "device_info",
            raw: {
              deviceIndex: 1,
              manufacturer: 32,
              productName: "HRM",
              serialNumber: 22,
              batteryVoltage: 3,
            },
          },
          {
            sequence: 3,
            messageType: "device_info",
            raw: { deviceIndex: 1, batteryVoltage: 2.8, manufacturer: null },
          },
        ],
      },
    ]);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      role: "creator",
      label: "Edge 530",
      manufacturer: "Garmin",
    });
    expect(result.items[1]).toMatchObject({ role: "sensor", label: "HRM" });
    expect(result.items[1]?.details).toContainEqual({ label: "Serial number", value: "22" });
    expect(result.items[1]?.details).toContainEqual({ label: "Battery voltage", value: "2.8 V" });
    expect(result.items[1]?.evidence).toContain("does not identify");
  });
  it("retains unknown FIT codes as qualified details", () => {
    const result = normalizeActivityHardware([
      {
        ...member,
        observations: [
          { sequence: 1, messageType: "device_info", raw: { manufacturer: 65000, product: 65001 } },
        ],
      },
    ]);
    expect(result.items[0]).toMatchObject({
      role: "unknown",
      label: "Unidentified device",
      manufacturer: null,
      model: null,
    });
    expect(result.items[0]?.details).toContainEqual({ label: "Manufacturer code", value: "65000" });
  });
  it("keeps explicit FIT indices distinct despite serial collisions and attaches later partial updates to their index", () => {
    const result = normalizeActivityHardware([
      {
        ...member,
        observations: [
          {
            sequence: 1,
            messageType: "device_info",
            raw: { device_index: 1, manufacturer: 1, serial_number: 123, product_name: "Sensor A" },
          },
          {
            sequence: 2,
            messageType: "device_info",
            raw: {
              device_index: 2,
              manufacturer: 32,
              serial_number: 123,
              product_name: "Sensor B",
            },
          },
          {
            sequence: 3,
            messageType: "device_info",
            raw: { device_index: 2, battery_voltage: 2.7 },
          },
        ],
      },
    ]);
    expect(result.items.map((item) => item.label)).toEqual(["Sensor A", "Sensor B"]);
    expect(result.items[0]).toMatchObject({ manufacturer: "Garmin" });
    expect(result.items[1]?.details).toContainEqual({ label: "Device index", value: "2" });
    expect(result.items[1]?.details).toContainEqual({ label: "Battery voltage", value: "2.7 V" });
  });
  it("does not reconcile ambiguous or incompatible unindexed serial evidence", () => {
    const result = normalizeActivityHardware([
      {
        ...member,
        observations: [
          {
            sequence: 1,
            messageType: "device_info",
            raw: { device_index: 1, manufacturer: 1, serial_number: 123, product_name: "A" },
          },
          {
            sequence: 2,
            messageType: "device_info",
            raw: { device_index: 2, manufacturer: 1, serial_number: 123, product_name: "B" },
          },
          {
            sequence: 3,
            messageType: "device_info",
            raw: { manufacturer: 1, serial_number: 123, battery_voltage: 2.7 },
          },
          {
            sequence: 4,
            messageType: "device_info",
            raw: { manufacturer: 32, serial_number: 123, product_name: "C" },
          },
        ],
      },
    ]);
    expect(result.items).toHaveLength(4);
    expect(result.items.map((item) => item.label)).toEqual(["A", "B", "Garmin", "C"]);
  });
  it("reconciles unindexed updates only to a unique compatible manufacturer and serial", () => {
    const result = normalizeActivityHardware([
      {
        ...member,
        observations: [
          {
            sequence: 1,
            messageType: "device_info",
            raw: { device_index: 1, manufacturer: 1, serial_number: 123, product_name: "A" },
          },
          {
            sequence: 2,
            messageType: "device_info",
            raw: { device_index: 2, manufacturer: 32, serial_number: 123, product_name: "B" },
          },
          {
            sequence: 3,
            messageType: "device_info",
            raw: { manufacturer: 32, serial_number: 123, battery_voltage: 2.7 },
          },
        ],
      },
    ]);
    expect(result.items.map((item) => item.label)).toEqual(["A", "B"]);
    expect(result.items[1]?.details).toContainEqual({ label: "Battery voltage", value: "2.7 V" });
  });
  it("retains conflicting creator identities and follows the explicit index for later partial facts", () => {
    const result = normalizeActivityHardware([
      {
        ...member,
        observations: [
          {
            sequence: 0,
            messageType: "file_id",
            raw: { manufacturer: 1, serial_number: 123, product_name: "Creator A" },
          },
          {
            sequence: 1,
            messageType: "device_info",
            raw: {
              device_index: 0,
              manufacturer: 32,
              serial_number: 123,
              product_name: "Creator B",
            },
          },
          {
            sequence: 2,
            messageType: "device_info",
            raw: { device_index: 0, battery_voltage: 2.7 },
          },
        ],
      },
    ]);
    expect(result.items.map((item) => [item.role, item.label])).toEqual([
      ["creator", "Creator A"],
      ["creator", "Creator B"],
    ]);
    expect(result.items[1]?.details).toContainEqual({ label: "Battery voltage", value: "2.7 V" });
  });
  it("qualifies FIT exporters as creators while retaining separately reported recording hardware", () => {
    for (const [providerId, raw] of [
      ["garmin", { deviceName: "Edge 530" }],
      ["strava", { device_name: "Edge 530" }],
    ] as const) {
      const result = normalizeActivityHardware([
        {
          ...member,
          providerId,
          raw,
          observations: [
            {
              sequence: 0,
              messageType: "file_id",
              raw: { product_name: "Export platform", manufacturer: 32 },
            },
            {
              sequence: 1,
              messageType: "device_info",
              raw: { device_index: 0, product_name: "Export platform", manufacturer: 32 },
            },
          ],
        },
      ]);
      expect(result.items.map((item) => [item.role, item.label])).toEqual([
        ["creator", "Export platform"],
        ["recorder", "Edge 530"],
      ]);
      expect(result.items[0]?.evidence).toContain("may be an export platform");
    }
  });
  it("uses Strava recording names and explicit power evidence", () => {
    for (const [device_watts, kind] of [
      [true, "measured"],
      [false, "estimated"],
    ] as const) {
      const result = normalizeActivityHardware([
        {
          ...member,
          providerId: "strava",
          raw: { device_name: "Garmin Edge 530", device_watts },
          observations: [],
        },
      ]);
      expect(result.items[0]?.label).toBe("Garmin Edge 530");
      expect(result.power[0]?.kind).toBe(kind);
    }
  });
  it("keeps HealthKit device and importing app separate", () => {
    const result = normalizeActivityHardware([
      {
        ...member,
        providerId: "apple_health",
        sourceName: "Workout app",
        raw: {
          device: {
            name: "My Watch",
            model: "Watch",
            manufacturer: "Apple",
            localIdentifier: "local",
          },
        },
        observations: [],
      },
    ]);
    expect(result.items[0]).toMatchObject({
      label: "My Watch",
      sourceName: "Workout app",
      model: "Watch",
    });
  });
  it("preserves coarse equipment and source provenance without guessing models", () => {
    const result = normalizeActivityHardware([
      {
        ...member,
        providerId: "peloton",
        raw: { deviceType: "bike", platform: "home_bike" },
        observations: [],
      },
      {
        ...member,
        providerId: "polar",
        raw: { device: "Polar Vantage V3", device_id: "ABC" },
        observations: [],
      },
      {
        ...member,
        providerId: "ride-with-gps",
        raw: { source: "ridewithgps_iphone" },
        observations: [],
      },
      {
        ...member,
        providerId: "amazfit-zepp",
        raw: { source: "watch", app_name: "Zepp" },
        observations: [],
      },
    ]);
    expect(result.items.map((item) => item.label)).toEqual([
      "bike",
      "Polar Vantage V3",
      "ridewithgps_iphone",
      "watch",
    ]);
    expect(result.items[0]?.model).toBeNull();
    expect(result.items.map((item) => item.role)).toEqual([
      "category",
      "recorder",
      "source",
      "source",
    ]);
    expect(result.items[0]?.evidence).toContain("category");
  });
  it("leaves unsupported and absent metadata empty", () => {
    expect(normalizeActivityHardware([{ ...member, observations: [] }])).toEqual({
      items: [],
      power: [],
    });
  });
  it("resolves numeric FIT device types from the official profile and keeps unknown identity facts", () => {
    const result = normalizeActivityHardware([
      {
        ...member,
        observations: [
          {
            sequence: 1,
            messageType: "device_info",
            raw: { device_index: 1, device_type: 120, source_type: 1 },
          },
        ],
      },
      {
        ...member,
        activityId: "health",
        providerId: "apple_health",
        raw: { device: { localIdentifier: "local", firmwareVersion: "1.0" } },
        observations: [],
      },
    ]);
    expect(result.items[0]).toMatchObject({ role: "sensor", label: "Heart Rate", model: null });
    expect(result.items[1]).toMatchObject({ label: "Unidentified device", model: null });
    expect(result.items[1]?.details).toContainEqual({ label: "Local identifier", value: "local" });
  });
});
