export interface CdcDeliveryEvidence {
  // Source-neutral wire evidence: this gate never orders deliveries or advances
  // transport frontiers. The caller validates MetricStreamPosition separately
  // and retains its association with these original serialized IDs/bytes.
  topic: string;
  serializedMessageId: string;
  data: Buffer;
  key: string | null;
  properties: Readonly<Record<string, string>>;
}

export interface CdcAdmissionIdentity {
  generation: string;
  lineage: string;
}

interface CdcRecordIdentity extends CdcAdmissionIdentity {
  transactionId: string;
  delivery: CdcDeliveryEvidence;
}

export interface CdcTransactionRow extends CdcRecordIdentity {
  kind: "row";
  xid: string;
  rowLsn: string;
  ordinal: string;
  collectionOrdinal: string;
  collection: string;
  /** Canonical full stable source payload, including key and structural headers.
   * The validated decoder excludes volatile run/tracing publication metadata. */
  stablePayload: string;
}

export interface CdcTransactionEnd extends CdcRecordIdentity {
  kind: "end";
  eventCount: string;
  collections: readonly { collection: string; eventCount: string }[];
}

export type CdcTransactionRecord = CdcTransactionRow | CdcTransactionEnd;

export type CdcTransactionAdmission =
  | {
      state: "complete";
      admission: CdcAdmissionIdentity;
      xid: string;
      endLsn: string;
      endDeliveries: readonly CdcDeliveryEvidence[];
      rows: readonly {
        record: CdcTransactionRow;
        sourceRevision: string;
        deliveries: readonly CdcDeliveryEvidence[];
      }[];
    }
  | {
      state: "pending";
      reason: "missing-end" | "missing-ordinals";
      observedCount: string;
      missingOrdinals: readonly { first: string; last: string }[];
    }
  | { state: "failed"; reason: string };

const maximumOrdinal = (1n << 63n) - 1n;

