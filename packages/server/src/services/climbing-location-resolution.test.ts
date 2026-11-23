import type { Area } from "@dofek/training/climbing-log";
import { groupClimbingLogEntriesByArea } from "@dofek/training/climbing-log-groups";
import { describe, expect, it } from "vitest";
import {
  climbingClimbFixture,
  climbingLogEntryFixture,
} from "../repositories/climbing-test-helpers.ts";
import { climbingSourceSession, resolveClimbingLocations } from "./climbing-location-resolution.ts";

function indoorLog(number: number, providerId: string, name: string | null, latitude = 37.81644) {
  const id = `30000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
  const log = climbingLogEntryFixture({ id, providerId });
  const areaPath: Area[] = name
    ? [
        {
          id,
          userId: log.userId,
          providerId,
          externalId: `gym-${number}`,
          name,
          parentAreaId: null,
          coordinates: { latitude, longitude: -122.28852 },
        },
      ]
    : [];
  return {
    ...log,
    areaPath,
    climb: { ...climbingClimbFixture(providerId), setting: "indoor" as const, areaPath },
  };
}

const kayaWall = ["Berkeley", "Indian Rock", "Picnic Table Wall"];
const mountainProjectWall = [
  "California",
  "San Francisco Bay Area",
  "East Bay Area",
  "Berkeley",
  "Indian Rock Park",
  "Picnic Table Wall",
];

function outdoorLog(
  id: string,
  providerId: string,
  names: string[],
  coordinates: Area["coordinates"] = null,
) {
  const log = climbingLogEntryFixture({ id, providerId });
  const areaPath = names.map((name, index) => ({
    id: `${providerId}:${names.slice(0, index + 1).join("/")}`,
    userId: log.userId,
    providerId,
    externalId: null,
    name,
    parentAreaId: null,
    coordinates: index === names.length - 1 ? coordinates : null,
  }));
  return {
    ...log,
    climb: {
      ...climbingClimbFixture(providerId),
      kind: "boulder" as const,
      setting: providerId === "kaya" ? ("outdoor" as const) : null,
      areaPath,
    },
  };
}

describe("resolveClimbingLocations", () => {
  it("groups all five Picnic Table Wall entries and keeps the neighboring Ape separate", () => {
    const logs = [
      outdoorLog("Picnic Traverse", "kaya", kayaWall),
      outdoorLog("Ape Overhang", "kaya", ["Berkeley", "Indian Rock", "Ape"]),
      outdoorLog("The Roof", "mountain-project", mountainProjectWall),
      outdoorLog("Overhang Variations", "kaya", kayaWall),
      outdoorLog("Face Variations", "kaya", kayaWall),
      outdoorLog("Left Route", "mountain-project", mountainProjectWall),
    ];
    const resolved = resolveClimbingLocations(logs);
    const groups = groupClimbingLogEntriesByArea(resolved);
    expect(
      groups.map((group) => [group.area?.name, group.entries.map((item) => item.entryNumber)]),
    ).toEqual([
      ["Picnic Table Wall", [1, 3, 4, 5, 6]],
      ["Ape", [2]],
    ]);
    expect(resolved.map((log) => log.climb.areaPath)).toEqual(
      logs.map((log) => log.climb.areaPath),
    );
    expect(resolveClimbingLocations(logs.toReversed()).map((log) => log.areaGroupId)).toEqual(
      resolved.map((log) => log.areaGroupId).reverse(),
    );
  });

  it.each([
    [["Berkeley", "Mortar Rock", "Picnic Table Wall"], null],
    [["Berkeley Park", "Indian Rock Park", "Picnic Table Wall"], null],
    [["Indian Rock Park", "Picnic Table Wall"], null],
    [mountainProjectWall, { latitude: 38, longitude: -122.27231 }],
    [kayaWall, { latitude: 38, longitude: -122.27231 }],
  ] as const)(
    "keeps a conflicting or insufficient outdoor path separate: %j %j",
    (path, coordinates) => {
      const first = outdoorLog("first", "kaya", kayaWall, {
        latitude: 37.89226,
        longitude: -122.27231,
      });
      const second = outdoorLog("second", "mountain-project", [...path], coordinates);
      expect(groupClimbingLogEntriesByArea(resolveClimbingLocations([first, second]))).toHaveLength(
        2,
      );
    },
  );

  it("accepts nearby outdoor wall pins with one matching parent", () => {
    const first = outdoorLog("first", "kaya", kayaWall, {
      latitude: 37.89226,
      longitude: -122.27231,
    });
    const second = outdoorLog(
      "second",
      "mountain-project",
      ["Indian Rock Park", "Picnic Table Wall"],
      {
        latitude: 37.89228,
        longitude: -122.27231,
      },
    );
    expect(groupClimbingLogEntriesByArea(resolveClimbingLocations([first, second]))).toHaveLength(
      1,
    );
  });

  it("rejects competing outdoor matches from the same source", () => {
    const logs = [
      outdoorLog("first", "kaya", kayaWall),
      outdoorLog("second", "mountain-project", mountainProjectWall),
      outdoorLog("third", "mountain-project", ["Another region", ...mountainProjectWall]),
    ];
    expect(groupClimbingLogEntriesByArea(resolveClimbingLocations(logs))).toHaveLength(3);
  });

  it("keeps identical walls in different neighboring gym ancestries separate in either order", () => {
    const first = indoorLog(1, "first", "Main Wall");
    const second = indoorLog(2, "second", "Main Wall", 37.8165);
    const firstLeaf = first.areaPath[0];
    const secondLeaf = second.areaPath[0];
    if (!firstLeaf || !secondLeaf) throw new Error("Expected wall fixtures");
    first.areaPath = [{ ...firstLeaf, id: "north", name: "North Gym" }, firstLeaf];
    second.areaPath = [{ ...secondLeaf, id: "south", name: "South Gym" }, secondLeaf];
    for (const logs of [
      [first, second],
      [second, first],
    ]) {
      expect(groupClimbingLogEntriesByArea(resolveClimbingLocations(logs))).toHaveLength(2);
    }
    const unknown = { ...indoorLog(3, "first", null), raw: { sessionId: "session" } };
    const conflicting = resolveClimbingLocations([
      { ...first, raw: { sessionId: "session" } },
      {
        ...second,
        providerId: "first",
        climb: { ...second.climb, providerId: "first" },
        areaPath: second.areaPath.map((area) => ({ ...area, providerId: "first" })),
        raw: { sessionId: "session" },
      },
      unknown,
    ]);
    expect(conflicting[2]?.areaPath).toEqual([]);
    second.areaPath = [
      { ...secondLeaf, id: "north-other", name: "North Climbing Gym" },
      secondLeaf,
    ];
    expect(groupClimbingLogEntriesByArea(resolveClimbingLocations([first, second]))).toHaveLength(
      1,
    );
  });

  it.each([true, false])(
    "preserves a native climb location when a session peer has coordinates: %s",
    (hasCoordinates) => {
      const known = { ...indoorLog(1, "boardsesh", "Pacific Pipe"), raw: { sessionId: "session" } };
      const area = known.areaPath[0];
      if (!area) throw new Error("Expected gym fixture");
      if (!hasCoordinates) area.coordinates = null;
      const native = {
        ...indoorLog(2, "boardsesh", null),
        raw: { sessionId: "session" },
        mapLocation: {
          coordinates: { latitude: 38, longitude: -122 },
          scope: "climb" as const,
          objectId: "native-climb",
          providerId: "boardsesh",
          name: "Recorded climb",
        },
      };
      const unknown = { ...indoorLog(3, "boardsesh", null), raw: { sessionId: "session" } };
      const resolved = resolveClimbingLocations([known, native, unknown]);
      expect(resolved[1]?.mapLocation).toEqual(native.mapLocation);
      expect(resolved[1]?.areaPath).toEqual([]);
      expect(resolved[2]?.areaPath).toEqual([]);
    },
  );
  it.each([
    [{ sessionId: "source" }, "source"],
    [{ session_id: "source" }, "source"],
    [{ sessionId: null, session_id: "source" }, "source"],
    [{ sessionId: " source ", session_id: "source" }, "source"],
    [{ sessionId: "source", session_id: "other" }, null],
    [{ sessionId: 1 }, null],
    [{}, null],
    [null, null],
  ])("reads only a consistent source session from %j", (raw, expected) => {
    expect(climbingSourceSession({ raw })).toBe(expected);
  });

  it("respects the distance boundary without changing outdoor proximity policy", () => {
    const origin = indoorLog(1, "first", "Pacific Pipe", 0);
    const inside = indoorLog(2, "second", "Pacific Pipe", (199 / 6_371_000) * (180 / Math.PI));
    const outside = indoorLog(2, "second", "Pacific Pipe", (201 / 6_371_000) * (180 / Math.PI));
    expect(groupClimbingLogEntriesByArea(resolveClimbingLocations([origin, inside]))).toHaveLength(
      1,
    );
    expect(groupClimbingLogEntriesByArea(resolveClimbingLocations([origin, outside]))).toHaveLength(
      2,
    );
  });
  it("groups Pacific Pipe using independent gym names and recorded map pins", () => {
    const kaya = indoorLog(1, "kaya", "Touchstone Pacific Pipe", 37.815355);
    const board = indoorLog(2, "boardsesh", "Pacific Pipe Climbing");
    const original = structuredClone([kaya, board]);
    const resolved = resolveClimbingLocations([kaya, board]);
    expect(groupClimbingLogEntriesByArea(resolved)).toHaveLength(1);
    expect(resolved.map((log) => log.areaPath)).toEqual(original.map((log) => log.areaPath));
    expect([kaya, board]).toEqual(original);
    expect(resolveClimbingLocations([board, kaya]).map((log) => log.areaGroupId)).toEqual(
      resolved.map((log) => log.areaGroupId).reverse(),
    );
  });

  it("uses known gym context when another log at that source area has no setting", () => {
    const kaya = indoorLog(1, "kaya", "Touchstone Pacific Pipe");
    const board = indoorLog(2, "boardsesh", "Pacific Pipe Climbing");
    const unknownSetting = {
      ...kaya,
      id: "unknown-setting",
      climb: { ...kaya.climb, setting: null },
    };
    const logs = [kaya, board, unknownSetting];
    for (const order of [logs, logs.toReversed()]) {
      expect(groupClimbingLogEntriesByArea(resolveClimbingLocations(order))).toHaveLength(1);
    }
  });

  it("keeps an area with conflicting recorded settings separate from other providers", () => {
    const kaya = indoorLog(1, "kaya", "Touchstone Pacific Pipe");
    const board = indoorLog(2, "boardsesh", "Pacific Pipe Climbing");
    const outdoor = {
      ...kaya,
      id: "outdoor",
      climb: { ...kaya.climb, setting: "outdoor" as const },
    };
    const logs = [kaya, board, outdoor];
    for (const order of [logs, logs.toReversed()]) {
      expect(groupClimbingLogEntriesByArea(resolveClimbingLocations(order))).toHaveLength(2);
    }
  });

  it.each([
    ["Movement Granite Valley", "Granite Valley Climbing", 37.8165],
    ["The Front", "Front Climbing Club", 37.8165],
    ["Café Boulder", "CAFÉ Boulder Gym", 37.8165],
  ])("matches unfamiliar gym variants %s and %s", (first, second, latitude) => {
    expect(
      groupClimbingLogEntriesByArea(
        resolveClimbingLocations([
          indoorLog(1, "first", first),
          indoorLog(2, "second", second, latitude),
        ]),
      ),
    ).toHaveLength(1);
  });

  it.each([
    ["Movement Sunnyvale", "Movement San Francisco", 37.8165],
    ["North Rock Gym", "South Rock Gym", 37.8165],
    ["Pacific Pipe", "Pacific Pipe", 38],
    ["Climbing Gym", "Climbing Gym", 37.8165],
  ])("keeps conflicting gyms %s and %s separate", (first, second, latitude) => {
    expect(
      groupClimbingLogEntriesByArea(
        resolveClimbingLocations([
          indoorLog(1, "first", first),
          indoorLog(2, "second", second, latitude),
        ]),
      ),
    ).toHaveLength(2);
  });

  it("does not match without coordinates or use a parent pin for a leaf gym", () => {
    const first = indoorLog(1, "first", "Pacific Pipe");
    const second = indoorLog(2, "second", "Pacific Pipe");
    const leaf = second.areaPath[0];
    if (!leaf) throw new Error("Expected area fixture");
    second.areaPath = [
      { ...leaf, id: "parent" },
      { ...leaf, coordinates: null },
    ];
    expect(groupClimbingLogEntriesByArea(resolveClimbingLocations([first, second]))).toHaveLength(
      2,
    );
  });

  it("keeps outdoor locations out of gym resolution", () => {
    const first = indoorLog(1, "first", "Pacific Pipe");
    const second = indoorLog(2, "second", "Pipe Climbing");
    const resolved = resolveClimbingLocations([
      { ...first, climb: { ...first.climb, setting: "outdoor" as const } },
      { ...second, climb: { ...second.climb, setting: "outdoor" as const } },
    ]);
    expect(groupClimbingLogEntriesByArea(resolved)).toHaveLength(2);
  });

  it("rejects two possible gym identities from the same provider", () => {
    const resolved = resolveClimbingLocations([
      indoorLog(1, "first", "Pacific Pipe"),
      indoorLog(2, "second", "Pacific Pipe"),
      indoorLog(3, "second", "Pacific Pipe", 37.8165),
    ]);
    expect(groupClimbingLogEntriesByArea(resolved)).toHaveLength(3);
  });

  it("does not bridge a chain whose ends are too far apart", () => {
    const resolved = resolveClimbingLocations([
      indoorLog(1, "first", "Pacific Pipe", 37.816),
      indoorLog(2, "second", "Pacific Pipe", 37.8175),
      indoorLog(3, "third", "Pacific Pipe", 37.819),
    ]);
    expect(groupClimbingLogEntriesByArea(resolved)).toHaveLength(3);
  });

  it("fills missing session locations without changing the raw log or recorded board", () => {
    const known = { ...indoorLog(1, "boardsesh", "Pacific Pipe"), raw: { sessionId: "session" } };
    const unknown = {
      ...indoorLog(2, "boardsesh", null),
      raw: { sessionId: "session", boardId: null },
    };
    const resolved = resolveClimbingLocations([known, unknown]);
    expect(groupClimbingLogEntriesByArea(resolved)).toHaveLength(1);
    expect(resolved[1]).toMatchObject({
      areaPath: known.areaPath,
      raw: unknown.raw,
      board: null,
      mapLocation: { objectId: known.id, providerId: "boardsesh", scope: "area" },
    });
    expect(unknown.areaPath).toEqual([]);
  });

  it.each([
    "different-session",
    "different-provider",
    "different-owner",
    "absent",
    "invalid-session",
    "conflicting-session-fields",
  ])("does not borrow location from %s evidence", (reason) => {
    const known = { ...indoorLog(1, "boardsesh", "Pacific Pipe"), raw: { sessionId: "session" } };
    const unknown = {
      ...indoorLog(2, reason === "different-provider" ? "kilter" : "boardsesh", null),
      raw:
        reason === "invalid-session"
          ? { sessionId: " " }
          : reason === "conflicting-session-fields"
            ? { sessionId: "session", session_id: "other" }
            : { sessionId: reason === "different-session" ? "other" : "session" },
      userId: reason === "different-owner" ? "other-owner" : known.userId,
    };
    const peer = {
      ...known,
      providerAbsentAt: reason === "absent" ? "2026-11-13T00:00:00Z" : null,
    };
    expect(resolveClimbingLocations([peer, unknown])[1]?.areaPath).toEqual([]);
  });

  it("leaves multi-gym sessions unknown and responds to changed source locations", () => {
    const first = { ...indoorLog(1, "boardsesh", "Pacific Pipe"), raw: { sessionId: "session" } };
    const second = {
      ...indoorLog(2, "boardsesh", "Another gym", 38),
      raw: { sessionId: "session" },
    };
    const unknown = { ...indoorLog(3, "boardsesh", null), raw: { sessionId: "session" } };
    expect(resolveClimbingLocations([first, unknown])[1]?.areaPath).toEqual(first.areaPath);
    expect(resolveClimbingLocations([first, second, unknown])[2]?.areaPath).toEqual([]);
  });

  it("keeps owners isolated during gym matching too", () => {
    const first = indoorLog(1, "first", "Pacific Pipe");
    const second = { ...indoorLog(2, "second", "Pacific Pipe"), userId: "other-owner" };
    expect(resolveClimbingLocations([first, second]).map((log) => log.areaGroupId)).toEqual([
      first.id,
      second.id,
    ]);
  });
});
