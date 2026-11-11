import { z } from "zod";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import {
  type IdentifierColumnDefinition,
  identifierNameSchema,
  type PhysicalTable,
  qualifiedTable,
} from "./clickhouse-erasure-coverage.ts";
import {
  ACCOUNT_ERASURE_IDENTIFIER_BYTE_LIMITS,
  ACCOUNT_ERASURE_IDENTIFIER_PAGE_SIZE,
  AccountErasureIdentifierBudgetError,
} from "./identifier-store.ts";

interface IdentifierCapture {
  table: PhysicalTable;
  column: readonly [string, IdentifierColumnDefinition];
  predicate: { sql: string; queryParameters: Record<string, unknown> };
  after?: string;
}

const valueRowsSchema = z.array(z.object({ value: z.string() }));
const lengthRowsSchema = z.tuple([z.object({ max_bytes: z.coerce.number().int().nonnegative() })]);

/** Read one typed relation page; String values and cursors use exact-byte base64. */
export async function readClickHouseErasureIdentifierPage(
  client: Pick<ClickHouseClient, "query">,
  input: IdentifierCapture,
): Promise<{ values: string[]; nextCursor: string | null }> {
  const [name, definition] = input.column;
  identifierNameSchema.parse(name);
  const isString = definition.valueType === "string";
  const count = isString
    ? Math.floor(
        ACCOUNT_ERASURE_IDENTIFIER_BYTE_LIMITS.decodedPage /
          ACCOUNT_ERASURE_IDENTIFIER_BYTE_LIMITS.stringItem,
      )
    : ACCOUNT_ERASURE_IDENTIFIER_PAGE_SIZE;
  const maximumValueBytes = isString ? ACCOUNT_ERASURE_IDENTIFIER_BYTE_LIMITS.stringItem : 36;
  if (
    count * (isString ? Math.ceil(maximumValueBytes / 3) * 4 + 64 : maximumValueBytes + 64) >
    ACCOUNT_ERASURE_IDENTIFIER_BYTE_LIMITS.wirePage
  )
    throw new AccountErasureIdentifierBudgetError(
      "Account erasure identifier page exceeds its wire byte budget",
    );
  const column = definition.cardinality === "array" ? "captured_identifier" : `\`${name}\``;
  const source = `${qualifiedTable(input.table.database, input.table.name)}${definition.cardinality === "array" ? ` ARRAY JOIN \`${name}\` AS captured_identifier` : ""}`;
  const parameters = { ...input.predicate.queryParameters };
  let cursorExpression = "";
  if (input.after !== undefined) {
    if (isString) {
      const encodedLimit = Math.ceil(maximumValueBytes / 3) * 4;
      if (input.after.length > encodedLimit)
        throw new AccountErasureIdentifierBudgetError(
          "Account erasure String cursor exceeds its 4 KiB String key limit",
        );
      z.string().min(1).base64().parse(input.after);
      const padding = input.after.endsWith("==") ? 2 : input.after.endsWith("=") ? 1 : 0;
      if ((input.after.length / 4) * 3 - padding > maximumValueBytes)
        throw new AccountErasureIdentifierBudgetError(
          "Account erasure String cursor exceeds its 4 KiB String key limit",
        );
      if (Buffer.from(input.after, "base64").toString("base64") !== input.after)
        throw new Error("Account erasure String cursor must use canonical exact-byte base64");
      parameters.account_erasure_capture_after = input.after;
      cursorExpression = "base64Decode({account_erasure_capture_after:String})";
    } else {
      z.uuid().parse(input.after);
      parameters.account_erasure_capture_after = input.after;
      cursorExpression = "{account_erasure_capture_after:UUID}";
    }
  }
  const comparison = input.after === undefined ? "" : ` AND ${column} > ${cursorExpression}`;
  const where = `(${input.predicate.sql}) AND isNotNull(${column})${isString ? ` AND notEmpty(assumeNotNull(${column}))` : ""}${comparison}`;
  // Inspect lengths without transferring payloads; an oversized attributable value
  // blocks the scan, rather than disappearing behind a truncation/filter clause.
  if (isString) {
    const lengths = await client.query({
      query: `SELECT max(length(assumeNotNull(${column}))) AS max_bytes FROM ${source} WHERE ${where}`,
      query_params: parameters,
      format: "JSONEachRow",
      clickhouse_settings: { log_queries: 0 },
    });
    if (lengthRowsSchema.parse(await lengths.json())[0].max_bytes > maximumValueBytes)
      throw new AccountErasureIdentifierBudgetError(
        "Account erasure identifier exceeds its 4 KiB String key limit",
      );
  }
  const result = await client.query({
    // The candidate LIMIT precedes base64 encoding: a byte-bounded number of maximum-sized
    // String values reach that materialization, without a wide window/groupArray.
    query: `SELECT ${isString ? "base64Encode(assumeNotNull(identifier_value))" : "toString(assumeNotNull(identifier_value))"} AS value
      FROM (SELECT ${column} AS identifier_value FROM ${source}
        WHERE ${where} ORDER BY identifier_value LIMIT ${count})`,
    query_params: parameters,
    format: "JSONEachRow",
    clickhouse_settings: { log_queries: 0 },
  });
  const values = valueRowsSchema.parse(await result.json()).map((row) => row.value);
  if (
    values.length > count ||
    values.reduce(
      (sum, value) =>
        sum + (isString ? Buffer.from(value, "base64").length : Buffer.byteLength(value, "utf8")),
      0,
    ) > ACCOUNT_ERASURE_IDENTIFIER_BYTE_LIMITS.decodedPage
  )
    throw new AccountErasureIdentifierBudgetError(
      "Account erasure identifier page exceeds its decoded byte budget",
    );
  return { values, nextCursor: values.length === count ? (values.at(-1) ?? null) : null };
}
