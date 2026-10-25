import { describe, expect, it } from "vitest";
import type { ActivityHardwareItem } from "./activity-hardware.ts";
import { activitySourceTreeWithHardware } from "./activity-source-hardware.ts";
import { type ActivitySourceTreeNode, activitySourceTreeSchema } from "./activity-source-tree.ts";

function node(
  id: string,
  providerId: string,
  children: ActivitySourceTreeNode[] = [],
): ActivitySourceTreeNode {
  return {
    id,
    providerId,
    label: providerId,
    sourceName: null,
    description: null,
    url: null,
    children,
  };
}

function item(overrides: Partial<ActivityHardwareItem> = {}): ActivityHardwareItem {
  return {
    id: "hardware-1",
    activityId: "activity-1",
    providerId: "apple_health",
    sourceName: null,
    role: "recorder",
    label: "Apple Watch",
    model: "Watch",
    manufacturer: null,
    evidence: "Reported device",
    details: [{ label: "Software", value: "26.1" }],
    ...overrides,
  };
}

describe("activitySourceTreeWithHardware", () => {
  it.each(["Asher’s Apple Watch", "  ASHER’S APPLE WATCH  "])(
    "omits a device name fact that repeats the recording header: %s",
    (deviceName) => {
      const watch = {
        ...node("activity-1:recording-attribution", "apple-watch"),
        label: "Asher’s Apple Watch",
      };
      const result = activitySourceTreeWithHardware(
        { primary: node("activity-1", "apple_health", [watch]), otherSources: [] },
        {
          items: [
            item({
              model: "Apple Watch Ultra 3",
              details: [
                { label: "Device name", value: deviceName },
                { label: "Software", value: "26.6" },
              ],
            }),
          ],
          power: [],
        },
      );
      expect(result.primary?.children[0]?.details).toEqual([
        { label: "Model", value: "Apple Watch Ultra 3" },
        { label: "Software", value: "26.6" },
      ]);
    },
  );

  it("retains a personal device name beneath a model header", () => {
    const watch = {
      ...node("activity-1:recording-attribution", "apple-watch"),
      label: "Apple Watch Ultra 3",
    };
    const result = activitySourceTreeWithHardware(
      { primary: node("activity-1", "apple_health", [watch]), otherSources: [] },
      {
        items: [
          item({
            model: "Apple Watch Ultra 3",
            details: [
              { label: "Device name", value: "Asher’s Apple Watch" },
              { label: "Software", value: "26.6" },
            ],
          }),
        ],
        power: [],
      },
    );
    expect(result.primary?.children[0]?.details).toEqual([
      { label: "Device name", value: "Asher’s Apple Watch" },
      { label: "Software", value: "26.6" },
    ]);
  });

  it("resolves raw Apple model facts beneath a named watch without changing its source identity", () => {
    const watch = {
      ...node("activity-1:recording-attribution", "apple-watch"),
      label: "Asher’s Apple Watch",
      sourceName: "Watch6,9",
    };
    const result = activitySourceTreeWithHardware(
      { primary: node("activity-1", "apple_health", [watch]), otherSources: [] },
      { items: [item({ model: "Watch6,9", sourceName: "Watch6,9" })], power: [] },
    );
    expect(result.primary?.children[0]).toEqual({
      ...watch,
      details: [
        { label: "Model", value: "Apple Watch Series 7 (GPS + Cellular, 45mm)" },
        { label: "Software", value: "26.1" },
      ],
    });
  });

  it.each([
    ["Watch6,9", "Apple Watch Series 7 (GPS + Cellular, 45mm)"],
    ["fr955", "Forerunner 955"],
  ])(
    "resolves standalone hardware label %s while preserving its raw source name",
    (rawName, label) => {
      const result = activitySourceTreeWithHardware(
        { primary: node("activity-1", "wahoo"), otherSources: [] },
        {
          items: [
            item({
              providerId: "wahoo",
              role: "sensor",
              label: rawName,
              model: rawName,
              sourceName: "original-source-id",
              details: [],
            }),
          ],
          power: [],
        },
      );
      expect(result.primary?.children[0]).toMatchObject({
        sourceName: "original-source-id",
        label,
      });
      expect(result.primary?.children[0]?.details).toBeUndefined();
    },
  );

  it("resolves an existing Garmin source label and avoids repeating its model", () => {
    const garmin = { ...node("activity-1", "garmin"), sourceName: "fr955", label: "fr955" };
    const result = activitySourceTreeWithHardware(
      { primary: garmin, otherSources: [] },
      { items: [item({ providerId: "garmin", model: "fr955" })], power: [] },
    );
    expect(result.primary).toEqual({
      ...garmin,
      label: "Forerunner 955",
      details: [{ label: "Software", value: "26.1" }],
    });
    expect(garmin.label).toBe("fr955");
  });

  it("places recording facts on the existing Apple Watch attribution", () => {
    const watch = node("activity-1:recording-attribution", "apple-watch");
    const tree = { primary: node("activity-1", "apple_health", [watch]), otherSources: [] };
    const result = activitySourceTreeWithHardware(tree, { items: [item()], power: [] });
    expect(result.primary?.children).toEqual([
      { ...watch, details: [{ label: "Software", value: "26.1" }] },
    ]);
    expect(tree.primary.children).toEqual([watch]);
    expect(activitySourceTreeSchema.parse(result)).toEqual(result);
  });

  it("places recording facts directly on a Garmin device source", () => {
    const garmin = { ...node("activity-1", "garmin"), sourceName: "Edge 1040", label: "Edge 1040" };
    const result = activitySourceTreeWithHardware(
      { primary: garmin, otherSources: [] },
      {
        items: [item({ providerId: "garmin", label: "Edge 1040", model: "Edge 1040" })],
        power: [],
      },
    );
    expect(result.primary).toEqual({ ...garmin, details: [{ label: "Software", value: "26.1" }] });
  });

  it("preserves a specific model when hardware facts merge into a named watch", () => {
    const watch = {
      ...node("activity-1:recording-attribution", "apple-watch"),
      label: "Asher’s Apple Watch",
    };
    const result = activitySourceTreeWithHardware(
      { primary: node("activity-1", "apple_health", [watch]), otherSources: [] },
      {
        items: [
          item({
            label: "Apple Watch Ultra 3",
            model: "Apple Watch Ultra 3",
            manufacturer: "Apple",
          }),
        ],
        power: [],
      },
    );
    expect(result.primary?.children[0]?.details).toEqual([
      { label: "Model", value: "Apple Watch Ultra 3" },
      { label: "Software", value: "26.1" },
    ]);
  });

  it("retains a sensor manufacturer that its model label does not identify", () => {
    const result = activitySourceTreeWithHardware(
      { primary: node("activity-1", "wahoo"), otherSources: [] },
      {
        items: [
          item({
            role: "sensor",
            providerId: "wahoo",
            label: "Assioma DUO",
            model: "Assioma DUO",
            manufacturer: "Favero",
            details: [],
          }),
        ],
        power: [],
      },
    );
    expect(result.primary?.children[0]?.details).toEqual([
      { label: "Manufacturer", value: "Favero" },
    ]);
  });

  it("nests Peloton equipment under WHOOP while preserving other source branches", () => {
    const existing = node("other", "strava");
    const tree = { primary: node("activity-1", "whoop"), otherSources: [existing] };
    const result = activitySourceTreeWithHardware(tree, {
      items: [
        item({ providerId: "whoop", role: "category", label: "Peloton", model: null, details: [] }),
      ],
      power: [],
    });
    expect(result.primary?.children).toEqual([
      {
        id: "hardware-1",
        providerId: "peloton",
        sourceName: "Peloton",
        label: "Peloton",
        description: null,
        url: null,
        children: [],
      },
    ]);
    expect(result.otherSources).toEqual([existing]);
  });

  it("keeps specific models and observed-sensor qualifiers under their reporting source", () => {
    const result = activitySourceTreeWithHardware(
      { primary: node("activity-1", "wahoo"), otherSources: [] },
      {
        items: [
          item({
            role: "sensor",
            providerId: "wahoo",
            label: "Power meter",
            model: "Assioma DUO",
            details: [],
          }),
        ],
        power: [],
      },
    );
    expect(result.primary?.children[0]).toEqual({
      id: "hardware-1",
      providerId: "wahoo",
      sourceName: "Power meter",
      label: "Power meter",
      description: "Observed sensor",
      url: null,
      children: [],
      details: [{ label: "Model", value: "Assioma DUO" }],
    });
  });

  it("retains unmatched and hardware-only records as separate reporting source roots", () => {
    const hardware = {
      items: [
        item({
          activityId: "unmatched",
          role: "category",
          providerId: "whoop",
          label: "Peloton",
          model: null,
          details: [],
        }),
      ],
      power: [],
    };
    const result = activitySourceTreeWithHardware(
      { primary: node("existing", "garmin"), otherSources: [] },
      hardware,
    );
    expect(result.otherSources[0]).toMatchObject({
      id: "unmatched",
      providerId: "whoop",
      label: "WHOOP (Cloud)",
      children: [{ id: "hardware-1", label: "Peloton" }],
    });
    const onlyHardware = activitySourceTreeWithHardware(
      { primary: null, otherSources: [] },
      hardware,
    );
    expect(onlyHardware).toEqual({ primary: null, otherSources: result.otherSources });
    expect(activitySourceTreeWithHardware(result, hardware)).toEqual(result);
  });

  it("attaches power evidence to the corresponding provider record", () => {
    const result = activitySourceTreeWithHardware(
      { primary: node("activity-1", "wahoo"), otherSources: [] },
      {
        items: [],
        power: [
          { activityId: "activity-1", providerId: "wahoo", kind: "measured", label: "Power meter" },
          {
            activityId: "other",
            providerId: "strava",
            kind: "estimated",
            label: "Estimated power",
          },
        ],
      },
    );
    expect(result.primary?.details).toEqual([{ label: "Power", value: "Measured" }]);
    expect(result.otherSources[0]).toMatchObject({
      id: "other",
      providerId: "strava",
      details: [{ label: "Power", value: "Estimated" }],
    });
  });
});
