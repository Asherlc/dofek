import { describe, expect, it } from "vitest";
import type { MetricStreamPosition } from "../metric-stream/transport-position.ts";
import {
  analyticsDeliveryGroupIngestionTimes,
  analyticsDeliveryGroupIntentId,
  describeAnalyticsDeliveryGroup,
} from "./analytics-delivery-group.ts";

const first = {
  transport: "kafka" as const,
  epoch: "capture-one",
  topic: "sensor",
  partition: 0,
  offset: "9007199254740993",
};
const last = { ...first, offset: "9007199254741011" };

describe("analytics delivery group identity", () => {
  it("linksTheQueryOwnerIntentToCanonicalGroupMembership", () => {
    const group = describeAnalyticsDeliveryGroup([first, last], 500);
    expect(analyticsDeliveryGroupIntentId(group)).toBe(
      "source-group:f2dd2ccf3255716225a42d924e10a8983ab478acadae5542a8b3251006359976",
    );
  });
  it("preservesLosslessSparsePositionsAndCommitsTheirOrderedIdentity", () => {
    expect(describeAnalyticsDeliveryGroup([first, last], 500)).toEqual({
      stream: { transport: "kafka", epoch: "capture-one", topic: "sensor", partition: 0 },
      first,
      last,
      memberCount: 2,
      positionsDigest: "f2dd2ccf3255716225a42d924e10a8983ab478acadae5542a8b3251006359976",
    });
  });

  it("acceptsExactlyTheConfiguredMaximumWithoutChangingMembershipIdentity", () => {
    const positions = Array.from({ length: 500 }, (_, index) => ({
      ...first,
      offset: String(9007199254740993n + BigInt(index)),
    }));
    expect(describeAnalyticsDeliveryGroup(positions, 500).memberCount).toBe(500);
    expect(describeAnalyticsDeliveryGroup([first], 1)).toEqual(
      describeAnalyticsDeliveryGroup([first], 500),
    );
  });

  it.each([0, 501, 1.5, Number.NaN])("rejectsInvalidMaximum: %s", (maximum) => {
    expect(() => describeAnalyticsDeliveryGroup([first], maximum)).toThrow(/maximum/i);
  });

  it("rejectsEmptyAndOversizedGroups", () => {
    expect(() => describeAnalyticsDeliveryGroup([], 500)).toThrow(/member|position|empty/i);
    expect(() => describeAnalyticsDeliveryGroup([first, last], 1)).toThrow(
      /maximum|member|position/i,
    );
  });

  it.each(["transport", "epoch", "topic", "partition"] as const)(
    "rejectsMixedStreamMembership: %s",
    (field) => {
      const other: MetricStreamPosition =
        field === "transport"
          ? {
              transport: "pulsar",
              epoch: first.epoch,
              topic: first.topic,
              partition: first.partition,
              delivery: { major: "1", minor: "2", batch: -1 },
              serializedMessageId: Buffer.from("08011002", "hex").toString("base64"),
            }
          : { ...last, [field]: field === "partition" ? 1 : "other" };
      expect(() => describeAnalyticsDeliveryGroup([first, other], 500)).toThrow(/stream/i);
    },
  );

  it.each([
    { name: "duplicate", positions: [first, first] },
    { name: "reverse", positions: [last, first] },
    {
      name: "interior reversal",
      positions: [first, last, { ...first, offset: "9007199254741000" }],
    },
  ])("rejectsNonIncreasingNativeOrder: $name", ({ positions }) => {
    expect(() => describeAnalyticsDeliveryGroup(positions, 500)).toThrow(/order/i);
  });

  it("detectsChangedInteriorMembershipWithIdenticalEndpoints", () => {
    const original = describeAnalyticsDeliveryGroup(
      [first, { ...first, offset: "9007199254740994" }, last],
      500,
    );
    const changed = describeAnalyticsDeliveryGroup(
      [first, { ...first, offset: "9007199254740995" }, last],
      500,
    );
    expect(original.positionsDigest).not.toBe(changed.positionsDigest);
    expect(original.first).toEqual(changed.first);
    expect(original.last).toEqual(changed.last);
  });

  it("preservesNativeIdsAndBatchedCoordinatesAcrossLedgerRollover", () => {
    const beforeRollover = {
      transport: "pulsar" as const,
      epoch: "capture-one",
      topic: "sensor",
      partition: -1,
      delivery: { major: "9007199254740993", minor: "9223372036854775806", batch: 4 },
      serializedMessageId: Buffer.from("08011002", "hex").toString("base64"),
    };
    const afterRollover = {
      ...beforeRollover,
      delivery: { major: "9007199254740994", minor: "0", batch: 0 },
      serializedMessageId: Buffer.from("08011003", "hex").toString("base64"),
    };
    const group = describeAnalyticsDeliveryGroup([beforeRollover, afterRollover], 500);
    expect(group.first).toEqual(beforeRollover);
    expect(group.last).toEqual(afterRollover);
    const changedId = describeAnalyticsDeliveryGroup(
      [
        beforeRollover,
        {
          ...afterRollover,
          serializedMessageId: Buffer.from("08011004", "hex").toString("base64"),
        },
      ],
      500,
    );
    expect(group.positionsDigest).not.toBe(changedId.positionsDigest);
    expect(
      describeAnalyticsDeliveryGroup(
        [{ ...beforeRollover, delivery: { ...beforeRollover.delivery, batch: 3 } }, afterRollover],
        500,
      ).positionsDigest,
    ).not.toBe(group.positionsDigest);
  });

  it("canonicalizesFieldOrderAndDoesNotRetainMutableInputObjects", () => {
    const input = { ...first };
    const group = describeAnalyticsDeliveryGroup([input, last], 500);
    const reordered = {
      offset: first.offset,
      partition: first.partition,
      topic: first.topic,
      epoch: first.epoch,
      transport: first.transport,
    };
    expect(describeAnalyticsDeliveryGroup([reordered, last], 500).positionsDigest).toBe(
      group.positionsDigest,
    );
    input.offset = "1";
    expect(group.first).toMatchObject({ offset: "9007199254740993" });
  });

  it("rejectsOneNativeMessageClaimingTwoDifferentCoordinates", () => {
    const position = {
      transport: "pulsar" as const,
      epoch: "capture-one",
      topic: "sensor",
      partition: -1,
      delivery: { major: "1", minor: "2", batch: -1 },
      serializedMessageId: Buffer.from("08011002", "hex").toString("base64"),
    };
    expect(() =>
      describeAnalyticsDeliveryGroup(
        [position, { ...position, delivery: { major: "1", minor: "3", batch: -1 } }],
        500,
      ),
    ).toThrow(/identity|message|duplicate/i);
  });

  it("rejectsMalformedPositionAndUnknownTransportFields", () => {
    expect(() =>
      describeAnalyticsDeliveryGroup([{ ...first, offset: "9007199254740993.1" }], 500),
    ).toThrow();
    const unknownField = { ...first, unexpected: true };
    expect(() => describeAnalyticsDeliveryGroup([unknownField], 500)).toThrow();
  });
});