function unsignedOrdinal(value: string): bigint | null {
  if (!/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= maximumOrdinal ? parsed : null;
}

function signedLongLsn(value: string): bigint | null {
  if (!/^(0|[1-9]\d*|-[1-9]\d*)$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed >= -(1n << 63n) && parsed <= maximumOrdinal ? BigInt.asUintN(64, parsed) : null;
}

function sameDelivery(left: CdcDeliveryEvidence, right: CdcDeliveryEvidence): boolean {
  const keys = Object.keys(left.properties);
  return (
    left.key === right.key &&
    left.data.equals(right.data) &&
    keys.length === Object.keys(right.properties).length &&
    keys.every((key) => left.properties[key] === right.properties[key])
  );
}

/**
 * Evaluate one already validated/decoded source transaction, across receive
 * groups and topics. This is NOT a receive group and has no 500-message cap.
 * The caller must bound and durably retain incomplete transaction evidence,
 * continue consuming independent control/data inputs, and hand completed rows
 * to the mapping/receipt coordinator. Completion here authorizes neither raw
 * publication, processed-frontier movement, nor ACK. Snapshot admission (raw
 * version zero), schema/ownership decoding and XID-incarnation validation are
 * separate prerequisites. One admitted lineage belongs to one raw generation;
 * callers must never compare these revisions across lineages/generations.
 */
export function admitCdcTransaction(input: {
  admission: CdcAdmissionIdentity;
  xid: string;
  records: readonly CdcTransactionRecord[];
}): CdcTransactionAdmission {
  const fail = (reason: string): CdcTransactionAdmission => ({ state: "failed", reason });
  if (!input.admission.generation || !input.admission.lineage || !/^[1-9]\d*$/.test(input.xid))
    return fail("An admitted generation, lineage and lossless raw XID are required");
  const rows = new Map<string, { record: CdcTransactionRow; deliveries: CdcDeliveryEvidence[] }>();
  const deliveries = new Map<string, { evidence: CdcDeliveryEvidence; subject: string }>();
  const endDeliveries: CdcDeliveryEvidence[] = [];
  let endLsn: bigint | null = null;
  let eventCount: bigint | null = null;
  let expectedCollections: Map<string, bigint> | null = null;
  for (const record of input.records) {
    if (
      record.generation !== input.admission.generation ||
      record.lineage !== input.admission.lineage
    )
      return fail("CDC evidence does not belong to the admitted generation and lineage");
    const coordinates = record.transactionId.split(":");
    const coordinate = coordinates[1];
    if (coordinates.length !== 2 || coordinates[0] !== input.xid || coordinate === undefined)
      return fail("CDC transaction identity does not match the admitted raw XID");
    const lsn = signedLongLsn(coordinate);
    if (lsn === null) return fail("CDC transaction coordinate is not a lossless signed Java long");
    const deliveryKey = JSON.stringify([
      record.delivery.topic,
      record.delivery.serializedMessageId,
    ]);
    const priorDelivery = deliveries.get(deliveryKey);
    const subject = record.kind === "row" ? `row:${record.ordinal}` : "end";
    if (
      priorDelivery &&
      (priorDelivery.subject !== subject || !sameDelivery(priorDelivery.evidence, record.delivery))
    )
      return fail("One native delivery identity has conflicting source or wire evidence");
    deliveries.set(deliveryKey, { evidence: record.delivery, subject });
    if (record.kind === "end") {
      const count = unsignedOrdinal(record.eventCount);
      if (count === null) return fail("CDC END event count exceeds the ordinal contract");
      const collections = new Map<string, bigint>();
      let sum = 0n;
      for (const collection of record.collections) {
        const collectionCount = unsignedOrdinal(collection.eventCount);
        if (
          !collection.collection ||
          collectionCount === null ||
          collectionCount === 0n ||
          collections.has(collection.collection)
        )
          return fail("CDC END collection counts are invalid or duplicated");
        collections.set(collection.collection, collectionCount);
        sum += collectionCount;
      }
      if (sum !== count) return fail("CDC END collection counts do not sum to its event count");
      if (
        endLsn !== null &&
        (endLsn !== lsn ||
          eventCount !== count ||
          expectedCollections?.size !== collections.size ||
          [...collections].some(([name, value]) => expectedCollections?.get(name) !== value))
      )
        return fail("One raw XID has ambiguous END evidence in this lineage");
      endLsn = lsn;
      eventCount = count;
      expectedCollections = collections;
      if (!priorDelivery) endDeliveries.push(record.delivery);
    } else {
      const ordinal = unsignedOrdinal(record.ordinal);
      const collectionOrdinal = unsignedOrdinal(record.collectionOrdinal);
      if (
        ordinal === null ||
        ordinal === 0n ||
        collectionOrdinal === null ||
        collectionOrdinal === 0n
      )
        return fail("CDC row ordinals must be positive lossless 63-bit integers");
      if (
        record.xid !== input.xid ||
        record.rowLsn !== coordinate ||
        !record.collection ||
        !record.stablePayload
      )
        return fail("CDC row identity or stable payload is incomplete");
      const previous = rows.get(record.ordinal);
      if (previous) {
        if (
          previous.record.transactionId !== record.transactionId ||
          previous.record.collection !== record.collection ||
          previous.record.collectionOrdinal !== record.collectionOrdinal ||
          previous.record.stablePayload !== record.stablePayload
        )
          return fail("Republished CDC source ordinal has conflicting stable payload or identity");
        if (!priorDelivery) previous.deliveries.push(record.delivery);
      } else {
        rows.set(record.ordinal, { record, deliveries: [record.delivery] });
      }
    }
  }
  const ordered = [...rows.values()].sort((left, right) =>
    BigInt(left.record.ordinal) < BigInt(right.record.ordinal) ? -1 : 1,
  );
  const seenCollections = new Map<string, Set<string>>();
  for (const { record } of ordered) {
    const ordinals = seenCollections.get(record.collection) ?? new Set<string>();
    if (ordinals.has(record.collectionOrdinal)) return fail("CDC collection ordinal is duplicated");
    ordinals.add(record.collectionOrdinal);
    seenCollections.set(record.collection, ordinals);
  }
  const observedCount = String(rows.size);
  if (endLsn === null || eventCount === null || expectedCollections === null)
    return { state: "pending", reason: "missing-end", observedCount, missingOrdinals: [] };
  for (const { record } of ordered) {
    const expectedCount = expectedCollections.get(record.collection);
    if (
      BigInt(record.ordinal) > eventCount ||
      expectedCount === undefined ||
      BigInt(record.collectionOrdinal) > expectedCount ||
      BigInt(seenCollections.get(record.collection)?.size ?? 0) > expectedCount
    )
      return fail("CDC row ordinals or collection counts exceed END evidence");
    const rowLsn = signedLongLsn(record.rowLsn);
    if (rowLsn === null || rowLsn >= endLsn)
      return fail("CDC row coordinate does not precede its transaction END");
  }
  const missingOrdinals: { first: string; last: string }[] = [];
  let next = 1n;
  for (const { record } of ordered) {
    const ordinal = BigInt(record.ordinal);
    if (ordinal > next) missingOrdinals.push({ first: String(next), last: String(ordinal - 1n) });
    next = ordinal + 1n;
  }
  if (next <= eventCount) missingOrdinals.push({ first: String(next), last: String(eventCount) });
  if (missingOrdinals.length)
    return { state: "pending", reason: "missing-ordinals", observedCount, missingOrdinals };
  for (const [collection, count] of expectedCollections) {
    if (BigInt(seenCollections.get(collection)?.size ?? 0) !== count)
      return fail("CDC complete ordinal set does not match END collection counts");
  }
  const collectionProgress = new Map<string, bigint>();
  for (const { record } of ordered) {
    const expected = (collectionProgress.get(record.collection) ?? 0n) + 1n;
    if (BigInt(record.collectionOrdinal) !== expected)
      return fail("CDC collection order disagrees with the complete transaction order");
    collectionProgress.set(record.collection, expected);
  }
  return {
    state: "complete",
    admission: input.admission,
    xid: input.xid,
    endLsn: String(endLsn),
    endDeliveries,
    rows: ordered.map(({ record, deliveries }) => ({
      record,
      deliveries,
      sourceRevision: String((1n << 127n) + (endLsn << 63n) + BigInt(record.ordinal)),
    })),
  };
}
