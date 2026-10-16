import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { getActivityMapReadiness, getActivityRoutePreviews } from "./activity-route-preview.ts";

describe("getActivityMapReadiness", () => {
  it("keeps each record, canonical route, and member associated in the user-scoped request", async () => {
    let capturedParams: Record<string, unknown> | undefined;
    const sensorStore = {
      query: async <TSchema extends z.ZodType>(
        schema: TSchema,
        _query: string,
        params?: Record<string, unknown>,
      ): Promise<z.infer<TSchema>[]> => {
        capturedParams = params;
        return [
          { activity_id: "record-a", status: "processing" },
          { activity_id: "record-b", status: "awaiting_summary" },
          { activity_id: "record-c", status: "unavailable" },
        ].map((row) => schema.parse(row));
      },
    };

    const result = await getActivityMapReadiness(sensorStore, "requested-user", [
      { id: "record-a", routeActivityId: "route-a", memberActivityIds: ["member-a1", "member-a2"] },
      { id: "record-b", routeActivityId: "route-b", memberActivityIds: ["member-b1"] },
      { id: "record-c", routeActivityId: "route-c", memberActivityIds: ["member-c1"] },
      { id: "empty-record", routeActivityId: "empty-route", memberActivityIds: [] },
    ]);

    expect(capturedParams).toEqual({
      userId: "requested-user",
      activityIds: ["record-a", "record-a", "record-b", "record-c"],
      routeActivityIds: ["route-a", "route-a", "route-b", "route-c"],
      memberActivityIds: ["member-a1", "member-a2", "member-b1", "member-c1"],
    });
    expect(result).toEqual(
      new Map([
        ["record-a", "processing"],
        ["record-b", "awaiting_summary"],
        ["record-c", "unavailable"],
      ]),
    );
  });

  it.each([
    { name: "no activities", activities: [] },
    {
      name: "activities without members",
      activities: [
        { id: "record-a", routeActivityId: "route-a", memberActivityIds: [] },
        { id: "record-b", routeActivityId: "route-b", memberActivityIds: [] },
      ],
    },
  ])("returns no map states without querying for $name", async ({ activities }) => {
    const sensorStore = {
      query: async () => {
        throw new Error("Empty activity members must not query the sensor store");
      },
    };

    await expect(
      getActivityMapReadiness(sensorStore, "requested-user", activities),
    ).resolves.toEqual(new Map());
  });
});

describe("getActivityRoutePreviews", () => {
  it("requests enough sampled points for a detailed route preview", async () => {
    let capturedParams: Record<string, unknown> | undefined;
    const sensorStore = {
      query: async <TSchema extends z.ZodType>(
        _schema: TSchema,
        _query: string,
        params?: Record<string, unknown>,
      ): Promise<z.infer<TSchema>[]> => {
        capturedParams = params;
        return [];
      },
    };

    await getActivityRoutePreviews(sensorStore, "user-1", ["activity-1"]);

    expect(capturedParams).toMatchObject({ maxPoints: 96 });
  });
});
