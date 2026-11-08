import { describe, expect, it, vi } from "vitest";
import type { AnalyticsQueryOwner } from "../analytics/analytics-query-owner.ts";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import type { Database } from "../db/index.ts";
import {
  assertNoClickHouseDetachedParts,
  classifyClickHouseManagedTableEngine,
  executeClickHousePhysicalErasure,
  prepareClickHousePhysicalBaseline,
  prepareClickHousePhysicalErasure,
  sealClickHousePhysicalErasure,
} from "./clickhouse-physical-erasure.ts";
import { AccountErasureIdentifierStore } from "./identifier-store.ts";
import type {
  AccountErasurePhysicalIntent,
  AccountErasurePhysicalProgress,
} from "./retained-state.ts";

describe("classifyClickHouseManagedTableEngine", () => {
  it.each([
    ["MaterializedView", "non-storage"],
    ["Null", "non-storage"],
    ["View", "non-storage"],
    ["MergeTree", "merge-tree"],
    ["ReplacingMergeTree", "merge-tree"],
    ["Memory", "unsupported-storage"],
  ] as const)("classifies %s", (engine, expected) => {
    expect(classifyClickHouseManagedTableEngine(engine)).toBe(expected);
  });
});

const stage = "initial";
const intentKey = "a".repeat(64),
  mutationKey = "b".repeat(64),
  partKey = "c".repeat(64);
const uuid = "10000000-0000-4000-8000-000000000001";
const intent: AccountErasurePhysicalIntent = [
  stage,
  "ingest",
  "metric_stream",
  uuid,
  "d".repeat(64),
  "user",
];
const predicate = {
  sql: "user_id={user_id:UUID}",
  mutationSql: "user_id={user_id:UUID}",
  queryParameters: { user_id: uuid },
  mutationQueryParameters: { user_id: uuid },
};
const part = Buffer.from("original_part").toString("base64"),
  mutation = Buffer.from("mutation_1").toString("base64");
