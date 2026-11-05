import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { admitCdcTransaction } from "./cdc-admission.ts";
import { decodeFitnessCdc } from "./cdc-fitness-decoder.ts";

const captures = readFileSync(
  new URL("./test-fixtures/cdc-fitness-envelopes.ndjson", import.meta.url),
  "utf8",
)
  .trim()
  .split("\n")
  .map((line) => {
    const capture = JSON.parse(line);
    return {
      topic: capture.topic,
      serializedMessageId: capture.messageIdBase64,
      key: capture.key,
      properties: capture.properties,
      data: Buffer.from(capture.dataBase64, "base64"),
    };
  });
const source = {
  topicPrefix: "persistent://public/default/ownedcdc-fitness-small-2",
  connectorName: "ownedcdc-fitness-small-2",
  database: "fixture",
  generation: "fitness-generation",
  lineage: "fitness-lineage",
};
const decoded = () => captures.map((delivery) => decodeFitnessCdc(source, delivery));
const activityUpdate = captures.find(
  (delivery) =>
    delivery.data.toString().includes('"op":"u"') && delivery.topic.endsWith(".activity"),
);
if (!activityUpdate) throw new Error("Missing real activity update");
const update = activityUpdate;
interface MutationEnvelope {
  source: Record<string, unknown>;
  before: unknown;
  after: Record<string, unknown>;
  op: unknown;
}
function mutated(change: (value: MutationEnvelope) => void) {
  const value = JSON.parse(update.data.toString());
  change(value);
  return { ...update, data: Buffer.from(JSON.stringify(value)) };
}

