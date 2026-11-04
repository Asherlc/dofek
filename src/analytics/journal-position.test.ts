import { describe, expect, it } from "vitest";
import {
  journalDeliveryKey,
  journalDeliveryKeySchema,
  journalPositionColumns,
  metricStreamPositionIdentity,
  positionAtJournalKey,
} from "./journal-position.ts";

const stream = { epoch: "test-epoch", topic: "sensor", partition: 0 };
const kafka = { ...stream, transport: "kafka" as const, offset: "9007199254740993" };
const pulsar = {
  ...stream,
  transport: "pulsar" as const,
  serializedMessageId: "CAoQAA==",
  delivery: { major: "10", minor: "0", batch: -1 },
};

describe("journal position", () => {
  it("rejectsMixedCursorCoordinates", () => {
    expect(() =>
      journalDeliveryKeySchema.parse({ ...pulsar.delivery, offset: kafka.offset }),
    ).toThrow();
  });
  it("retainsEachTransportIdentityAndLosslessCursor", () => {
    expect(journalDeliveryKey(kafka)).toEqual({ offset: kafka.offset });
    expect(journalDeliveryKey(pulsar)).toEqual(pulsar.delivery);
    expect(metricStreamPositionIdentity(kafka)).toBe(kafka.offset);
    expect(metricStreamPositionIdentity(pulsar)).toBe(pulsar.serializedMessageId);
    expect(positionAtJournalKey(kafka, { offset: "9007199254740994" })).toEqual({
      ...kafka,
      offset: "9007199254740994",
    });
    expect(positionAtJournalKey(pulsar, { ...pulsar.delivery, batch: 1 })).toEqual({
      ...pulsar,
      delivery: { ...pulsar.delivery, batch: 1 },
    });
  });
  it("rejectsCursorFromAnotherTransport", () => {
    expect(() => positionAtJournalKey(kafka, pulsar.delivery)).toThrow(/transport/);
    expect(() => positionAtJournalKey(pulsar, { offset: kafka.offset })).toThrow(/transport/);
  });
  it("writesSeparatePhysicalIdentitiesAndCanonicalInactiveDefaults", () => {
    expect(journalPositionColumns(kafka)).toEqual({
      ...stream,
      transport: "kafka",
      kafka_offset: kafka.offset,
      major: "0",
      minor: "0",
      batch: -1,
    });
    expect(journalPositionColumns(pulsar)).toEqual({
      ...stream,
      transport: "pulsar",
      kafka_offset: "0",
      ...pulsar.delivery,
    });
  });
});
