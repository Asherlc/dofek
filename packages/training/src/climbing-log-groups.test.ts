import { describe, expect, it } from "vitest";
import { groupClimbingLogEntriesByArea } from "./climbing-log-groups.ts";

describe("groupClimbingLogEntriesByArea", () => {
  it("groups by the closest area identity in first-seen order while preserving original entry numbers", () => {
    const parent = { id: "parent", name: "Gym" };
    const north = { id: "north", name: "Wall" };
    const south = { id: "south", name: "Wall" };
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
    const known = { id: "known", climb: { areaPath: [{ id: "area", name: "Crag" }] } };

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
});