describe("native fitness CDC decoder", () => {
  it("accounts explicitly for every native envelope and retains its wire evidence", () => {
    const results = decoded();
    expect(results).toHaveLength(42);
    expect(results.filter((r) => r.kind === "snapshot")).toHaveLength(8);
    expect(results.filter((r) => r.kind === "row")).toHaveLength(11);
    expect(results.filter((r) => r.kind === "begin")).toHaveLength(3);
    expect(results.filter((r) => r.kind === "end")).toHaveLength(3);
    expect(new Set(results.map((r) => r.kind))).toEqual(
      new Set(["snapshot", "row", "begin", "end", "notification"]),
    );
    results.forEach((r, i) => {
      expect(r.delivery).toBe(captures[i]);
      expect(r.generation).toBe(source.generation);
      expect(r.lineage).toBe(source.lineage);
    });
  });
  it("chains the three real transactions through END admission, never assigning row-LSN revisions", () => {
    const results = decoded();
    for (const xid of ["844", "845", "846"]) {
      const records = results
        .filter((r) => r.kind === "row" || r.kind === "end")
        .filter(
          (r) =>
            (r.kind === "row" && r.xid === xid) ||
            (r.kind === "end" && r.transactionId.startsWith(`${xid}:`)),
        );
      expect(
        admitCdcTransaction({
          admission: source,
          xid,
          records: records.filter((r) => r.kind !== "end"),
        }),
      ).toMatchObject({ state: "pending", reason: "missing-end" });
      expect(
        admitCdcTransaction({
          admission: source,
          xid,
          records: records.filter((r) => r.kind !== "row" || r.ordinal !== "1"),
        }),
      ).toMatchObject({ state: "pending", reason: "missing-ordinals" });
      const admission = admitCdcTransaction({ admission: source, xid, records });
      expect(admission.state).toBe("complete");
      if (admission.state !== "complete") throw new Error("Missing END completeness");
      expect(admission.rows).toHaveLength(xid === "844" ? 1 : xid === "845" ? 3 : 7);
      admission.rows.forEach((row) => {
        expect(row.sourceRevision).toBe(
          String((1n << 127n) + (BigInt(admission.endLsn) << 63n) + BigInt(row.record.ordinal)),
        );
      });
    }
    for (const record of results)
      if (record.kind === "snapshot") expect(record.sourceRevision).toBe("0");
  });
  it("retains typed keys, before/after ownership, microseconds, JSON arrays, nulls and full TOAST text", () => {
    const record = decodeFitnessCdc(source, update);
    expect(record.kind).toBe("row");
    if (record.kind !== "row") throw new Error("Expected row");
    expect(record.after?.owner).toEqual({
      kind: "direct-user",
      userId: "00000000-0000-4000-8000-000000000001",
    });
    expect(record.after?.key).toEqual({ id: "00000000-0000-4000-8000-000000000011" });
    expect(record.stablePayload).toContain("2026-11-04T01:02:04.654321Z");
    expect(record.stablePayload).toContain("comma,value");
    if (record.after?.table !== "activity") throw new Error("Expected activity image");
    expect(record.after.fields.ended_at).toBeNull();
    expect(record.after.fields.notes).toHaveLength(32768);
    expect(
      decoded()
        .filter((r) => r.kind === "row" && r.after?.table === "sensor_provider_priority")
        .map((r) =>
          r.kind === "row" && r.after?.table === "sensor_provider_priority"
            ? r.after.fields.priority
            : null,
        ),
    ).toEqual(["2147483648"]);
    const marker = decoded().find(
      (r) => r.kind === "row" && r.before?.table === "processing_flow_marker",
    );
    expect(marker?.kind === "row" && marker.before?.owner).toEqual({
      kind: "inherited",
      parentTable: "fitness.processing_operation",
      key: { id: "00000000-0000-4000-8000-000000000021" },
    });
  });
  it("retains PK headers as typed keys and accounts for native null tombstones", () => {
    const deletion = captures.find((d) => d.properties["__debezium.newkey"]);
    if (!deletion) throw new Error("Missing native PK header");
    const record = decodeFitnessCdc(source, deletion);
    expect(record.kind === "row" && record.newKey).toEqual({
      id: "00000000-0000-4000-8000-000000000013",
    });
    expect(decodeFitnessCdc(source, { ...deletion, data: Buffer.from("null") })).toMatchObject({
      kind: "tombstone",
      key: { id: "00000000-0000-4000-8000-000000000011" },
    });
  });
  it.each([
    [
      "unknown table",
      (v: MutationEnvelope) => {
        v.source.table = "unknown";
      },
    ],
    [
      "unknown field",
      (v: MutationEnvelope) => {
        v.after.unknown = true;
      },
    ],
    [
      "missing before",
      (v: MutationEnvelope) => {
        v.before = null;
      },
    ],
    [
      "unavailable TOAST",
      (v: MutationEnvelope) => {
        v.after.notes = "__debezium_unavailable_value";
      },
    ],
    [
      "wrong source",
      (v: MutationEnvelope) => {
        v.source.db = "other";
      },
    ],
    [
      "unknown op",
      (v: MutationEnvelope) => {
        v.op = "t";
      },
    ],
    [
      "missing structural field",
      (v: MutationEnvelope) => {
        delete v.after.user_id;
      },
    ],
  ])("fails closed on %s", (_name, change) =>
    expect(() => decodeFitnessCdc(source, mutated(change))).toThrow(),
  );
  it("rejects a malformed or mismatched key and foreign topic", () => {
    expect(() => decodeFitnessCdc(source, { ...update, key: '{"id":"bad"}' })).toThrow();
    expect(() =>
      decodeFitnessCdc(source, {
        ...update,
        topic: `${source.topicPrefix}.fitness.provider_priority`,
      }),
    ).toThrow();
    expect(() =>
      decodeFitnessCdc(source, { ...update, key: '{"id":"00000000-0000-4000-8000-000000000099"}' }),
    ).toThrow();
  });
  it("includes nonstructural values in republication identity", () => {
    const original = decodeFitnessCdc(source, update);
    const changed = decodeFitnessCdc(
      source,
      mutated((v) => {
        v.after.name = "changed";
      }),
    );
    expect(original.kind === "row" && original.stablePayload).not.toEqual(
      changed.kind === "row" && changed.stablePayload,
    );
  });
  it("preserves Int64 bounds beyond JavaScript safe integers and rejects overflow", () => {
    const native = captures.find(
      (d) =>
        d.topic.endsWith(".sensor_provider_priority") && d.data.toString().includes("2147483648"),
    );
    if (!native) throw new Error("Missing synthetic bigint fixture");
    for (const integer of ["9223372036854775807", "-9223372036854775808"]) {
      const result = decodeFitnessCdc(source, {
        ...native,
        data: Buffer.from(native.data.toString().replace("2147483648", integer)),
      });
      expect(
        result.kind === "row" &&
          result.after?.table === "sensor_provider_priority" &&
          result.after.fields.priority,
      ).toBe(integer);
    }
    expect(() =>
      decodeFitnessCdc(source, {
        ...native,
        data: Buffer.from(native.data.toString().replace("2147483648", "9223372036854775808")),
      }),
    ).toThrow();
  });
  it("fails closed on malformed structural header schema, activity enum and numeric field", () => {
    const deletion = captures.find((d) => d.properties["__debezium.newkey"]);
    if (!deletion) throw new Error("Missing native PK header");
    const raw = JSON.parse(deletion.properties["__debezium.newkey"]);
    raw.schema.type = "unknown";
    expect(() =>
      decodeFitnessCdc(source, {
        ...deletion,
        properties: { ...deletion.properties, "__debezium.newkey": JSON.stringify(raw) },
      }),
    ).toThrow();
    expect(() =>
      decodeFitnessCdc(
        source,
        mutated((v) => {
          v.after.canonical_type = "unknown";
        }),
      ),
    ).toThrow();
    expect(() =>
      decodeFitnessCdc(
        source,
        mutated((v) => {
          v.after.perceived_exertion = "nonsense";
        }),
      ),
    ).toThrow();
  });
  it("rejects numeric JSON where a textual key or field is required", () => {
    const native = captures.find((d) => d.topic.endsWith(".provider_priority"));
    if (!native) throw new Error("Missing priority snapshot");
    expect(() =>
      decodeFitnessCdc(source, {
        ...native,
        key: '{"provider_id":123}',
        data: Buffer.from(native.data.toString().replaceAll('"cdc_fixture"', "123")),
      }),
    ).toThrow();
  });
  it("rejects unknown snapshot control fields and collections", () => {
    const native = captures[1];
    if (!native) throw new Error("Missing real notification");
    const value = JSON.parse(native.data.toString());
    value.additional_data.unknown = "unknown";
    expect(() =>
      decodeFitnessCdc(source, { ...native, data: Buffer.from(JSON.stringify(value)) }),
    ).toThrow();
    delete value.additional_data.unknown;
    value.additional_data.data_collections = "fitness.unknown";
    expect(() =>
      decodeFitnessCdc(source, { ...native, data: Buffer.from(JSON.stringify(value)) }),
    ).toThrow();
  });
  it.each(["1", "1.0", "1e0", "1.5"])("normalizes raw PG real token %s to a number", (token) => {
    const native = {
      ...update,
      data: Buffer.from(
        update.data
          .toString()
          .replaceAll('"perceived_exertion":null', `"perceived_exertion":${token}`),
      ),
    };
    const result = decodeFitnessCdc(source, native);
    if (result.kind !== "row" || result.after?.table !== "activity")
      throw new Error("Expected activity");
    expect(result.after.fields.perceived_exertion).toBe(Number(token));
    if (Number(token) === 1) {
      const canonical = decodeFitnessCdc(source, {
        ...update,
        data: Buffer.from(
          update.data.toString().replaceAll('"perceived_exertion":null', '"perceived_exertion":1'),
        ),
      });
      expect(result.stablePayload).toBe(canonical.kind === "row" && canonical.stablePayload);
    }
  });
  it("accepts literal marker substrings in notes and raw JSON but rejects the whole placeholder", () => {
    const literal = decodeFitnessCdc(
      source,
      mutated((v) => {
        v.after.notes = "literal __debezium_unavailable_value in notes";
        v.after.raw = '{"literal":"__debezium_unavailable_value"}';
      }),
    );
    expect(
      literal.kind === "row" && literal.after?.table === "activity" && literal.after.fields.notes,
    ).toBe("literal __debezium_unavailable_value in notes");
    expect(() =>
      decodeFitnessCdc(
        source,
        mutated((v) => {
          v.after.notes = "__debezium_unavailable_value";
        }),
      ),
    ).toThrow();
    expect(() =>
      decodeFitnessCdc(
        source,
        mutated((v) => {
          v.after.raw = "__debezium_unavailable_value";
        }),
      ),
    ).toThrow();
  });
});