const nameRow = (value: string) => ({ value, key: partKey });
type Answer = { label: string; rows: unknown };
const answer = (label: string, rows: unknown): Answer => ({ label, rows });
const countAnswer = (label: string, count = 0) => answer(label, [{ count }]);
function successAnswers(): Answer[] {
  return [
    countAnswer("detached"),
    countAnswer("initial-residue", 1),
    countAnswer("capture-detached"),
    countAnswer("capture-size"),
    answer("capture-names", [nameRow(part)]),
    countAnswer("prepare-history", 1),
    countAnswer("prepare-lineage-size"),
    answer("prepare-lineage-names", []),
    countAnswer("mutation-incomplete"),
    countAnswer("mutation-size"),
    answer("mutation-names", [nameRow(mutation)]),
    countAnswer("mutation-history", 1),
    countAnswer("mutation-parent-size"),
    answer("mutation-parent-names", []),
    countAnswer("mutation-residue"),
    countAnswer("applied-history", 1),
    countAnswer("applied-lineage-size"),
    answer("applied-lineage-names", []),
    countAnswer("final-detached"),
    countAnswer("final-residue"),
    answer("retained-base", [{ count: 0, state: "" }]),
    answer("retained-projection", [{ count: 0, state: "" }]),
    countAnswer("cleanup-count", 1),
    countAnswer("cleanup-incomplete"),
    countAnswer("cleanup-after"),
  ];
}
/** Literal dependency responses and retained-metadata transitions, never SQL execution. */
function fixture(answers = successAnswers()) {
  const trace: string[] = [];
  const database: Pick<Database, "execute" | "transaction"> = {
    execute: async () => {
      throw new Error("Unexpected database execution in unit test");
    },
    transaction: async () => {
      throw new Error("Unexpected database transaction in unit test");
    },
  };
  const store = new AccountErasureIdentifierStore(database, {
    requestId: uuid,
    leaseOwner: "unit-owner",
    pageSize: 64,
  });
  let progress: AccountErasurePhysicalProgress | null = {
    step: "apply",
    afterIntentKey: null,
    pending: null,
  };
  const mutationEntries: Array<{ key: string; value: unknown }> = [];
  const retained = {
    intent: [{ key: intentKey, value: intent }],
    part: [{ key: partKey, value: [stage, intent[1], intent[2], uuid, part] }],
    mutation: mutationEntries,
  };
  const load = vi
    .spyOn(store, "loadPhysicalProgress")
    .mockImplementation(async () => structuredClone(progress));
  const readPage = vi
    .spyOn(store, "readPhysicalPage")
    .mockImplementation(async (family, _stage, after) => {
      const entries = (
        String(family) === "physical_intent"
          ? retained.intent
          : String(family) === "physical_part"
            ? retained.part
            : retained.mutation
      ).filter((entry) => !after || entry.key > after);
      return JSON.parse(JSON.stringify({ entries, nextCursor: null }));
    });
  const readEntry = vi
    .spyOn(store, "readPhysicalEntry")
    .mockImplementation(async (_family, _stage, key) =>
      JSON.parse(JSON.stringify(retained.intent.find((entry) => entry.key === key) ?? null)),
    );
  const append = vi
    .spyOn(store, "appendPhysical")
    .mockImplementation(async (family, _stage, values) => {
      trace.push(`append:${family}`);
      if (String(family) === "physical_mutation")
        retained.mutation = [{ key: mutationKey, value: values[0] }];
      return false;
    });
  const start = vi.spyOn(store, "startPhysicalIntent").mockImplementation(async () => {
    trace.push("start");
    if (progress?.step !== "apply") throw new Error("Unexpected fixture stage");
    progress = {
      ...progress,
      pending: progress.pending ?? { intentKey, admitted: false, mutationKey: null },
    };
  });
  const admit = vi.spyOn(store, "admitPhysicalIntent").mockImplementation(async () => {
    trace.push("admit");
    if (progress?.step !== "apply" || !progress.pending)
      throw new Error("Unexpected fixture admission");
    progress = { ...progress, pending: { ...progress.pending, admitted: true } };
    return true;
  });
  const finishIntent = vi.spyOn(store, "finishPhysicalIntent").mockImplementation(async () => {
    trace.push("finish-intent");
    progress = { step: "apply", afterIntentKey: intentKey, pending: null };
  });
  const finishApply = vi.spyOn(store, "finishPhysicalApply").mockImplementation(async () => {
    trace.push("finish-apply");
    progress = { step: "physical" };
  });
  const complete = vi.spyOn(store, "markPhysicalComplete").mockImplementation(async () => {
    trace.push("durable-complete");
    progress = { step: "cleanup", afterMutationKey: null };
  });
  const retire = vi.spyOn(store, "retirePhysicalMutation").mockImplementation(async () => {
    trace.push("retire-mutation");
    progress = { step: "cleanup", afterMutationKey: mutationKey };
  });
  const finishCleanup = vi.spyOn(store, "finishPhysicalCleanup").mockImplementation(async () => {
    trace.push("finish-cleanup");
    progress = { step: "complete" };
  });
  const seal = vi.spyOn(store, "sealPhysicalPlan").mockImplementation(async () => {
    trace.push("seal");
  });
  const command = vi.fn<ClickHouseClient["command"]>().mockImplementation(async (options) => {
    trace.push(
      options.query.startsWith("ALTER TABLE")
        ? "delete"
        : options.query.startsWith("KILL MUTATION")
          ? "kill"
          : "flush",
    );
  });
  const query = vi.fn(async (_options: Parameters<ClickHouseClient["query"]>[0]) => {
    const next = answers.shift();
    if (!next) throw new Error("Unexpected query beyond literal unit responses");
    trace.push(`query:${next.label}`);
    return { json: async () => JSON.parse(JSON.stringify(next.rows)) };
  });
  const owner: Pick<AnalyticsQueryOwner, "client" | "assertActive"> = {
    client: { command, query },
    assertActive: vi.fn(async () => {
      trace.push("active");
    }),
  };
  const resolveIntent = vi
    .fn<Parameters<typeof executeClickHousePhysicalErasure>[3]>()
    .mockImplementation(async (value) => {
      trace.push("resolve");
      return { intent: value, predicate };
    });
  const assertSchema = vi.fn(async () => {
    trace.push("schema");
  });
  const options = { pollIntervalMilliseconds: 0, waitTimeoutMilliseconds: 0, maximumPasses: 2 };
  return {
    store,
    owner,
    trace,
    answers,
    load,
    readPage,
    readEntry,
    append,
    start,
    admit,
    finishIntent,
    finishApply,
    complete,
    retire,
    finishCleanup,
    seal,
    command,
    query,
    resolveIntent,
    assertSchema,
    options,
    setProgress(value: AccountErasurePhysicalProgress | null) {
      progress = value;
    },
    getProgress: () => progress,
    execute: () =>
      executeClickHousePhysicalErasure(owner, store, stage, resolveIntent, assertSchema, options),
  };
}

