import { describe, expect, it } from "vitest";
import {
  type ActivitySourceTree,
  type ActivitySourceTreeNode,
  activityMetricSourceInheritance,
  activitySourceNodePresentation,
} from "./activity-source-tree.ts";

describe("activitySourceNodePresentation", () => {
  it.each([
    ["whoop", "WHOOP (Cloud)", "WHOOP", "cloud"],
    ["whoop_ble", "WHOOP (Bluetooth)", "WHOOP", "bluetooth"],
    ["whoop", "WHOOP 4.0", "WHOOP 4.0", null],
    ["apple_health", "Apple Health", "Apple Health", null],
  ])("presents %s source %s", (providerId, label, displayName, kind) => {
    const presentation = activitySourceNodePresentation({
      id: "record",
      providerId,
      label,
      sourceName: "Apple Watch",
      description: null,
      url: null,
      children: [],
    });
    expect(presentation.displayName).toBe(displayName);
    expect(presentation.attribution?.kind ?? null).toBe(kind);
  });
});

describe("activityMetricSourceInheritance", () => {
  const node = (
    id: string,
    providerId: string,
    children: ActivitySourceTreeNode[] = [],
  ): ActivitySourceTreeNode => ({
    id,
    providerId,
    sourceName: null,
    label: providerId === "whoop" ? "WHOOP (Cloud)" : providerId,
    description: null,
    url: null,
    children,
  });
  const tree: ActivitySourceTree = {
    primary: node("origin", "whoop", [
      node("copy", "peloton", [node("health-copy", "apple_health")]),
    ]),
    otherSources: [node("unrelated", "garmin")],
  };
  it("retains every delivery step in a multi-hop accessible label", () => {
    expect(activityMetricSourceInheritance(tree, ["health-copy"], "apple_health")).toEqual({
      label: "WHOOP via Peloton → Apple Health",
      presentation: {
        displayName: "WHOOP",
        providerId: "whoop",
        sourceName: null,
        attribution: { kind: "apple_health", label: "Apple Health" },
      },
    });
  });
  it.each(["unresolved", "kaya"])(
    "uses the proven WHOOP branch with a %s activity origin",
    (origin) => {
      expect(
        activityMetricSourceInheritance(
          {
            primary: origin === "kaya" ? node("unrelated", "kaya") : null,
            otherSources: [
              ...(origin === "kaya" ? [] : [node("unrelated", "kaya")]),
              node("origin", "whoop", [node("copy", "peloton")]),
            ],
          },
          ["copy"],
          "peloton",
        )?.label,
      ).toBe("WHOOP via Peloton");
    },
  );
  it("retains a model-specific recording label supplied by the canonical tree", () => {
    const watch = {
      ...node("watch-origin", "apple-watch", [node("health-copy", "apple_health")]),
      label: "Apple Watch Series 7 (GPS + Cellular, 45mm)",
    };
    const result = activityMetricSourceInheritance(
      { primary: watch, otherSources: [] },
      ["health-copy"],
      "apple_health",
    );
    expect(result?.label).toBe("Apple Watch Series 7 (GPS + Cellular, 45mm) via Apple Health");
    expect(result?.presentation.displayName).toBe("Apple Watch Series 7 (GPS + Cellular, 45mm)");
  });
  it.each([
    ["origin"],
    ["missing"],
    ["copy", "unrelated"],
    ["copy", "missing"],
    ["copy", "health-copy"],
    [],
  ])("leaves unresolved or mixed paths to the existing presentation: %j", (...ids) => {
    expect(activityMetricSourceInheritance(tree, ids, "peloton")).toBeNull();
  });
  it("does not confuse a same-provider held copy with a different upstream provider", () => {
    expect(
      activityMetricSourceInheritance(
        { primary: node("one", "whoop", [node("two", "whoop")]), otherSources: [] },
        ["two"],
        "whoop",
      ),
    ).toBeNull();
  });
  it("projects shared ancestry for distinct copies delivered by the same provider", () => {
    const copies = {
      primary: node("origin", "whoop", [node("one", "peloton"), node("two", "peloton")]),
      otherSources: [],
    };
    expect(activityMetricSourceInheritance(copies, ["one", "two"], "peloton")?.label).toBe(
      "WHOOP via Peloton",
    );
    expect(activityMetricSourceInheritance(copies, ["one", ""], "peloton")).toBeNull();
  });
  it("keeps different recording origins separate even when delivery providers match", () => {
    const distinct = {
      primary: node("whoop-origin", "whoop", [node("one", "peloton")]),
      otherSources: [node("garmin-origin", "garmin", [node("two", "peloton")])],
    };
    expect(activityMetricSourceInheritance(distinct, ["one", "two"], "peloton")).toBeNull();
  });
  it("does not assign another provider's delivery badge to a recording", () => {
    expect(activityMetricSourceInheritance(tree, ["copy"], "strava")).toBeNull();
  });
  it.each([
    ["apple_health", "apple-health"],
    ["apple-health", "apple_health"],
  ])("treats %s and %s as the same delivery identity", (originProvider, deliveryProvider) => {
    expect(
      activityMetricSourceInheritance(
        {
          primary: node("origin", originProvider, [node("copy", deliveryProvider)]),
          otherSources: [],
        },
        ["copy"],
        deliveryProvider,
      ),
    ).toBeNull();
  });
});
