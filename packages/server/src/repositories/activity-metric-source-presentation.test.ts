import type { ActivityHardware } from "@dofek/providers/activity-hardware";
import { describe, expect, it } from "vitest";
import { normalizeActivityHardware } from "../models/activity-hardware.ts";
import { buildActivitySourceTree } from "../models/activity-source-tree.ts";
import { presentActivityMetricSource } from "./activity-metric-source-presentation.ts";
import { activityMetricWindow as window } from "./activity-metric-source-test-helpers.ts";

const emptySourceTree = { primary: null, otherSources: [] };

function hardwareItem(
  overrides: Partial<ActivityHardware["items"][number]> = {},
): ActivityHardware["items"][number] {
  return {
    id: "recorder",
    activityId: window.activityId,
    providerId: "garmin",
    sourceName: "Recording app",
    role: "recorder",
    label: "Edge 530",
    model: null,
    manufacturer: null,
    evidence: "Reported",
    details: [],
    ...overrides,
  };
}

function present(
  items: ActivityHardware["items"],
  overrides: Partial<{
    provider_id: string;
    device_id: string | null;
    activity_ids: string[];
  }> = {},
) {
  return presentActivityMetricSource(
    {
      provider_id: "garmin",
      device_id: null,
      source_id: "unchanged-source",
      activity_ids: [window.activityId],
      ...overrides,
    },
    { items, power: [] },
    emptySourceTree,
  );
}