describe("executeClickHousePhysicalErasure orchestration", () => {
  it("persists retained proof before mutation and global completion before metadata cleanup", async () => {
    const state = fixture();
    await state.execute();
    expect(state.answers).toEqual([]);
    expect(state.trace.indexOf("append:physical_part")).toBeLessThan(state.trace.indexOf("admit"));
    expect(state.trace.indexOf("query:prepare-history")).toBeLessThan(state.trace.indexOf("admit"));
    expect(state.trace.indexOf("admit")).toBeLessThan(state.trace.indexOf("delete"));
    expect(state.trace.indexOf("append:physical_mutation")).toBeLessThan(
      state.trace.indexOf("finish-intent"),
    );
    expect(state.trace.indexOf("durable-complete")).toBeLessThan(state.trace.indexOf("kill"));
    expect(state.trace.indexOf("query:cleanup-after")).toBeLessThan(
      state.trace.indexOf("retire-mutation"),
    );
    expect(state.command).toHaveBeenCalledWith({
      query: `ALTER TABLE \`ingest\`.\`metric_stream\` DELETE WHERE (${predicate.mutationSql}) AND '${intentKey}'='${intentKey}'`,
      query_params: predicate.mutationQueryParameters,
      clickhouse_settings: { log_queries: 0, mutations_sync: "2" },
    });
    expect(state.start).toHaveBeenCalledWith(stage, { expectedAfterKey: null, intentKey });
    expect(state.retire).toHaveBeenCalledWith(stage, { key: mutationKey, expectedAfterKey: null });
    expect(state.getProgress()).toEqual({ step: "complete" });
  });
  it("leaves admitted intent pending when the destructive request fails", async () => {
    const state = fixture();
    state.command.mockImplementation(async (options) => {
      if (options.query.startsWith("ALTER TABLE")) throw new Error("unknown mutation outcome");
    });
    await expect(state.execute()).rejects.toThrow("unknown mutation outcome");
    expect(state.getProgress()).toMatchObject({
      step: "apply",
      pending: { intentKey, admitted: true },
    });
    expect(state.finishIntent).not.toHaveBeenCalled();
    expect(state.complete).not.toHaveBeenCalled();
    expect(state.retire).not.toHaveBeenCalled();
  });
  it("recovers an already admitted pending intent without submitting another deletion", async () => {
    const answers = successAnswers();
    answers.splice(1, 7);
    const state = fixture(answers);
    state.setProgress({
      step: "apply",
      afterIntentKey: null,
      pending: { intentKey, admitted: true, mutationKey: null },
    });
    await state.execute();
    expect(state.readEntry).toHaveBeenCalledWith("physical_intent", stage, intentKey);
    expect(state.admit).not.toHaveBeenCalled();
    expect(state.trace).not.toContain("delete");
    expect(state.complete).toHaveBeenCalledOnce();
    expect(state.finishCleanup).toHaveBeenCalledOnce();
  });
  it.each(["schema", "UUID"])("rejects %s drift before admission or deletion", async (kind) => {
    const state = fixture();
    if (kind === "schema") state.assertSchema.mockRejectedValue(new Error("schema changed"));
    else state.resolveIntent.mockRejectedValue(new Error("UUID changed"));
    await expect(state.execute()).rejects.toThrow("changed");
    expect(state.start).not.toHaveBeenCalled();
    expect(state.admit).not.toHaveBeenCalled();
    expect(state.command).not.toHaveBeenCalled();
  });
  it("rejects execution without a sealed prepared plan", async () => {
    const state = fixture();
    state.setProgress(null);
    await expect(state.execute()).rejects.toThrow("not prepared");
    expect(state.command).not.toHaveBeenCalled();
  });
  it.each([
    "detached",
    "mutation-incomplete",
    "mutation-history",
    "mutation-residue",
    "final-detached",
    "final-residue",
    "retained-base",
    "retained-projection",
  ])("blocks global completion when %s evidence fails", async (label) => {
    const answers = successAnswers();
    const target = answers.find((value) => value.label === label);
    if (!target) throw new Error("Missing response fixture");
    target.rows =
      label === "mutation-history"
        ? [{ count: 0 }]
        : label.startsWith("retained")
          ? [{ count: 1, state: "Deleting" }]
          : [{ count: 1 }];
    const state = fixture(answers);
    await expect(state.execute()).rejects.toThrow();
    expect(state.complete).not.toHaveBeenCalled();
    expect(state.retire).not.toHaveBeenCalled();
    expect(state.trace).not.toContain("kill");
  });
  it("waits out one incomplete native mutation poll before accepting completion", async () => {
    const answers = successAnswers();
    const incompleteIndex = answers.findIndex((value) => value.label === "mutation-incomplete");
    if (incompleteIndex < 0) throw new Error("Missing mutation-incomplete fixture");
    answers.splice(
      incompleteIndex,
      1,
      countAnswer("mutation-incomplete-first", 1),
      countAnswer("mutation-incomplete-cleared", 0),
    );
    const state = fixture(answers);
    state.options.waitTimeoutMilliseconds = 60_000;
    state.options.pollIntervalMilliseconds = 0;
    await state.execute();
    expect(state.trace).toContain("query:mutation-incomplete-first");
    expect(state.trace).toContain("query:mutation-incomplete-cleared");
    expect(state.complete).toHaveBeenCalledOnce();
  });
  it("times out when the native mutation stays incomplete through the wait budget", async () => {
    const answers = successAnswers();
    const incomplete = answers.find((value) => value.label === "mutation-incomplete");
    if (!incomplete) throw new Error("Missing mutation-incomplete fixture");
    incomplete.rows = [{ count: 1 }];
    const state = fixture(answers);
    state.options.waitTimeoutMilliseconds = 0;
    state.options.pollIntervalMilliseconds = 0;
    await expect(state.execute()).rejects.toThrow("native mutation is incomplete");
    expect(state.complete).not.toHaveBeenCalled();
  });
  it("passes database and table identity when proving detached parts are absent", async () => {
    const state = fixture([countAnswer("detached")]);
    await assertNoClickHouseDetachedParts(state.owner, {
      database: "ingest",
      name: "metric_stream",
    });
    expect(state.query).toHaveBeenCalledWith(
      expect.objectContaining({
        query_params: { database: "ingest", table: "metric_stream" },
      }),
    );
  });
  it("requires recorded mutation evidence to recover an admitted request", async () => {
    const answers = successAnswers();
    const row = answers.find((value) => value.label === "mutation-names");
    if (row) row.rows = [];
    const state = fixture(answers);
    await expect(state.execute()).rejects.toThrow("admitted mutation evidence");
    expect(state.finishIntent).not.toHaveBeenCalled();
    expect(state.complete).not.toHaveBeenCalled();
  });
  it.each(["cleanup-count", "cleanup-incomplete", "cleanup-after"])(
    "does not retire metadata when %s is unsafe",
    async (label) => {
      const answers = successAnswers();
      const row = answers.find((value) => value.label === label);
      if (row) row.rows = [{ count: label === "cleanup-count" ? 2 : 1 }];
      const state = fixture(answers);
      await expect(state.execute()).rejects.toThrow();
      expect(state.complete).toHaveBeenCalledOnce();
      expect(state.retire).not.toHaveBeenCalled();
    },
  );
  it("leaves metadata retirement pending after a failed kill request", async () => {
    const state = fixture();
    state.command.mockImplementation(async (options) => {
      if (options.query.startsWith("KILL MUTATION")) throw new Error("kill failed");
    });
    await expect(state.execute()).rejects.toThrow("kill failed");
    expect(state.getProgress()).toEqual({ step: "cleanup", afterMutationKey: null });
    expect(state.retire).not.toHaveBeenCalled();
  });
});