describe("analytics delivery group ingestion times", () => {
  it("assignsDistinctOrderedMicrosecondsWithoutRoundingTheOriginalFraction", () => {
    expect(analyticsDeliveryGroupIngestionTimes("2026-11-04T01:02:03.123456Z", 3)).toEqual([
      "2026-11-04T01:02:03.123456Z",
      "2026-11-04T01:02:03.123457Z",
      "2026-11-04T01:02:03.123458Z",
    ]);
  });

  it.each([
    {
      base: "2026-11-04T01:02:03.999999Z",
      expected: ["2026-11-04T01:02:03.999999Z", "2026-11-04T01:02:04.000000Z"],
    },
    {
      base: "2026-11-04T23:59:59.999999Z",
      expected: ["2026-11-04T23:59:59.999999Z", "2026-11-05T00:00:00.000000Z"],
    },
    {
      base: "2024-02-28T23:59:59.999999Z",
      expected: ["2024-02-28T23:59:59.999999Z", "2024-02-29T00:00:00.000000Z"],
    },
    {
      base: "2026-12-31T23:59:59.999999Z",
      expected: ["2026-12-31T23:59:59.999999Z", "2027-01-01T00:00:00.000000Z"],
    },
    {
      base: "1969-12-31T23:59:59.999999Z",
      expected: ["1969-12-31T23:59:59.999999Z", "1970-01-01T00:00:00.000000Z"],
    },
  ])("preservesSixDecimalsAcrossCalendarBoundary: $base", ({ base, expected }) => {
    expect(analyticsDeliveryGroupIngestionTimes(base, 2)).toEqual(expected);
  });

  it("reservesExactlyFiveHundredMicrosecondsAtTheBoundedMaximum", () => {
    const times = analyticsDeliveryGroupIngestionTimes("2026-11-04T01:02:03.999900Z", 500);
    expect(times).toHaveLength(500);
    expect(times[0]).toBe("2026-11-04T01:02:03.999900Z");
    expect(times[499]).toBe("2026-11-04T01:02:04.000399Z");
    expect(new Set(times).size).toBe(500);
    expect(analyticsDeliveryGroupIngestionTimes("2026-11-04T01:02:03.000001Z", 1)).toEqual([
      "2026-11-04T01:02:03.000001Z",
    ]);
  });

  it.each([0, 501, 1.5, Number.NaN])("rejectsInvalidReservationCount: %s", (count) => {
    expect(() =>
      analyticsDeliveryGroupIngestionTimes("2026-11-04T01:02:03.123456Z", count),
    ).toThrow(/count/i);
  });

  it.each([
    "2026-11-04T01:02:03.123Z",
    "2026-11-04T01:02:03.123456789Z",
    "2026-11-04T01:02:03.123456+00:00",
    "2026-02-30T01:02:03.123456Z",
    "not-a-timestamp",
  ])("rejectsNonCanonicalOrInvalidBaseTimestamp: %s", (base) => {
    expect(() => analyticsDeliveryGroupIngestionTimes(base, 1)).toThrow(/timestamp|base/i);
  });

  it("rejectsTimestampRangeOverflow", () => {
    expect(() => analyticsDeliveryGroupIngestionTimes("9999-12-31T23:59:59.999999Z", 2)).toThrow(
      /timestamp|range/i,
    );
  });
});
