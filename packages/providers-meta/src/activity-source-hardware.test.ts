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
    id: "device",
    activityId: "peloton",
    providerId: "peloton",
    sourceName: null,
    role: "category",
    label: "Peloton Bike+",
    model: null,
    manufacturer: null,
    evidence: "Reported equipment",
    details: [{ label: "Platform", value: "Peloton Bike" }],
    ...overrides,
  };
}
describe("activitySourceTreeWithHardware", () => {
  it("names the Peloton original while preserving its explicit Strava sharing branch", () => {
    const strava = node("strava", "strava");
    const tree = { primary: node("peloton", "peloton", [strava]), otherSources: [] };
    const result = activitySourceTreeWithHardware(tree, {
      items: [
        item(),
        item({
          id: "strava-device",
          activityId: "strava",
          providerId: "strava",
          role: "recorder",
          label: "Peloton Bike",
        }),
      ],
      power: [],
    });
    expect(result.primary).toEqual({
      ...tree.primary,
      label: "Peloton Bike+",
      sourceName: "Peloton Bike+",
    });
    expect(result.primary?.children).toEqual([strava]);
    expect(tree.primary.label).toBe("peloton");
    expect(activitySourceTreeSchema.parse(result)).toEqual(result);
  });
  it("names a Garmin recording using its reported device", () => {
    const root = node("garmin", "garmin");
    const result = activitySourceTreeWithHardware(
      { primary: root, otherSources: [] },
      {
        items: [
          item({ activityId: "garmin", providerId: "garmin", role: "recorder", label: "Edge 530" }),
        ],
        power: [],
      },
    );
    expect(result.primary).toEqual({ ...root, label: "Edge 530", sourceName: "Edge 530" });
  });
  it("preserves a recognized recording attribution and its Apple Health copy", () => {
    const health = node("health", "apple_health");
    const watch = {
      ...node("health:recording-attribution", "apple-watch", [health]),
      label: "Apple Watch Series 7",
    };
    const result = activitySourceTreeWithHardware(
      { primary: watch, otherSources: [] },
      {
        items: [
          item({
            activityId: "health",
            providerId: "apple_health",
            role: "recorder",
            label: "Apple Watch",
          }),
        ],
        power: [],
      },
    );
    expect(result.primary).toEqual(watch);
  });
  it("keeps unmatched reporting records as unresolved roots", () => {
    const result = activitySourceTreeWithHardware(
      { primary: null, otherSources: [] },
      {
        items: [
          item({ activityId: "whoop", providerId: "whoop", role: "category", label: "Peloton" }),
        ],
        power: [],
      },
    );
    expect(result).toEqual({
      primary: null,
      otherSources: [{ ...node("whoop", "whoop"), label: "WHOOP (Cloud)" }],
    });
  });
  it("preserves the reporting tree when hardware contains sensor inventory", () => {
    const root = node("wahoo", "wahoo");
    const result = activitySourceTreeWithHardware(
      { primary: root, otherSources: [] },
      {
        items: [
          item({
            activityId: "wahoo",
            providerId: "wahoo",
            role: "sensor",
            label: "Heart rate strap",
          }),
        ],
        power: [],
      },
    );
    expect(result.primary).toEqual(root);
  });
  it("preserves readable device labels and is stable when projected twice", () => {
    const tree = {
      primary: { ...node("garmin", "garmin"), label: "fr955", sourceName: "fr955" },
      otherSources: [],
    };
    const hardware = {
      items: [
        item({
          activityId: "garmin",
          providerId: "garmin",
          role: "recorder",
          label: "Forerunner 955",
        }),
      ],
      power: [],
    };
    const result = activitySourceTreeWithHardware(tree, hardware);
    expect(result.primary?.label).toBe("Forerunner 955");
    expect(activitySourceTreeWithHardware(result, hardware)).toEqual(result);
  });
  it("enriches existing additional recordings and unmatched Garmin records", () => {
    const secondary = node("secondary", "garmin");
    const result = activitySourceTreeWithHardware(
      { primary: node("original", "whoop"), otherSources: [secondary] },
      {
        items: [
          item({
            activityId: "secondary",
            providerId: "garmin",
            role: "recorder",
            label: "Edge 530",
          }),
          item({
            activityId: "unmatched",
            providerId: "garmin",
            role: "recorder",
            label: "Edge 840",
          }),
        ],
        power: [],
      },
    );
    expect(result.otherSources).toEqual([
      { ...secondary, label: "Edge 530", sourceName: "Edge 530" },
      { ...node("unmatched", "garmin"), label: "Edge 840", sourceName: "Edge 840" },
    ]);
  });
  it("preserves a specific recording identity instead of replacing it with another hardware label", () => {
    const original = {
      ...node("garmin", "garmin"),
      label: "Garmin Edge 530",
      sourceName: "edge530",
    };
    const result = activitySourceTreeWithHardware(
      { primary: original, otherSources: [] },
      {
        items: [
          item({ activityId: "garmin", providerId: "garmin", role: "recorder", label: "Edge 840" }),
        ],
        power: [],
      },
    );
    expect(result.primary).toEqual(original);
  });
  it.each([
    { label: "Garmin Connect", sourceName: null },
    { label: "garmin", sourceName: "recorded-source" },
    { label: "Garmin", sourceName: "recorded-source" },
  ])(
    "enriches a generic recording label $label while retaining reported source identity",
    ({ label, sourceName }) => {
      const original = { ...node("garmin", "garmin"), label, sourceName };
      const result = activitySourceTreeWithHardware(
        { primary: original, otherSources: [] },
        {
          items: [
            item({
              activityId: "garmin",
              providerId: "garmin",
              role: "recorder",
              label: "Edge 840",
              sourceName: "reported-device-identity",
            }),
          ],
          power: [],
        },
      );
      expect(result.primary).toEqual({
        ...original,
        label: "Edge 840",
        sourceName: "reported-device-identity",
      });
    },
  );
  it("preserves a downstream Garmin copy instead of naming it as the original device", () => {
    const copy = node("garmin", "garmin");
    const original = node("original", "wahoo", [copy]);
    const result = activitySourceTreeWithHardware(
      { primary: original, otherSources: [] },
      {
        items: [
          item({ activityId: "garmin", providerId: "garmin", role: "recorder", label: "Edge 530" }),
        ],
        power: [],
      },
    );
    expect(result.primary).toEqual(original);
  });
  it.each([
    { providerId: "garmin", role: "sensor" as const, label: "HRM-Pro" },
    { providerId: "wahoo", role: "recorder" as const, label: "ELEMNT" },
    { providerId: "wahoo", role: "category" as const, label: "Peloton Bike" },
    { providerId: "peloton", role: "recorder" as const, label: "Peloton Bike" },
    { providerId: "peloton", role: "category" as const, label: "Peloton Tread" },
    { providerId: "peloton", role: "category" as const, label: "Other Peloton Bike" },
  ])(
    "preserves the reporting root for $providerId $role $label metadata",
    ({ providerId, role, label }) => {
      const original = node("original", providerId);
      const result = activitySourceTreeWithHardware(
        { primary: original, otherSources: [] },
        {
          items: [item({ activityId: "original", providerId, role, label })],
          power: [],
        },
      );
      expect(result.primary).toEqual(original);
    },
  );
  it("consolidates multiple hardware observations for an unmatched reporting record", () => {
    const result = activitySourceTreeWithHardware(
      { primary: null, otherSources: [] },
      {
        items: [
          item({ activityId: "unmatched", providerId: "garmin", role: "sensor", label: "HRM-Pro" }),
          item({
            activityId: "unmatched",
            providerId: "garmin",
            role: "recorder",
            label: "Edge 530",
          }),
        ],
        power: [],
      },
    );
    expect(result.otherSources).toEqual([
      { ...node("unmatched", "garmin"), label: "Edge 530", sourceName: "Edge 530" },
    ]);
  });
});