describe("physical erasure preparation and proof boundaries", () => {
  it("persists the frozen intent before retaining matching parts", async () => {
    const state = fixture([
      countAnswer("detached"),
      countAnswer("size"),
      answer("names", [nameRow(part)]),
    ]);
    await prepareClickHousePhysicalErasure(state.owner, state.store, { intent, predicate });
    expect(state.append).toHaveBeenNthCalledWith(1, "physical_intent", stage, [intent]);
    expect(state.append).toHaveBeenNthCalledWith(2, "physical_part", stage, [
      [stage, "ingest", "metric_stream", uuid, part],
    ]);
    expect(state.trace.indexOf("append:physical_intent")).toBeLessThan(
      state.trace.indexOf("query:detached"),
    );
    expect(state.command).not.toHaveBeenCalled();
    expect(
      state.query.mock.calls.every(([request]) => request.clickhouse_settings?.log_queries === 0),
    ).toBe(true);
  });
  it("captures both base and projection retained part identities", async () => {
    const projection = Buffer.from("projection_parent").toString("base64");
    const state = fixture([
      countAnswer("detached"),
      countAnswer("base-size"),
      answer("base-names", [nameRow(part)]),
      countAnswer("projection-size"),
      answer("projection-names", [nameRow(projection)]),
    ]);
    await prepareClickHousePhysicalBaseline(state.owner, state.store, intent);
    expect(state.append.mock.calls.map(([_family, _stage, values]) => values)).toEqual([
      [[stage, "ingest", "metric_stream", uuid, part]],
      [[stage, "ingest", "metric_stream", uuid, projection]],
    ]);
    expect(state.query.mock.calls[1]?.[0].query_params).toEqual({
      database: "ingest",
      table: "metric_stream",
      table_uuid: uuid,
    });
  });
  it.each(
    [
      [nameRow("%%%")],
      [{ value: part, key: `x${partKey}` }],
      [{ value: part, key: `${partKey}x` }],
      [{ value: part, key: "A".repeat(64) }],
      [{ value: part, key: "a" }],
      Array.from({ length: 65 }, () => nameRow(part)),
    ].map((rows) => ({ rows })),
  )("rejects malformed or oversized native name pages before retention", async ({ rows }) => {
    const state = fixture([countAnswer("detached"), countAnswer("size"), answer("names", rows)]);
    await expect(
      prepareClickHousePhysicalErasure(state.owner, state.store, { intent, predicate }),
    ).rejects.toThrow();
    expect(state.append).toHaveBeenCalledTimes(1);
    expect(state.admit).not.toHaveBeenCalled();
    expect(state.command).not.toHaveBeenCalled();
  });
  it.each(
    [[{ count: -1 }], [{ count: 1.5 }], [], [{ count: 0 }, { count: 0 }]].map((rows) => ({ rows })),
  )("rejects an invalid detached-part count response", async ({ rows }) => {
    const state = fixture([answer("detached", rows)]);
    await expect(
      prepareClickHousePhysicalErasure(state.owner, state.store, { intent, predicate }),
    ).rejects.toThrow();
    expect(state.append).toHaveBeenCalledTimes(1);
  });
  it("blocks a native name exceeding its declared domain before reading a page", async () => {
    const state = fixture([countAnswer("detached"), countAnswer("size", 1)]);
    await expect(
      prepareClickHousePhysicalErasure(state.owner, state.store, { intent, predicate }),
    ).rejects.toThrow("4 KiB");
    expect(state.query).toHaveBeenCalledTimes(2);
    expect(state.append).toHaveBeenCalledTimes(1);
  });
  it("accepts exact decoded-page bounds and ClickHouse string count responses", async () => {
    const value = Buffer.alloc(4096, 97).toString("base64");
    const state = fixture([
      answer("detached", [{ count: "0" }]),
      answer("size", [{ count: "0" }]),
      answer(
        "full-page",
        Array.from({ length: 64 }, () => nameRow(value)),
      ),
      answer("end", []),
    ]);
    await prepareClickHousePhysicalErasure(state.owner, state.store, { intent, predicate });
    expect(state.append.mock.calls[1]?.[2]).toHaveLength(64);
    expect(state.answers).toEqual([]);
  });
  it("blocks decoded native name pages exceeding the byte budget", async () => {
    const value = Buffer.alloc(4097, 97).toString("base64");
    const state = fixture([
      countAnswer("detached"),
      countAnswer("size"),
      answer(
        "names",
        Array.from({ length: 64 }, () => nameRow(value)),
      ),
    ]);
    await expect(
      prepareClickHousePhysicalErasure(state.owner, state.store, { intent, predicate }),
    ).rejects.toThrow("byte budget");
    expect(state.append).toHaveBeenCalledTimes(1);
  });
  it("retains exact full pages and advances only by the returned fixed-width cursor", async () => {
    const rows = Array.from({ length: 64 }, (_value, index) => ({
      value: Buffer.from(`part_${index}`).toString("base64"),
      key: index.toString(16).padStart(64, "0"),
    }));
    const state = fixture([
      countAnswer("detached"),
      countAnswer("size"),
      answer("page", rows),
      answer("end", []),
    ]);
    await prepareClickHousePhysicalErasure(state.owner, state.store, { intent, predicate });
    expect(state.append).toHaveBeenCalledTimes(2);
    expect(state.append.mock.calls[1]?.[2]).toHaveLength(64);
    expect(state.query.mock.calls[3]?.[0].query_params).toMatchObject({
      physical_after: rows[63]?.key,
    });
  });
  it("flushes and resolves retained UUID lineage before sealing the schema digest", async () => {
    const state = fixture([
      countAnswer("history", 1),
      countAnswer("lineage-size"),
      answer("lineage", []),
    ]);
    await sealClickHousePhysicalErasure(state.owner, state.store, stage, "e".repeat(64), 2);
    expect(state.trace.indexOf("flush")).toBeLessThan(state.trace.indexOf("query:history"));
    expect(state.trace.indexOf("query:lineage")).toBeLessThan(state.trace.indexOf("seal"));
    expect(state.query.mock.calls[0]?.[0].query_params).toMatchObject({
      database: "ingest",
      table: "metric_stream",
      table_uuid: uuid,
      part_hashes: [expect.stringMatching(/^[a-f0-9]{64}$/)],
    });
    expect(state.seal).toHaveBeenCalledWith(stage, "e".repeat(64));
  });
  it("refuses to seal when retained lineage history is missing", async () => {
    const state = fixture([countAnswer("history", 0)]);
    await expect(
      sealClickHousePhysicalErasure(state.owner, state.store, stage, "e".repeat(64), 2),
    ).rejects.toThrow("history is incomplete");
    expect(state.seal).not.toHaveBeenCalled();
  });
  it("refuses to seal a lineage that keeps growing through the finite pass bound", async () => {
    const state = fixture([
      countAnswer("history", 1),
      countAnswer("lineage-size"),
      answer("lineage", [nameRow(part)]),
    ]);
    state.append.mockResolvedValue(true);
    await expect(
      sealClickHousePhysicalErasure(state.owner, state.store, stage, "e".repeat(64), 1),
    ).rejects.toThrow("did not converge");
    expect(state.seal).not.toHaveBeenCalled();
  });
});