describe("activity metric source presentation", () => {
  it.each(["recorder", "creator"] as const)(
    "retains %s hardware qualifiers alongside inherited attribution",
    (role) => {
      const tree = buildActivitySourceTree(
        { status: "resolved", memberActivityId: "original", providerId: "wahoo", sourceName: null },
        [
          {
            memberActivityId: "original",
            providerId: "wahoo",
            externalId: "original",
            subsource: null,
            label: "Wahoo",
            url: null,
          },
          {
            memberActivityId: "copy",
            providerId: "strava",
            externalId: "copy",
            subsource: null,
            label: "Strava",
            url: null,
          },
        ],
        [
          {
            upstreamMemberActivityId: "original",
            downstreamMemberActivityId: "copy",
            field: "external_id",
            value: "original",
          },
        ],
      );
      const hardware = normalizeActivityHardware([
        {
          activityId: "copy",
          providerId: "strava",
          sourceName: null,
          raw: role === "recorder" ? { device_name: "Edge 530" } : null,
          observations:
            role === "creator"
              ? [{ sequence: 0, messageType: "file_id", raw: { product_name: "Export platform" } }]
              : [],
        },
      ]);
      const source = presentActivityMetricSource(
        {
          provider_id: "strava",
          device_id: null,
          source_id: "copy-recording",
          activity_ids: ["copy"],
        },
        hardware,
        tree,
      );
      expect(source).toMatchObject({
        id: "copy-recording",
        label:
          role === "recorder"
            ? "Wahoo via Strava · recorded by Edge 530"
            : "Wahoo via Strava · file created by Export platform",
        presentation: {
          displayName: role === "recorder" ? "Edge 530" : "Wahoo",
          providerId: "wahoo",
          attribution: { kind: "provider", providerId: "strava" },
        },
      });
    },
  );

  it("preserves a distinguishing inherited source label beside recorder hardware", () => {
    const tree = buildActivitySourceTree(
      {
        status: "resolved",
        memberActivityId: "original",
        providerId: "custom-device",
        sourceName: null,
      },
      [
        {
          memberActivityId: "original",
          providerId: "custom-device",
          externalId: "original",
          subsource: null,
          label: "Imported source",
          url: null,
        },
        {
          memberActivityId: "copy",
          providerId: "strava",
          externalId: "copy",
          subsource: null,
          label: "Strava",
          url: null,
        },
      ],
      [
        {
          upstreamMemberActivityId: "original",
          downstreamMemberActivityId: "copy",
          field: "external_id",
          value: "original",
        },
      ],
    );

    const source = presentActivityMetricSource(
      {
        provider_id: "strava",
        device_id: null,
        source_id: "copy-recording",
        activity_ids: ["copy"],
      },
      { items: [hardwareItem({ providerId: "strava", activityId: "copy" })], power: [] },
      tree,
    );

    expect(source.presentation).toMatchObject({
      displayName: "custom-device",
      providerId: "custom-device",
    });
  });

  it.each(["fit-file", "garmin"])(
    "qualifies creator-only FIT provenance and recorder evidence for %s",
    (providerId) => {
      const hardware = normalizeActivityHardware([
        {
          activityId: window.activityId,
          providerId,
          sourceName: null,
          raw: providerId === "garmin" ? { deviceName: "Edge 530" } : null,
          observations: [
            { sequence: 0, messageType: "file_id", raw: { product_name: "Export platform" } },
          ],
        },
      ]);
      const source = presentActivityMetricSource(
        {
          provider_id: providerId,
          device_id: null,
          source_id: providerId,
          activity_ids: [window.activityId],
        },
        hardware,
        emptySourceTree,
      );
      expect(source.label).toBe(
        providerId === "garmin"
          ? "Garmin · recorded by Edge 530"
          : "FIT File · file created by Export platform",
      );
    },
  );

  it("does not use a different provider's recorder for the same member activity", () => {
    expect(present([hardwareItem({ providerId: "strava" })]).label).toBe("Garmin");
  });

  it("matches null device IDs independently of a known source app", () => {
    expect(present([hardwareItem()]).label).toBe("Garmin · recorded by Edge 530");
  });

  it("keeps WHOOP Bluetooth attribution and the opaque source ID", () => {
    const source = present([], {
      provider_id: "whoop_ble",
      device_id: "strap-a",
    });

    expect(source).toMatchObject({
      id: "unchanged-source",
      label: "WHOOP (Bluetooth) · strap-a",
      presentation: { providerId: "whoop_ble", attribution: { kind: "bluetooth" } },
    });
  });

  it("matches a device ID to the source app while retaining the distinct recorder name", () => {
    expect(present([hardwareItem()], { device_id: "Recording app" }).label).toBe(
      "Garmin · Recording app · recorded by Edge 530",
    );
  });

  it("qualifies a creator matched by its own name even when the source app differs", () => {
    expect(present([hardwareItem({ role: "creator" })], { device_id: "Edge 530" }).label).toBe(
      "Garmin · file created by Edge 530",
    );
  });

  it("keeps the existing label when the stream device matches neither app nor hardware", () => {
    expect(present([hardwareItem()], { device_id: "Unrelated watch" }).label).toBe(
      "Garmin · Unrelated watch",
    );
  });

  it("retains an already descriptive recorder label without duplicating it", () => {
    expect(present([hardwareItem()], { device_id: "Edge 530" }).label).toBe("Garmin · Edge 530");
  });

  it("normalizes repeated whitespace when matching a recorder label", () => {
    expect(
      present([hardwareItem({ sourceName: "Edge 530", label: "Edge   530" })], {
        device_id: "Edge 530",
      }).label,
    ).toBe("Garmin · Edge 530");
  });

  it("normalizes repeated whitespace in the stream device label before matching", () => {
    const source = present([hardwareItem({ sourceName: "Edge   530", label: "Edge 530" })], {
      device_id: "Edge   530",
    });

    expect(source.label).not.toContain("recorded by");
  });

  it("normalizes repeated whitespace in the source label before matching", () => {
    const source = present([hardwareItem({ sourceName: "Edge   530", label: "Edge 530" })], {
      device_id: "Edge   530",
    });

    expect(source.label).not.toContain("recorded by");
  });

  it.each(["Asher’s Apple\u00a0Watch", "Asher’s Apple\u202fWatch", "Asher’s APPLE WATCH"])(
    "recognizes the recorder already named in %s",
    (deviceName) => {
      expect(
        present(
          [
            hardwareItem({
              providerId: "apple_health",
              sourceName: deviceName,
              label: "Apple Watch",
            }),
          ],
          { provider_id: "apple_health", device_id: deviceName },
        ).label,
      ).toBe(`${deviceName} (via Apple Health)`);
    },
  );

  it("retains the stream app label when qualifying its file creator", () => {
    expect(present([hardwareItem({ role: "creator" })], { device_id: "Recording app" }).label).toBe(
      "Garmin · Recording app · file created by Edge 530",
    );
  });

  it("does not choose between conflicting recorder names", () => {
    expect(present([hardwareItem(), hardwareItem({ id: "other", label: "Edge 1050" })]).label).toBe(
      "Garmin",
    );
  });

  it.each(["33333333-3333-3333-3333-333333333333", ""])(
    "requires recorder evidence for every contributor, including %j",
    (missing) => {
      expect(present([hardwareItem()], { activity_ids: [window.activityId, missing] }).label).toBe(
        "Garmin",
      );
    },
  );

  it("uses a shared recorder label only when every member has matching evidence", () => {
    const otherActivityId = "33333333-3333-3333-3333-333333333333";
    expect(
      present([hardwareItem(), hardwareItem({ id: "other", activityId: otherActivityId })], {
        activity_ids: [window.activityId, otherActivityId],
      }).label,
    ).toBe("Garmin · recorded by Edge 530");
  });

  it("does not treat one member's creator as another member's recorder", () => {
    const otherActivityId = "33333333-3333-3333-3333-333333333333";
    expect(
      present(
        [
          hardwareItem(),
          hardwareItem({ id: "other", activityId: otherActivityId, role: "creator" }),
        ],
        { activity_ids: [window.activityId, otherActivityId] },
      ).label,
    ).toBe("Garmin");
  });
});
