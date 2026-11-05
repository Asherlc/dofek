import { readFileSync } from "node:fs";
import type { CdcTransactionRecord } from "./cdc-admission.ts";

// Exact synthetic native captures from the retained source qualification:
// fixture database/user; qualification.facts/related/marker; no health data.
// Includes tx820's real PK split, tx825/826's reverse commit order, and all
// tx823 rows plus its 25 actual source republications. No fitness mapping.
const captures = readFileSync(
  new URL("./test-fixtures/cdc-source-transactions.ndjson", import.meta.url),
  "utf8",
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));

export const admission = { generation: "test-raw-generation", lineage: "test-source-lineage" };

export function transactionRecords(xid: string): CdcTransactionRecord[] {
  return captures.flatMap<CdcTransactionRecord>((capture) => {
    const data = Buffer.from(capture.dataBase64, "base64");
    const value = JSON.parse(
      data.toString("utf8"),
      (_key: string, value: unknown, context?: { source?: string }) =>
        typeof value === "number" && Number.isInteger(value) ? context?.source : value,
    );
    const transactionId = value.source?.txId ?? value.id.split(":")[0];
    if (transactionId !== xid) return [];
    const delivery = {
      topic: capture.topic,
      serializedMessageId: capture.messageIdBase64,
      data,
      key: capture.key,
      properties: capture.properties,
    };
    if (value.status === "BEGIN") return [];
    if (value.status === "END")
      return [
        {
          kind: "end" as const,
          ...admission,
          transactionId: value.id,
          eventCount: value.event_count,
          collections: value.data_collections.map(
            (item: { data_collection: string; event_count: string }) => ({
              collection: item.data_collection,
              eventCount: item.event_count,
            }),
          ),
          delivery,
        },
      ];
    const source = value.source;
    const structuralHeaders = Object.fromEntries(
      ["__debezium.oldkey", "__debezium.newkey"]
        .filter((key) => Object.hasOwn(capture.properties, key))
        .map((key) => [key, capture.properties[key]]),
    );
    return [
      {
        kind: "row" as const,
        ...admission,
        transactionId: value.transaction.id,
        xid: source.txId,
        rowLsn: source.lsn,
        ordinal: value.transaction.total_order,
        collectionOrdinal: value.transaction.data_collection_order,
        collection: `${source.schema}.${source.table}`,
        stablePayload: JSON.stringify({
          op: value.op,
          before: value.before,
          after: value.after,
          source: {
            schema: source.schema,
            table: source.table,
            txId: source.txId,
            lsn: source.lsn,
          },
          transaction: value.transaction,
          key: capture.key,
          structuralHeaders,
        }),
        delivery,
      },
    ];
  });
}