describe("physical erasure durable recovery boundaries", () => {
  it("does not mutate when durable retained-part recording fails", async () => {
    const state = fixture();
    state.append.mockRejectedValue(new Error("retained proof persistence failed"));
    await expect(state.execute()).rejects.toThrow("retained proof persistence failed");
    expect(state.admit).not.toHaveBeenCalled();
    expect(state.trace).not.toContain("delete");
    expect(state.getProgress()).toMatchObject({
      step: "apply",
      pending: { intentKey, admitted: false },
    });
  });
  it("recovers evidence instead of mutating when durable admission was already won", async () => {
    const state = fixture();
    state.admit.mockResolvedValue(false);
    await state.execute();
    expect(state.trace).not.toContain("delete");
    expect(state.complete).toHaveBeenCalledOnce();
  });
  it("does not submit a mutation for an empty logical target but still proves retained parts gone", async () => {
    const responses = successAnswers();
    responses.splice(2, 13);
    responses[1] = { label: "initial-residue", rows: [{ count: 0 }] };
    responses.splice(-3);
    const state = fixture(responses);
    await state.execute();
    expect(state.admit).not.toHaveBeenCalled();
    expect(state.trace).not.toContain("delete");
    expect(state.trace).toContain("query:retained-base");
    expect(state.complete).toHaveBeenCalledOnce();
    expect(state.finishCleanup).toHaveBeenCalledOnce();
  });
  it("does not complete when schema validation fails at the global physical proof", async () => {
    const state = fixture();
    state.assertSchema
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("schema changed after apply"));
    await expect(state.execute()).rejects.toThrow("schema changed after apply");
    expect(state.complete).not.toHaveBeenCalled();
    expect(state.getProgress()).toEqual({ step: "physical" });
  });
  it("does not clean native metadata without a durable global certificate", async () => {
    const state = fixture();
    state.setProgress({ step: "apply", afterIntentKey: null, pending: null });
    state.finishApply.mockImplementation(async () => {
      state.setProgress({ step: "apply", afterIntentKey: intentKey, pending: null });
    });
    await expect(state.execute()).rejects.toThrow("requires durable global physical completion");
    expect(state.trace).not.toContain("kill");
    expect(state.retire).not.toHaveBeenCalled();
  });
  it("requires the frozen parent intent before native mutation cleanup", async () => {
    const state = fixture();
    state.readEntry.mockResolvedValue(null);
    await expect(state.execute()).rejects.toThrow("lost its frozen physical intent");
    expect(state.complete).toHaveBeenCalledOnce();
    expect(state.trace).not.toContain("kill");
    expect(state.retire).not.toHaveBeenCalled();
  });
  it("can retire already absent native metadata after proving it remains absent", async () => {
    const responses = successAnswers();
    const before = responses.find((row) => row.label === "cleanup-count");
    if (!before) throw new Error("Missing cleanup fixture");
    before.rows = [{ count: 0 }];
    responses.splice(
      responses.findIndex((row) => row.label === "cleanup-incomplete"),
      1,
    );
    const state = fixture(responses);
    await state.execute();
    expect(state.trace).not.toContain("kill");
    expect(state.retire).toHaveBeenCalledWith(stage, { key: mutationKey, expectedAfterKey: null });
  });
  it("keeps cleanup cursor pending when durable retirement fails", async () => {
    const state = fixture();
    state.retire.mockRejectedValue(new Error("retirement persistence failed"));
    await expect(state.execute()).rejects.toThrow("retirement persistence failed");
    expect(state.getProgress()).toEqual({ step: "cleanup", afterMutationKey: null });
    expect(state.finishCleanup).not.toHaveBeenCalled();
  });
  it("does not query or advance when owner activity is lost at admission", async () => {
    const state = fixture();
    vi.mocked(state.owner.assertActive).mockRejectedValue(new Error("owner lost"));
    await expect(state.execute()).rejects.toThrow("owner lost");
    expect(state.load).not.toHaveBeenCalled();
    expect(state.command).not.toHaveBeenCalled();
  });
});
