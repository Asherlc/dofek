import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@clickhouse/client";
import { expect, it } from "vitest";
import { decodeFitnessCdc } from "./cdc-fitness-decoder.ts";

it("round-trips the supported CDC temporal endpoints without losing microseconds", async () => {
  const url = process.env.CLICKHOUSE_URL?.trim();
  if (!url) throw new Error("CLICKHOUSE_URL is required");
  const client = createClient({
    url,
    clickhouse_settings: { max_memory_usage: "134217728", max_execution_time: 10 },
  });
  const table = `cdc_temporal_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.command({
      query: `CREATE TABLE ${table} (day Date32, instant DateTime64(6, 'UTC')) ENGINE = Memory`,
    });
    const capture = readFileSync(
      new URL("./test-fixtures/cdc-fitness-envelopes.ndjson", import.meta.url),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((row) => row.topic.endsWith(".activity"));
    if (!capture) throw new Error("Missing native activity fixture");
    const values = [
      "0001-01-01T00:00:00.000000Z",
      "0001-01-01T00:00:00.000001Z",
      "9999-12-31T23:59:59.999999Z",
    ];
    for (const instant of values) {
      const envelope = JSON.parse(Buffer.from(capture.dataBase64, "base64").toString());
      envelope.after.started_at = instant;
      const decoded = decodeFitnessCdc(
        {
          topicPrefix: "persistent://public/default/ownedcdc-fitness-small-2",
          connectorName: "ownedcdc-fitness-small-2",
          database: "fixture",
          generation: "temporal-generation",
          lineage: "temporal-lineage",
        },
        {
          topic: capture.topic,
          serializedMessageId: capture.messageIdBase64,
          key: capture.key,
          properties: capture.properties,
          data: Buffer.from(JSON.stringify(envelope)),
        },
      );
      if (decoded.kind !== "snapshot" || decoded.after?.table !== "activity")
        throw new Error("Expected native activity snapshot");
      expect(decoded.after.fields.started_at).toBe(instant);
      await client.insert({
        table,
        format: "JSONEachRow",
        values: [
          {
            day: instant.slice(0, 10),
            instant: decoded.after.fields.started_at.replace("T", " ").replace(/Z$/, ""),
          },
        ],
      });
    }
    const result = await client.query({
      query: `SELECT toString(day) AS day, toString(instant) AS instant FROM ${table} ORDER BY instant`,
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([
      { day: "0001-01-01", instant: "0001-01-01 00:00:00.000000" },
      { day: "0001-01-01", instant: "0001-01-01 00:00:00.000001" },
      { day: "9999-12-31", instant: "9999-12-31 23:59:59.999999" },
    ]);
  } finally {
    try {
      await client.command({ query: `DROP TABLE IF EXISTS ${table} SYNC` });
    } finally {
      await client.close();
    }
  }
});
