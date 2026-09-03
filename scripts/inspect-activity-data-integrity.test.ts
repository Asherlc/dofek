import { describe, expect, it, vi } from "vitest";
import {
  inspectActivityDataIntegrity,
  parseInspectionArgs,
} from "./inspect-activity-data-integrity.ts";

const testUserId = "00000000-0000-4000-8000-000000000001";

describe("parseInspectionArgs", () => {
  it("accepts one user and repeated activity IDs", () => {
    expect(
      parseInspectionArgs([`--user-id=${testUserId}`, "--activity-id=2a", "--activity-id=761"]),
    ).toEqual({
      userId: testUserId,
      activityIds: ["2a", "761"],
    });
  });
});

describe("inspectActivityDataIntegrity", () => {
  it("reports the currently selected speed-summary member, Strong parentage, and peak HR provenance", async () => {
    const postgres = {
      execute: vi
        .fn()
        .mockResolvedValueOnce([
          {
            requested_activity_id: "2a",
            activity_id: "wahoo-canonical",
            provider_id: "wahoo",
            canonical_type: "cycling",
            provider_type: "outdoor_cycling",
            member_activity_ids: ["wahoo-member", "peloton-member"],
          },
          {
            requested_activity_id: "761",
            activity_id: "walking-canonical",
            provider_id: "apple_health",
            canonical_type: "walking",
            provider_type: "walking",
            member_activity_ids: ["walking-member"],
          },
        ])
        .mockResolvedValueOnce([
          {
            activity_id: "wahoo-member",
            provider_id: "wahoo",
            canonical_type: "cycling",
            provider_type: "outdoor_cycling",
            external_id: "wahoo-1",
            name: "Wahoo ride",
            name_utf8_hex: "5761686f6f2072696465",
            set_count: 0,
            set_activity_ids: [],
          },
          {
            activity_id: "peloton-member",
            provider_id: "peloton",
            canonical_type: "cycling",
            provider_type: "indoor_cycling",
            external_id: "peloton-1",
            name: "Peloton ride",
            name_utf8_hex: "50656c6f746f6e2072696465",
            set_count: 0,
            set_activity_ids: [],
          },
          {
            activity_id: "walking-member",
            provider_id: "apple_health",
            canonical_type: "walking",
            provider_type: "walking",
            external_id: "walk-1",
            name: "Walk",
            name_utf8_hex: "57616c6b",
            set_count: 0,
            set_activity_ids: [],
          },
          {
            activity_id: "6ca753f3",
            provider_id: "strong-csv",
            canonical_type: "strength",
            provider_type: "strength",
            external_id: "strong:with-sets",
            name: "Leg Day ",
            name_utf8_hex: "4c65672044617920",
            set_count: 2,
            set_activity_ids: ["6ca753f3"],
          },
          {
            activity_id: "369e6444",
            provider_id: "strong-csv",
            canonical_type: "strength",
            provider_type: "strength",
            external_id: "strong:no-sets",
            name: "Upper",
            name_utf8_hex: "5570706572",
            set_count: 0,
            set_activity_ids: [],
          },
        ]),
    };
    const clickHouse = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          json: async () => [
            { activity_id: "peloton-member", avg_speed: 8.2, max_hr: 174 },
            { activity_id: "walking-member", avg_speed: 1.4, max_hr: 189 },
          ],
        })
        .mockResolvedValueOnce({
          json: async () => [
            {
              activity_id: "walking-member",
              summary_max_hr: 189,
              recorded_at: "2026-09-01T12:00:00.000Z",
              scalar: 189,
              source_metric_stream_id: "source-hr-189",
              source_provider_id: "apple_health",
              source_external_id: "sample-189",
              source_device_id: "watch",
              source_type: "recording",
              source_metadata: '{"origin":"watch"}',
            },
          ],
        }),
    };

    const result = await inspectActivityDataIntegrity(
      { postgres, clickHouse },
      { userId: testUserId, activityIds: ["2a", "761", "6ca753f3", "369e6444"] },
    );

    expect(result.activities[0]).toMatchObject({
      requestedActivityId: "2a",
      selectedSummaryActivityId: "peloton-member",
      selectedSummaryMember: {
        providerId: "peloton",
        canonicalType: "cycling",
        providerType: "indoor_cycling",
      },
    });
    expect(result.strongSessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          activityId: "369e6444",
          setCount: 0,
          name: "Upper",
          nameUtf8Hex: "5570706572",
          setActivityIds: [],
        }),
        expect.objectContaining({
          activityId: "6ca753f3",
          setCount: 2,
          name: "Leg Day ",
          nameUtf8Hex: "4c65672044617920",
          setActivityIds: ["6ca753f3"],
        }),
      ]),
    );
    expect(result.sourceHeartRateSamples).toEqual([
      expect.objectContaining({
        activityId: "walking-member",
        summaryMaxHr: 189,
        scalar: 189,
        sourceMetricStreamId: "source-hr-189",
        sourceProviderId: "apple_health",
      }),
    ]);
  });

  it.each([
    { userId: "not-a-uuid", activityIds: ["2a"], message: "--user-id must be a UUID" },
    { userId: testUserId, activityIds: ["2a%"], message: "UUID prefix" },
    { userId: testUserId, activityIds: ["2a_"], message: "UUID prefix" },
  ])("rejects unsafe inspection input", async ({ userId, activityIds, message }) => {
    const postgres = { execute: vi.fn() };

    await expect(
      inspectActivityDataIntegrity(
        { postgres, clickHouse: { query: vi.fn() } },
        { userId, activityIds },
      ),
    ).rejects.toThrow(message);
    expect(postgres.execute).not.toHaveBeenCalled();
  });
});
