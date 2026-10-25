import type { ActivityOrigin, ActivityOriginEvidence } from "@dofek/providers/activity-origin";
import { activitySourceTreeSchema } from "@dofek/providers/activity-source-tree";
import { describe, expect, it } from "vitest";
import type { SourceLink } from "./activity-source-attribution.ts";
import { buildActivitySourceTree } from "./activity-source-tree.ts";

const origin: ActivityOrigin = {
  status: "resolved",
  memberActivityId: "a",
  providerId: "wahoo",
  sourceName: null,
};
function link(id: string, providerId = "strava", subsource: string | null = null): SourceLink {
  return {
    memberActivityId: id,
    externalId: id,
    providerId,
    subsource,
    label: providerId,
    url: `https://example.com/${id}`,
  };
}
function edge(
  upstreamMemberActivityId: string,
  downstreamMemberActivityId: string,
): ActivityOriginEvidence {
  return {
    upstreamMemberActivityId,
    downstreamMemberActivityId,
    field: "external_id",
    value: "recorded-reference",
  };
}
describe("buildActivitySourceTree", () => {
  it("retains exact Garmin model metadata and canonical logo identity on a direct record", () => {
    const tree = buildActivitySourceTree(
      { ...origin, providerId: "garmin", sourceName: "Forerunner 965" },
      [link("a", "garmin", "Forerunner 965")],
      [],
    );
    expect(tree.primary).toMatchObject({
      id: "a",
      providerId: "garmin",
      sourceName: "Forerunner 965",
      label: "Forerunner 965",
      children: [],
    });
    expect(activitySourceTreeSchema.parse(tree)).toEqual(tree);
  });

  it("retains Garmin model thumbnails on held descendants without decorating Apple Health copies", () => {
    const tree = buildActivitySourceTree(
      origin,
      [
        link("a", "wahoo"),
        link("b", "garmin", "Forerunner 965"),
        link("c", "apple_health", "Garmin"),
      ],
      [edge("a", "b"), edge("b", "c")],
    );
    expect(tree.primary?.children[0]).toMatchObject({
      providerId: "garmin",
      sourceName: "Forerunner 965",
      children: [{ providerId: "apple_health", sourceName: null }],
    });
  });

  it("projects branches and retains separate same-provider copies with stable identities", () => {
    const links = [link("d"), link("c", "apple_health"), link("b"), link("a", "wahoo")];
    const tree = buildActivitySourceTree(origin, links, [
      edge("a", "c"),
      edge("a", "b"),
      edge("b", "d"),
    ]);
    expect(tree.primary).toMatchObject({
      id: "a",
      providerId: "wahoo",
      description: "Closest available recording",
      children: [
        { id: "c", description: "Imported from Wahoo", children: [] },
        {
          id: "b",
          description: "Imported from Wahoo",
          children: [{ id: "d", description: "Imported from Strava" }],
        },
      ],
    });
    expect(tree.otherSources).toEqual([]);
    expect(activitySourceTreeSchema.parse(tree)).toEqual(tree);
    expect(
      buildActivitySourceTree(origin, [...links].reverse(), [
        edge("b", "d"),
        edge("a", "b"),
        edge("a", "c"),
      ]),
    ).toEqual(tree);
  });
  it("keeps disconnected components as other matching sources instead of inferring membership edges", () => {
    const tree = buildActivitySourceTree(
      origin,
      [link("a", "wahoo"), link("b"), link("c", "apple_health"), link("d", "garmin")],
      [edge("b", "c")],
    );
    expect(tree.primary?.children).toEqual([]);
    expect(tree.otherSources).toMatchObject([
      { id: "d", description: "Other matching source" },
      { id: "b", children: [{ id: "c" }] },
    ]);
  });
  it("retains cyclic records without fabricating ancestry or a recording root", () => {
    const tree = buildActivitySourceTree(
      { status: "unresolved", candidateMemberActivityIds: ["a", "b"] },
      [link("a", "wahoo"), link("b")],
      [edge("a", "b"), edge("b", "a")],
    );
    expect(tree.primary).toBeNull();
    expect(tree.otherSources).toHaveLength(2);
    expect(tree.otherSources.every((node) => node.children.length === 0)).toBe(true);
  });
  it("does not present a cyclic resolved member as the recording root", () => {
    const tree = buildActivitySourceTree(
      origin,
      [link("a", "wahoo"), link("b")],
      [edge("a", "b"), edge("b", "a")],
    );
    expect(tree.primary).toBeNull();
    expect(tree.otherSources.map((node) => node.id)).toEqual(["b", "a"]);
  });

  it("uses Apple Health app metadata as attribution without joining another held copy", () => {
    const tree = buildActivitySourceTree(
      { ...origin, providerId: "apple_health", sourceName: "Hang Ten Training" },
      [link("a", "apple_health", "Hang Ten Training"), link("b", "hang-ten")],
      [],
    );
    expect(tree.primary).toMatchObject({
      providerId: "hang-ten",
      label: "Hang Ten",
      children: [{ id: "a", providerId: "apple_health", label: "Apple Health" }],
    });
    expect(tree.otherSources).toMatchObject([{ id: "b", providerId: "hang-ten", children: [] }]);
  });
  it("does not choose one of multiple asserted parents", () => {
    const tree = buildActivitySourceTree(
      origin,
      [link("a", "wahoo"), link("b"), link("c", "garmin")],
      [edge("a", "b"), edge("c", "b")],
    );
    expect(tree.primary?.children).toEqual([]);
    expect(tree.otherSources).toHaveLength(2);
  });
  it.each([
    origin,
    { status: "unresolved", candidateMemberActivityIds: ["a", "b", "c"] } satisfies ActivityOrigin,
  ])(
    "retains records without ancestry when an ambiguous parent also participates in a cycle ($status)",
    (recordingOrigin) => {
      const tree = buildActivitySourceTree(
        recordingOrigin,
        [link("a", "wahoo"), link("b"), link("c", "garmin")],
        [edge("a", "b"), edge("b", "a"), edge("c", "b")],
      );
      expect(tree.primary).toBeNull();
      expect(tree.otherSources.map((node) => ({ id: node.id, children: node.children }))).toEqual([
        { id: "c", children: [] },
        { id: "b", children: [] },
        { id: "a", children: [] },
      ]);
    },
  );
  it("does not promote a cyclic ancestor of a resolved downstream member", () => {
    const tree = buildActivitySourceTree(
      { ...origin, memberActivityId: "d", providerId: "strava" },
      [link("a", "wahoo"), link("b"), link("c", "garmin"), link("d")],
      [edge("a", "b"), edge("b", "a"), edge("c", "b"), edge("b", "d")],
    );
    expect(tree.primary).toBeNull();
    expect(tree.otherSources).toMatchObject([
      { id: "c", children: [] },
      { id: "b", children: [{ id: "d", children: [] }] },
      { id: "a", children: [] },
    ]);
  });
  it("shows missing device attribution above a held Strava record without linking another Garmin copy", () => {
    const tree = buildActivitySourceTree(
      { ...origin, providerId: "strava", sourceName: "Garmin Edge 530" },
      [link("a", "strava", "Garmin Edge 530"), link("b", "garmin")],
      [],
    );
    expect(tree.primary).toMatchObject({
      providerId: "garmin",
      sourceName: "Garmin Edge 530",
      label: "Garmin Edge 530",
      url: null,
      description: "Recording app or device attribution",
      children: [
        { id: "a", label: "Strava", description: "Recording attribution reported by Strava" },
      ],
    });
    expect(tree.otherSources).toMatchObject([{ id: "b", providerId: "garmin" }]);
  });
  it("retains tombstoned records and ignores references to unavailable member records", () => {
    const tree = buildActivitySourceTree(
      origin,
      [link("a", "wahoo"), { ...link("b"), providerAbsentAt: "2026-10-02T00:00:00Z" }],
      [edge("a", "b"), edge("missing", "a")],
    );
    expect(tree.primary?.children[0]).toMatchObject({
      id: "b",
      description: "Imported from Wahoo · Removed from provider",
      url: "https://example.com/b",
    });
  });
});
