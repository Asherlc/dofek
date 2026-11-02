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
  it("keeps an observed sensor attached to its reporting identity without inventing sharing steps", () => {
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
});
