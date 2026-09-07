import { describe, expect, it } from "vitest";
import { type ActivityGroupingInput, reconcileActivityGroups } from "./activity-grouping.ts";

const january1 = new Date("2026-01-01T00:00:00.000Z");
const january2 = new Date("2026-01-02T00:00:00.000Z");
const january3 = new Date("2026-01-03T00:00:00.000Z");

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [Array.from(values)];

  return values.flatMap((value, index) =>
    permutations(values.filter((_, candidateIndex) => candidateIndex !== index)).map(
      (remainder) => [value, ...remainder],
    ),
  );
}

describe("activity group reconciliation", () => {
  it("gives a new singleton its own group decision", () => {
    expect(
      reconcileActivityGroups({
        groups: [],
        members: [{ id: "activity-a", createdAt: january1, groupId: null }],
        overlaps: [],
      }),
    ).toEqual({
      aliases: [],
      components: [
        {
          memberIds: ["activity-a"],
          target: { anchorActivityId: "activity-a", kind: "new" },
        },
      ],
      memberships: [
        {
          activityId: "activity-a",
          target: { anchorActivityId: "activity-a", kind: "new" },
        },
      ],
    });
  });

  it("preserves an existing group when an overlapping member is added", () => {
    const result = reconcileActivityGroups({
      groups: [
        {
          id: "group-a",
          anchorActivityId: "activity-a",
          createdAt: january1,
        },
      ],
      members: [
        { id: "activity-a", createdAt: january1, groupId: "group-a" },
        { id: "activity-b", createdAt: january2, groupId: null },
      ],
      overlaps: [{ activityId: "activity-a", overlappingActivityId: "activity-b" }],
    });

    expect(result.components).toEqual([
      {
        memberIds: ["activity-a", "activity-b"],
        target: { groupId: "group-a", kind: "existing" },
      },
    ]);
  });

  it("retains the oldest group and aliases every loser when groups merge", () => {
    const result = reconcileActivityGroups({
      groups: [
        {
          id: "group-newer",
          anchorActivityId: "activity-b",
          createdAt: january2,
        },
        {
          id: "group-older",
          anchorActivityId: "activity-a",
          createdAt: january1,
        },
      ],
      members: [
        { id: "activity-a", createdAt: january1, groupId: "group-older" },
        { id: "activity-b", createdAt: january2, groupId: "group-newer" },
      ],
      overlaps: [{ activityId: "activity-a", overlappingActivityId: "activity-b" }],
    });

    expect(result.components[0]?.target).toEqual({
      groupId: "group-older",
      kind: "existing",
    });
    expect(result.aliases).toEqual([
      { aliasGroupId: "group-newer", groupId: "group-older", reason: "merged" },
    ]);
  });

  it("retains a split group's ID on the component containing its oldest member", () => {
    const result = reconcileActivityGroups({
      groups: [
        {
          id: "group-a",
          anchorActivityId: "activity-oldest",
          createdAt: january1,
        },
      ],
      members: [
        { id: "activity-later", createdAt: january2, groupId: "group-a" },
        { id: "activity-oldest", createdAt: january1, groupId: "group-a" },
      ],
      overlaps: [],
    });

    expect(result.components).toEqual([
      {
        memberIds: ["activity-later"],
        target: { anchorActivityId: "activity-later", kind: "new" },
      },
      {
        memberIds: ["activity-oldest"],
        target: { groupId: "group-a", kind: "existing" },
      },
    ]);
  });

  it("produces the same components and decisions for every input permutation", () => {
    const input: ActivityGroupingInput = {
      groups: [
        { id: "group-a", anchorActivityId: "activity-a", createdAt: january1 },
        { id: "group-b", anchorActivityId: "activity-b", createdAt: january2 },
      ],
      members: [
        { id: "activity-c", createdAt: january3, groupId: null },
        { id: "activity-b", createdAt: january2, groupId: "group-b" },
        { id: "activity-a", createdAt: january1, groupId: "group-a" },
      ],
      overlaps: [{ activityId: "activity-b", overlappingActivityId: "activity-a" }],
    };
    const expected = {
      aliases: [{ aliasGroupId: "group-b", groupId: "group-a", reason: "merged" }],
      components: [
        {
          memberIds: ["activity-a", "activity-b"],
          target: { groupId: "group-a", kind: "existing" },
        },
        {
          memberIds: ["activity-c"],
          target: { anchorActivityId: "activity-c", kind: "new" },
        },
      ],
      memberships: [
        { activityId: "activity-a", target: { groupId: "group-a", kind: "existing" } },
        { activityId: "activity-b", target: { groupId: "group-a", kind: "existing" } },
        {
          activityId: "activity-c",
          target: { anchorActivityId: "activity-c", kind: "new" },
        },
      ],
    };

    for (const groups of permutations(input.groups)) {
      for (const members of permutations(input.members)) {
        for (const overlaps of permutations(input.overlaps)) {
          expect(reconcileActivityGroups({ groups, members, overlaps })).toEqual(expected);
        }
      }
    }
  });

  it("uses member age and UUID to anchor a new multi-member component", () => {
    const olderResult = reconcileActivityGroups({
      groups: [],
      members: [
        { id: "activity-older", createdAt: january1, groupId: null },
        { id: "activity-newer", createdAt: january2, groupId: null },
      ],
      overlaps: [{ activityId: "activity-newer", overlappingActivityId: "activity-older" }],
    });
    const uuidResult = reconcileActivityGroups({
      groups: [],
      members: [
        { id: "activity-b", createdAt: january1, groupId: null },
        { id: "activity-a", createdAt: january1, groupId: null },
      ],
      overlaps: [{ activityId: "activity-b", overlappingActivityId: "activity-a" }],
    });

    expect(olderResult.components[0]).toEqual({
      memberIds: ["activity-newer", "activity-older"],
      target: { anchorActivityId: "activity-older", kind: "new" },
    });
    expect(uuidResult.components[0]?.target).toEqual({
      anchorActivityId: "activity-a",
      kind: "new",
    });
  });

  it("uses group UUID when merged groups have the same creation time", () => {
    const result = reconcileActivityGroups({
      groups: [
        { id: "group-b", anchorActivityId: "activity-b", createdAt: january1 },
        { id: "group-a", anchorActivityId: "activity-a", createdAt: january1 },
      ],
      members: [
        { id: "activity-a", createdAt: january1, groupId: "group-a" },
        { id: "activity-b", createdAt: january1, groupId: "group-b" },
      ],
      overlaps: [{ activityId: "activity-a", overlappingActivityId: "activity-b" }],
    });

    expect(result.components[0]?.target).toEqual({ groupId: "group-a", kind: "existing" });
  });

  it("builds transitive components and ignores overlap edges outside the input members", () => {
    const result = reconcileActivityGroups({
      groups: [],
      members: [
        { id: "activity-c", createdAt: january3, groupId: null },
        { id: "activity-a", createdAt: january1, groupId: null },
        { id: "activity-b", createdAt: january2, groupId: null },
      ],
      overlaps: [
        { activityId: "activity-a", overlappingActivityId: "activity-b" },
        { activityId: "activity-b", overlappingActivityId: "activity-c" },
        { activityId: "activity-c", overlappingActivityId: "activity-a" },
        { activityId: "missing-left", overlappingActivityId: "activity-a" },
        { activityId: "activity-c", overlappingActivityId: "missing-right" },
      ],
    });

    expect(result.components).toEqual([
      {
        memberIds: ["activity-a", "activity-b", "activity-c"],
        target: { anchorActivityId: "activity-a", kind: "new" },
      },
    ]);
  });

  it("orders aliases independently of component input order", () => {
    const result = reconcileActivityGroups({
      groups: [
        { id: "group-z", anchorActivityId: "activity-z", createdAt: january2 },
        { id: "group-c", anchorActivityId: "activity-c", createdAt: january1 },
        { id: "group-b", anchorActivityId: "activity-b", createdAt: january2 },
        { id: "group-a", anchorActivityId: "activity-a", createdAt: january1 },
      ],
      members: [
        { id: "activity-z", createdAt: january2, groupId: "group-z" },
        { id: "activity-c", createdAt: january1, groupId: "group-c" },
        { id: "activity-b", createdAt: january2, groupId: "group-b" },
        { id: "activity-a", createdAt: january1, groupId: "group-a" },
      ],
      overlaps: [
        { activityId: "activity-z", overlappingActivityId: "activity-c" },
        { activityId: "activity-b", overlappingActivityId: "activity-a" },
      ],
    });

    expect(result.aliases).toEqual([
      { aliasGroupId: "group-b", groupId: "group-a", reason: "merged" },
      { aliasGroupId: "group-z", groupId: "group-c", reason: "merged" },
    ]);
  });

  it("fails when an existing group anchor is missing from reconciliation input", () => {
    expect(() =>
      reconcileActivityGroups({
        groups: [{ id: "group-a", anchorActivityId: "missing-anchor", createdAt: january1 }],
        members: [{ id: "activity-a", createdAt: january1, groupId: "group-a" }],
        overlaps: [],
      }),
    ).toThrow("Activity group group-a has no anchor member missing-anchor");
  });
});
