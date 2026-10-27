import { describe, expect, it } from "vitest";
import { normalizeActivityHardware } from "./activity-hardware.ts";

const member = { activityId: "member", providerId: "garmin", sourceName: null, raw: null };
describe("activity hardware", () => {
  it.each([
    [3299, "Hrm Dual"],
    [3300, "Hrm Pro"],
    [3258, "Descent Mk2"],
  ])("formats known Garmin product %s outside the watch families", (product, label) => {
    const result = normalizeActivityHardware([
      {
        ...member,
        observations: [
          { sequence: 0, messageType: "device_info", raw: { manufacturer: 1, product } },
        ],
      },
    ]);
    expect(result.items[0]).toMatchObject({ label, model: label });
  });
  it.each([
    ["garmin", { deviceName: "fr955" }],
    ["strava", { device_name: "fr955" }],
  ])("resolves API device names from %s while preserving source identity", (providerId, raw) => {
    const result = normalizeActivityHardware([
      { ...member, providerId, sourceName: "fr955", raw, observations: [] },
    ]);
    expect(result.items[0]).toMatchObject({ label: "Forerunner 955", sourceName: "fr955" });
  });
  it("resolves known underscore-delimited device names before generic formatting", () => {
    const result = normalizeActivityHardware([
      { ...member, raw: { deviceName: "fr_955" }, observations: [] },
    ]);
    expect(result.items[0]).toMatchObject({ label: "Forerunner 955" });
  });
  it.each([
    { providerId: "ride-with-gps", raw: { source: "fr_955" }, details: [] },
    {
      providerId: "amazfit-zepp",
      raw: { source: "fr_955", app_name: "fr_955" },
      details: [{ label: "App", value: "Forerunner 955" }],
    },
    {
      providerId: "amazfit-zepp",
      raw: { app_name: "fr_955" },
      details: [{ label: "App", value: "Forerunner 955" }],
    },
  ])(
    "resolves model tokens in $providerId source fields without changing identity",
    ({ providerId, raw, details }) => {
      const result = normalizeActivityHardware([
        { ...member, providerId, raw, sourceName: "fr_955", observations: [] },
      ]);
      expect(result.items[0]).toMatchObject({
        label: "Forerunner 955",
        sourceName: "fr_955",
        details,
      });
    },
  );
  it.each(["apple_health", "apple-health"])(
    "resolves HealthKit hardware identifiers from %s and retains the reported name",
    (providerId) => {
      const result = normalizeActivityHardware([
        {
          ...member,
          providerId,
          sourceName: "Workout app",
          raw: {
            device: {
              name: "Asher’s Apple Watch",
              model: "Watch",
              manufacturer: "Apple Inc.",
              hardwareVersion: "Watch6,9",
              softwareVersion: "26.6",
            },
          },
          observations: [],
        },
      ]);
      expect(result.items[0]).toMatchObject({
        label: "Apple Watch Series 7 (GPS + Cellular, 45mm)",
        model: "Apple Watch Series 7 (GPS + Cellular, 45mm)",
        sourceName: "Workout app",
        details: expect.arrayContaining([
          { label: "Device name", value: "Asher’s Apple Watch" },
          { label: "Software", value: "26.6" },
        ]),
      });
    },
  );
  it("resolves a HealthKit model identifier alongside an unrelated hardware revision", () => {
    const result = normalizeActivityHardware([
      {
        ...member,
        providerId: "apple_health",
        raw: { device: { model: "Watch6,9", hardwareVersion: "2" } },
        observations: [],
      },
    ]);
    expect(result.items[0]).toMatchObject({
      label: "Apple Watch Series 7 (GPS + Cellular, 45mm)",
      model: "Apple Watch Series 7 (GPS + Cellular, 45mm)",
    });
  });
  it.each([
    { name: "My Watch", softwareVersion: "26.6" },
    {
      name: "Apple Watch Series 7 (GPS + Cellular, 45mm)",
      hardwareVersion: "Watch6,9",
      softwareVersion: "26.6",
    },
  ])("keeps HealthKit device details concise for %j", (device) => {
    const result = normalizeActivityHardware([
      { ...member, providerId: "apple_health", raw: { device }, observations: [] },
    ]);
    expect(result.items[0]?.details).toEqual([{ label: "Software", value: "26.6" }]);
  });
  it("keeps the reported name when an Apple model cannot be identified", () => {
    const result = normalizeActivityHardware([
      {
        ...member,
        providerId: "apple_health",
        raw: { device: { name: "My Watch", model: "Watch", hardwareVersion: "Watch99,99" } },
        observations: [],
      },
    ]);
    expect(result.items[0]).toMatchObject({ label: "My Watch", model: null });
  });
  it.each(["Watch99,99", "iPhone99,99", "iPad99,99", "iPod99,99"])(
    "keeps a personal name when Apple model %s is unresolved",
    (model) => {
      const result = normalizeActivityHardware([
        {
          ...member,
          providerId: "apple_health",
          raw: { device: { name: "My device", model } },
          observations: [],
        },
      ]);
      expect(result.items[0]).toMatchObject({ label: "My device", model: null });
    },
  );
  it("qualifies an unresolved Apple device that has no reported name", () => {
    const result = normalizeActivityHardware([
      {
        ...member,
        providerId: "apple_health",
        raw: { device: { model: "Watch99,99" } },
        observations: [],
      },
    ]);
    expect(result.items[0]).toMatchObject({ label: "Unidentified device", model: null });
  });
  it.each([
    [{ manufacturer: 1, product: 4024 }, "Forerunner 955", "Garmin"],
    [{ manufacturer: "1", product: "4024" }, "Forerunner 955", "Garmin"],
    [{ manufacturer: "garmin", product: 4024 }, "Forerunner 955", "Garmin"],
    [{ manufacturer: 1, product: 4375 }, "fēnix 7 Pro Solar", "Garmin"],
    [{ manufacturer: 1, product: 2271 }, "vívosmart 2", "Garmin"],
    [{ manufacturer: 1, product: 3991 }, "Forerunner 255 Small Music", "Garmin"],
    [{ manufacturer: 1, garminProduct: 4315 }, "Forerunner 965", "Garmin"],
    [{ manufacturer: "garmin", garminProduct: "fr955" }, "Forerunner 955", "Garmin"],
    [{ manufacturer: 263, faveroProduct: 12 }, "Assioma Duo", "Favero Electronics"],
    [{ manufacturer: "faveroElectronics", product: 12 }, "Assioma Duo", "Favero Electronics"],
    [
      { manufacturer: "faveroElectronics", product: "assiomaUno" },
      "Assioma Uno",
      "Favero Electronics",
    ],
  ])("resolves manufacturer-scoped FIT products %j", (raw, label, manufacturer) => {
    const result = normalizeActivityHardware([
      { ...member, observations: [{ sequence: 0, messageType: "device_info", raw }] },
    ]);
    expect(result.items[0]).toMatchObject({ label, model: label, manufacturer });
  });
  it.each([32, "wahooFitness"])(
    "does not resolve manufacturer %s's product number as Garmin hardware",
    (manufacturer) => {
      const result = normalizeActivityHardware([
        {
          ...member,
          observations: [
            {
              sequence: 0,
              messageType: "device_info",
              raw: { manufacturer, product: 4024, sourceType: 1, deviceType: 120 },
            },
          ],
        },
      ]);
      expect(result.items[0]).toMatchObject({
        label: "Heart Rate",
        model: null,
        manufacturer: "Wahoo Fitness",
      });
    },
  );
  it("preserves a reported manufacturer name beginning with a digit", () => {
    const result = normalizeActivityHardware([
      {
        ...member,
        observations: [
          {
            sequence: 0,
            messageType: "device_info",
            raw: { manufacturer: "3T", productName: "Power meter" },
          },
        ],
      },
    ]);
    expect(result.items[0]).toMatchObject({
      label: "Power meter",
      model: "Power meter",
      manufacturer: "3T",
    });
  });
  it.each([
    ["Watch7,12", "Apple Watch Ultra 3"],
    ["watch7,12", "Apple Watch Ultra 3"],
    ["Watch7,10", "Apple Watch Series 10 (GPS + Cellular, 42mm)"],
    ["Watch6,13", "Apple Watch SE (2nd generation, GPS + Cellular, 44mm)"],
    ["Watch8,4", "Apple Watch Series 12 (GPS + Cellular, 42mm)"],
  ])(
    "resolves specific HealthKit source product %s without guessing",
    (sourceProductType, model) => {
      const result = normalizeActivityHardware([
        {
          ...member,
          providerId: "apple_health",
          observations: [],
          raw: {
            sourceProductType,
            device: { name: "My Watch", model: "Watch", manufacturer: "Apple" },
          },
        },
      ]);
      expect(result.items[0]).toMatchObject({ label: model, model });
      expect(result.items[0]?.details).toContainEqual({
        label: "Device name",
        value: "My Watch",
      });
    },
  );
  it.each(["Watch99,1", "watch99,1"])(
    "keeps the personal name when source product %s is unknown",
    (sourceProductType) => {
      const result = normalizeActivityHardware([
        {
          ...member,
          providerId: "apple_health",
          observations: [],
          raw: { sourceProductType, device: { name: "My Watch", model: "Watch" } },
        },
      ]);
      expect(result.items[0]).toMatchObject({ label: "My Watch", model: null });
    },
  );
  it.each(["iPhone16,1", "iPad13,4"])(
    "keeps a non-watch source product %s separate from watch model evidence",
    (sourceProductType) => {
      const result = normalizeActivityHardware([
        {
          ...member,
          providerId: "apple_health",
          observations: [],
          raw: { sourceProductType, device: { name: "My device", model: "Watch" } },
        },
      ]);
      expect(result.items[0]).toMatchObject({ label: "My device", model: null });
    },
  );
  it.each(["Watch7,12", "watch7,12"])(
    "resolves retained HealthKit device model %s when the source product is unavailable",
    (model) => {
      const result = normalizeActivityHardware([
        {
          ...member,
          providerId: "apple_health",
          observations: [],
          raw: { device: { model } },
        },
      ]);
      expect(result.items[0]).toMatchObject({
        label: "Apple Watch Ultra 3",
        model: "Apple Watch Ultra 3",
      });
    },
  );
  it("retains an unrecognized model name without resolving inherited lookup properties", () => {
    const result = normalizeActivityHardware([
      {
        ...member,
        providerId: "apple_health",
        observations: [],
        raw: { device: { model: "constructor" } },
      },
    ]);
    expect(result.items[0]).toMatchObject({ label: "constructor", model: "constructor" });
  });
  it.each(["Watch7,12", "watch7,12"])(
    "resolves retained hardware-version identifier %s when HealthKit reports a generic model",
    (hardwareVersion) => {
      const result = normalizeActivityHardware([
        {
          ...member,
          providerId: "apple_health",
          observations: [],
          raw: { device: { model: "Watch", hardwareVersion } },
        },
      ]);
      expect(result.items[0]).toMatchObject({
        label: "Apple Watch Ultra 3",
        model: "Apple Watch Ultra 3",
      });
    },
  );
  it("keeps source-product evidence ahead of reported model and hardware-version identifiers", () => {
    const result = normalizeActivityHardware([
      {
        ...member,
        providerId: "apple_health",
        observations: [],
        raw: {
          sourceProductType: "Watch7,12",
          device: { model: "Watch6,18", hardwareVersion: "Watch7,5" },
        },
      },
    ]);
    expect(result.items[0]?.model).toBe("Apple Watch Ultra 3");
  });
  it("keeps a specific reported model ahead of hardware-version identifiers", () => {
    const result = normalizeActivityHardware([
      {
        ...member,
        providerId: "apple_health",
        observations: [],
        raw: { device: { model: "Watch6,18", hardwareVersion: "Watch7,5" } },
      },
    ]);
    expect(result.items[0]?.model).toBe("Apple Watch Ultra");
  });
  it("does not infer a model from a generic numeric hardware version", () => {
    const result = normalizeActivityHardware([
      {
        ...member,
        providerId: "apple_health",
        observations: [],
        raw: { device: { name: "My Watch", model: "Watch", hardwareVersion: "2" } },
      },
    ]);
    expect(result.items[0]).toMatchObject({ label: "My Watch", model: null });
  });
  it.each(["Watch", "Apple Watch", "Apple_Watch"])(
    "does not claim generic %s is a specific model",
    (model) => {
      const result = normalizeActivityHardware([
        {
          ...member,
          providerId: "apple_health",
          observations: [],
          raw: { device: { name: "My Watch", model } },
        },
      ]);
      expect(result.items[0]).toMatchObject({ label: "My Watch", model: null });
    },
  );
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
  it("qualifies unidentified FIT hardware without guessing a manufacturer or model", () => {
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
  it("does not reconcile ambiguous or incompatible serial evidence without a device index", () => {
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
  it("reconciles updates without a device index only to a unique compatible manufacturer and serial", () => {
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
    for (const [device_watts, kind, label] of [
      [true, "measured", "Power · Measured · Strava"],
      [false, "estimated", "Power · Estimated · Strava"],
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
      expect(result.power[0]?.label).toBe(label);
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
      model: null,
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
      "Bike",
      "Polar Vantage V3",
      "Ride with GPS for iPhone",
      "Watch",
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
  it.each([
    ["home_bike_plus", "Peloton Bike+"],
    ["home_bike_v1", "Peloton Bike"],
    ["home_bike", "Peloton Bike"],
    ["bike", "Bike"],
    ["future_equipment", "Future equipment"],
  ])("names Peloton equipment %s readably", (deviceType, label) => {
    const result = normalizeActivityHardware([
      {
        ...member,
        providerId: "peloton",
        raw: { deviceType, platform: "home_bike" },
        observations: [],
      },
    ]);
    expect(result.items[0]).toMatchObject({ label, role: "category", model: null });
    expect(result.items[0]?.details).toEqual([{ label: "Platform", value: "Peloton Bike" }]);
  });
  it("uses a readable Peloton platform when the equipment type is missing", () => {
    const result = normalizeActivityHardware([
      {
        ...member,
        providerId: "peloton",
        raw: { platform: "home_bike" },
        observations: [],
      },
    ]);
    expect(result.items[0]).toMatchObject({ label: "Peloton Bike", model: null });
  });
  it("formats source codes while preserving their provider provenance", () => {
    const result = normalizeActivityHardware([
      {
        ...member,
        providerId: "amazfit-zepp",
        raw: { source: "fitness_watch", app_name: "fitness_app" },
        observations: [],
      },
      {
        ...member,
        providerId: "ride-with-gps",
        raw: { source: "fitness_app" },
        observations: [],
      },
    ]);
    expect(result.items.map((item) => item.label)).toEqual(["Fitness watch", "Fitness app"]);
    expect(result.items[0]?.details).toEqual([{ label: "App", value: "Fitness app" }]);
    expect(result.items.map((item) => item.providerId)).toEqual(["amazfit-zepp", "ride-with-gps"]);
  });
  it("uses the same readable name for matching source metadata", () => {
    const result = normalizeActivityHardware([
      {
        ...member,
        providerId: "ride-with-gps",
        sourceName: "ridewithgps_iphone",
        raw: { source: "ridewithgps_iphone" },
        observations: [],
      },
    ]);
    expect(result.items[0]).toMatchObject({
      label: "Ride with GPS for iPhone",
      sourceName: "Ride with GPS for iPhone",
    });
  });
  it.each([
    ["strava", { device_name: "Garmin_Edge_530" }, "Garmin Edge 530"],
    ["garmin", { deviceName: "Garmin_Edge_530" }, "Garmin Edge 530"],
    ["apple_health", { device: { name: "Apple_Watch" } }, "Apple Watch"],
  ])("formats reported device and source names from %s", (providerId, raw, label) => {
    const result = normalizeActivityHardware([
      {
        ...member,
        providerId,
        sourceName: "Workout_app",
        raw,
        observations: [],
      },
    ]);
    expect(result.items[0]).toMatchObject({ label, sourceName: "Workout app" });
  });
  it("preserves brand casing in reported device and source names", () => {
    const result = normalizeActivityHardware([
      {
        ...member,
        providerId: "strava",
        sourceName: "WHOOP",
        raw: { device_name: "Edge 530" },
        observations: [],
      },
      {
        ...member,
        providerId: "amazfit-zepp",
        sourceName: "iPhone",
        raw: { source: "iPhone" },
        observations: [],
      },
    ]);
    expect(result.items.map((item) => [item.label, item.sourceName])).toEqual([
      ["Edge 530", "WHOOP"],
      ["iPhone", "iPhone"],
    ]);
  });
  it("formats FIT product names while preserving device identifiers", () => {
    const result = normalizeActivityHardware([
      {
        ...member,
        observations: [
          {
            sequence: 0,
            messageType: "device_info",
            raw: {
              deviceIndex: 0,
              productName: "Garmin_Edge_530",
              manufacturer: 1,
              serialNumber: "ABC_123",
            },
          },
        ],
      },
    ]);
    expect(result.items[0]).toMatchObject({
      label: "Garmin Edge 530",
      model: "Garmin Edge 530",
      manufacturer: "Garmin",
    });
    expect(result.items[0]?.details).toContainEqual({ label: "Serial number", value: "ABC_123" });
  });
  it("formats HealthKit model and manufacturer names while preserving local identifiers", () => {
    const result = normalizeActivityHardware([
      {
        ...member,
        providerId: "apple_health",
        raw: {
          device: {
            name: "My_Watch",
            model: "Watch_Ultra",
            manufacturer: "Apple_Inc",
            localIdentifier: "local_identifier",
          },
        },
        observations: [],
      },
    ]);
    expect(result.items[0]).toMatchObject({
      label: "My Watch",
      model: "Watch Ultra",
      manufacturer: "Apple Inc",
    });
    expect(result.items[0]?.details).toContainEqual({
      label: "Local identifier",
      value: "local_identifier",
    });
  });
  it.each(["garmin", "apple_health", "apple-health"])(
    "leaves absent metadata from %s empty",
    (providerId) => {
      expect(normalizeActivityHardware([{ ...member, providerId, observations: [] }])).toEqual({
        items: [],
        power: [],
      });
    },
  );
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
