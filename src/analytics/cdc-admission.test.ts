import { describe, expect, it } from "vitest";
import { admitCdcTransaction, type CdcTransactionRecord } from "./cdc-admission.ts";
import { admission, transactionRecords } from "./cdc-admission-test-helpers.ts";

function admit(xid: string, records = transactionRecords(xid)) {
  return admitCdcTransaction({ admission, xid, records });
}

describe("CDC transaction admission", () => {
  it("requires END and every emitted ordinal, preserving the real same-LSN PK split", () => {
    const records = transactionRecords("820");
    const result = admit("820", records);
    expect(result.state).toBe("complete");
    if (result.state !== "complete") throw new Error("expected complete transaction");
    expect(result.endLsn).toBe("52258552");
    expect(result.rows.map((row) => row.record.ordinal)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
    ]);
    expect(result.rows[2]?.record.rowLsn).toBe("52190736");
    expect(result.rows[3]?.record.rowLsn).toBe("52190736");
    expect(result.rows[2]?.sourceRevision).toBe("170141183460951231798890624933894815747");
    expect(result.rows[3]?.sourceRevision).toBe("170141183460951231798890624933894815748");
    expect(result.rows[2]?.deliveries[0]).toBe(
      records.find((row) => row.kind === "row" && row.ordinal === "3")?.delivery,
    );
  });

  it("leaves a missing END pending", () => {
    expect(
      admit(
        "820",
        transactionRecords("820").filter((record) => record.kind !== "end"),
      ),
    ).toMatchObject({ state: "pending", reason: "missing-end", observedCount: "8" });
  });

  it("leaves a missing ordinal pending even when END arrived first", () => {
    const records = transactionRecords("820").filter(
      (record) => record.kind !== "row" || record.ordinal !== "3",
    );
    expect(admit("820", records)).toMatchObject({
      state: "pending",
      reason: "missing-ordinals",
      missingOrdinals: [{ first: "3", last: "3" }],
    });
  });

  it("uses commit END rather than raw XID allocation to rank revisions", () => {
    const slow = admit("825"),
      fast = admit("826");
    expect(slow.state).toBe("complete");
    expect(fast.state).toBe("complete");
    if (slow.state !== "complete" || fast.state !== "complete")
      throw new Error("expected overlap transactions");
    expect(slow.endLsn).toBe("52337928");
    expect(fast.endLsn).toBe("52337880");
    const slowFirst = slow.rows[0],
      fastFirst = fast.rows[0];
    if (!slowFirst || !fastFirst) throw new Error("expected overlap rows");
    expect(BigInt(slowFirst.sourceRevision)).toBeGreaterThan(BigInt(fastFirst.sourceRevision));
  });

  it("collapses 25 actual republications while retaining every native delivery", () => {
    const result = admit("823");
    expect(result.state).toBe("complete");
    if (result.state !== "complete") throw new Error("expected COPY transaction");
    expect(result.rows).toHaveLength(301);
    expect(result.rows.filter((row) => row.deliveries.length === 2)).toHaveLength(25);
    const repeated = result.rows.find((row) => row.deliveries.length === 2);
    if (!repeated) throw new Error("expected republication");
    expect(repeated.deliveries[0]?.serializedMessageId).not.toBe(
      repeated.deliveries[1]?.serializedMessageId,
    );
  });

  it("rejects a changed stable payload for the same source ordinal", () => {
    const records = transactionRecords("823");
    const last = [...records]
      .reverse()
      .find((record) => record.kind === "row" && record.ordinal === "1");
    if (!last) throw new Error("expected actual republication");
    expect(
      admit(
        "823",
        records.map((record) =>
          record === last && record.kind === "row"
            ? { ...record, stablePayload: `${record.stablePayload} changed` }
            : record,
        ),
      ),
    ).toMatchObject({ state: "failed" });
  });

  it.each(["lineage", "generation"] as const)(
    "rejects a foreign %s before comparing revisions",
    (field) => {
      const records = transactionRecords("820");
      expect(
        admit(
          "820",
          records.map((record, index) =>
            index === 0 ? { ...record, [field]: "foreign" } : record,
          ),
        ),
      ).toMatchObject({ state: "failed" });
    },
  );

  it("rejects table counts that disagree despite a full global ordinal set", () => {
    const records = transactionRecords("820").map((record) =>
      record.kind === "end"
        ? {
            ...record,
            collections: record.collections.map((entry) => ({
              ...entry,
              eventCount:
                entry.collection === "qualification.facts"
                  ? "4"
                  : entry.collection === "qualification.related"
                    ? "3"
                    : entry.eventCount,
            })),
          }
        : record,
    );
    expect(admit("820", records)).toMatchObject({ state: "failed" });
  });

  it("rejects ambiguous END coordinates for one admitted XID", () => {
    const records = transactionRecords("820");
    const end = records.find((record) => record.kind === "end");
    if (!end) throw new Error("expected END");
    expect(admit("820", [...records, { ...end, transactionId: "820:52258560" }])).toMatchObject({
      state: "failed",
    });
  });

  it("accepts transaction evidence spanning more than 500 native deliveries", () => {
    const records = transactionRecords("823");
    expect(admit("823", [...records, ...records]).state).toBe("complete");
  });

  it("rejects inconsistent collection ordinals", () => {
    const records = transactionRecords("820").map((record) =>
      record.kind === "row" && record.ordinal === "2"
        ? { ...record, collectionOrdinal: "1" }
        : record,
    );
    expect(admit("820", records)).toMatchObject({ state: "failed" });
  });

  it("rejects a permuted collection ordinal set even when every count matches", () => {
    const records = transactionRecords("820").map((record) =>
      record.kind === "row" && record.collection === "qualification.facts"
        ? {
            ...record,
            collectionOrdinal:
              record.collectionOrdinal === "1"
                ? "2"
                : record.collectionOrdinal === "2"
                  ? "1"
                  : record.collectionOrdinal,
          }
        : record,
    );
    expect(admit("820", records)).toMatchObject({ state: "failed" });
  });

  it("does not let one native delivery satisfy two source ordinals", () => {
    const records = transactionRecords("820");
    const first = records.find((record) => record.kind === "row" && record.ordinal === "1");
    if (!first) throw new Error("expected source ordinal one");
    expect(
      admit(
        "820",
        records.map((record) =>
          record.kind === "row" && record.ordinal === "2"
            ? { ...record, delivery: first.delivery }
            : record,
        ),
      ),
    ).toMatchObject({ state: "failed" });
  });

  it("does not let one native delivery satisfy both a row and END", () => {
    const records = transactionRecords("820");
    const first = records.find((record) => record.kind === "row");
    if (!first) throw new Error("expected source row");
    expect(
      admit(
        "820",
        records.map((record) =>
          record.kind === "end" ? { ...record, delivery: first.delivery } : record,
        ),
      ),
    ).toMatchObject({ state: "failed" });
  });

  it("encodes unsigned END64 losslessly through its signed Java long representation", () => {
    const records: CdcTransactionRecord[] = transactionRecords("820").map((record) =>
      record.kind === "end" ? { ...record, transactionId: "820:-1" } : record,
    );
    const result = admit("820", records);
    expect(result.state).toBe("complete");
    if (result.state !== "complete") throw new Error("expected unsigned END");
    expect(result.endLsn).toBe("18446744073709551615");
    expect(result.rows[0]?.sourceRevision).toBe("340282366920938463454151235394913435649");
  });

  it.each(["0", "9223372036854775808", "9007199254740993.0"])(
    "rejects invalid ordinal %s",
    (ordinal) => {
      const records = transactionRecords("820").map((record) =>
        record.kind === "row" && record.ordinal === "1" ? { ...record, ordinal } : record,
      );
      expect(admit("820", records)).toMatchObject({ state: "failed" });
    },
  );
});
