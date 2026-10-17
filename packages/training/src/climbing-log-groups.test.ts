import { describe, expect, it } from "vitest";
import { groupClimbingLogEntriesByArea } from "./climbing-log-groups.ts";

describe("groupClimbingLogEntriesByArea", () => {
  it("groups by the closest area identity in first-seen order while preserving original entry numbers", () => {
    const parent = { id: "parent", name: "Gym", providerId: "mountain-project" };
    const north = { id: "north", name: "Wall", providerId: "mountain-project" };
    const south = { id: "south", name: "Wall", providerId: "mountain-project" };
    const first = { id: "first", climb: { areaPath: [parent, north] } };
    const second = { id: "second", climb: { areaPath: [parent, south] } };
    const third = { id: "third", climb: { areaPath: [parent, north] } };

    const groups = groupClimbingLogEntriesByArea([first, second, third]);

    expect(groups).toEqual([
      {
        area: north,
        entries: [
          { entry: first, entryNumber: 1 },
          { entry: third, entryNumber: 3 },
        ],
      },
      { area: south, entries: [{ entry: second, entryNumber: 2 }] },
    ]);
    expect(groups[0]?.entries[0]?.entry.id).toBe("first");
  });

  it("retains repeated entries and entries with no recorded area in one unknown-area group", () => {
    const unknownClimb = { id: "unknown-climb", climb: null };
    const unknownArea = { id: "unknown-area", climb: { areaPath: [] } };
    const known = {
      id: "known",
      climb: { areaPath: [{ id: "area", name: "Crag", providerId: "openbeta" }] },
    };

    expect(groupClimbingLogEntriesByArea([unknownClimb, known, unknownArea, unknownClimb])).toEqual(
      [
        {
          area: null,
          entries: [
            { entry: unknownClimb, entryNumber: 1 },
            { entry: unknownArea, entryNumber: 3 },
            { entry: unknownClimb, entryNumber: 4 },
          ],
        },
        { area: known.climb.areaPath[0], entries: [{ entry: known, entryNumber: 2 }] },
      ],
    );
    expect(groupClimbingLogEntriesByArea([])).toEqual([]);
  });

  it("groups matching full area paths across sources while retaining every entry and its original number", () => {
    const mountainProjectPath = [
      { id: "mp-region", name: "Donner Summit", providerId: "mountain-project" },
      { id: "mp-crag", name: "Green Phantom Rock", providerId: "mountain-project" },
    ];
    const openBetaPath = [
      { id: "ob-region", name: "  donner   SUMMIT ", providerId: "openbeta" },
      { id: "ob-crag", name: "green phantom rock", providerId: "openbeta" },
    ];
    const first = { id: "road-kill", climb: { areaPath: mountainProjectPath } };
    const indoor = { id: "indoor", climb: null };
    const other = { id: "other-climb", climb: { areaPath: openBetaPath } };
    const repeat = { id: "repeat", climb: { areaPath: openBetaPath } };

    expect(groupClimbingLogEntriesByArea([first, indoor, other, repeat])).toEqual([
      {
        area: mountainProjectPath[1],
        entries: [
          { entry: first, entryNumber: 1 },
          { entry: other, entryNumber: 3 },
          { entry: repeat, entryNumber: 4 },
        ],
      },
      { area: null, entries: [{ entry: indoor, entryNumber: 2 }] },
    ]);
  });

  it("keeps identically named crags in different parent areas separate", () => {
    const first = {
      climb: {
        areaPath: [
          { id: "north", name: "North Canyon", providerId: "openbeta" },
          { id: "north-wall", name: "Wall", providerId: "openbeta" },
        ],
      },
    };
    const second = {
      climb: {
        areaPath: [
          { id: "south", name: "South Canyon", providerId: "mountain-project" },
          { id: "south-wall", name: "Wall", providerId: "mountain-project" },
        ],
      },
    };
    expect(groupClimbingLogEntriesByArea([first, second])).toEqual([
      { area: first.climb.areaPath[1], entries: [{ entry: first, entryNumber: 1 }] },
      { area: second.climb.areaPath[1], entries: [{ entry: second, entryNumber: 2 }] },
    ]);
  });

  it.each([
    ["north", "south", "overlap"],
    ["north", "overlap", "south"],
    ["overlap", "north", "south"],
  ])(
    "preserves ambiguous same-provider area identities regardless of source order (%s, %s, %s)",
    (...order) => {
      const entries = Object.fromEntries(
        ["north", "south", "overlap"].map((id) => [
          id,
          {
            id,
            climb: {
              areaPath: [
                {
                  id: `${id}-gym`,
                  name: "Gym",
                  providerId: id === "overlap" ? "openbeta" : "mountain-project",
                },
                {
                  id,
                  name: "Wall",
                  providerId: id === "overlap" ? "openbeta" : "mountain-project",
                },
              ],
            },
          },
        ]),
      );
      const ordered = order.map((id) => {
        const entry = entries[id];
        if (!entry) throw new Error("Expected an area fixture");
        return entry;
      });
      expect(groupClimbingLogEntriesByArea(ordered)).toEqual(
        ordered.map((entry, index) => ({
          area: entry.climb.areaPath[1],
          entries: [{ entry, entryNumber: index + 1 }],
        })),
      );
    },
  );
});
