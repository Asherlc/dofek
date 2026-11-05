import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import { createDatabase } from "../db/index.ts";
import type { AccountErasureSharedUserLocks } from "../jobs/account-erasure-work-guard.ts";
import { runBoundedAnalyticsPage } from "./bounded-analytics.ts";
import type { AnalyticsEffect } from "./effect-journal.ts";

const mocks = vi.hoisted(() => ({
  compile: vi.fn(),
  read: vi.fn(),
  append: vi.fn(),
  verify: vi.fn(),
  checkpoint: vi.fn(),
  load: vi.fn(),
  claim: vi.fn(),
  pending: vi.fn(),
  accounts: vi.fn(),
  owner: vi.fn(),
  report: vi.fn(),
  admit: vi.fn(),
  empty: vi.fn(),
  complete: vi.fn(),
  capture: vi.fn(),
}));
vi.mock("./analytics-model-compiler.ts", () => ({ compileAnalyticsPageSql: mocks.compile }));
vi.mock("./analytics-work-store.ts", () => ({
  loadAnalyticsPageState: mocks.load,
  claimAnalyticsRunOwnership: mocks.claim,
  checkpointAnalyticsPage: mocks.checkpoint,
  loadAnalyticsPublicationIntent: mocks.pending,
  assertAnalyticsPageAccountsActive: mocks.accounts,
  admitAnalyticsPage: mocks.admit,
  completeAnalyticsEmptyPage: mocks.empty,
  markAnalyticsPageOutputComplete: mocks.complete,
  captureAnalyticsPage: mocks.capture,
}));
vi.mock("./analytics-query-owner.ts", () => ({
  ANALYTICS_PUBLICATION_RESOURCE: "metric-stream-source",
  withAnalyticsQueryOwner: mocks.owner,
}));
vi.mock("./effect-journal.ts", async (original) => ({
  ...(await original<typeof import("./effect-journal.ts")>()),
  readAnalyticsEffectPage: mocks.read,
  appendAnalyticsEffects: mocks.append,
  verifyAnalyticsEffectPage: mocks.verify,
}));
vi.mock("../lib/error-reporting.ts", () => ({ captureException: mocks.report }));

const database = createDatabase("postgres://unit:unit@localhost/unit");
afterAll(async () => database.$client.end());
const stream = { transport: "kafka" as const, epoch: "unit", topic: "sensor", partition: 0 };
const effect: AnalyticsEffect = {
  stream,
  position: { ...stream, transport: "kafka", offset: "5" },
  cursor: { delivery: { offset: "5" }, effectOrdinal: "0" },
  stage: "scalar",
  operationId: null,
  sourceId: "10000000-0000-4000-8000-000000000001",
  sourceVersion: "2",
  generation: "0",
  before: null,
  after: {
    sourceId: "10000000-0000-4000-8000-000000000001",
    userId: "20000000-0000-4000-8000-000000000001",
    providerId: "test",
    sourceVersion: "2",
    generation: "0",
    activityId: null,
    deleted: false,
    key: {
      userId: "20000000-0000-4000-8000-000000000001",
      channel: "power",
      recordedAt: "2026-11-04T00:00:00Z",
    },
  },
};

describe("bounded scalar executor", () => {
  const order: string[] = [];
  const command = vi.fn(async () => {
    order.push("output");
  });
  const clickhouse: ClickHouseClient = {
    command,
    query: async () => ({ json: async () => [] }),
    insert: async () => undefined,
  };
  const guards: AccountErasureSharedUserLocks = {
    runWithSharedUserLocks: async (_ids, work) => {
      order.push("guard");
      try {
        return await work();
      } finally {
        order.push("released");
      }
    },
  };
  const input = {
    runId: randomUUID(),
    stage: "scalar" as const,
    stream,
    pageSize: 20,
    artifactDirectory: "/tmp/unit-artifacts",
  };
  beforeEach(() => {
    vi.resetAllMocks();
    order.length = 0;
    command.mockImplementation(async () => {
      order.push("output");
    });
    mocks.pending.mockResolvedValue(null);
    mocks.load.mockResolvedValue({ ownerId: null, cursor: null });
    mocks.admit.mockResolvedValue({
      after: null,
      pageSize: 20,
      publicationRevision: "1793750400000001",
      state: "pending",
      next: null,
    });
    mocks.owner.mockImplementation(async (_database, _client, _input, operation) =>
      operation({
        client: clickhouse,
        ingestedAt: "2026-11-04T00:00:00.000001Z",
        publicationRevision: "1793750400000001",
        assertActive: async () => undefined,
      }),
    );
    mocks.read.mockResolvedValue({ effects: [effect], next: effect.cursor, exhausted: true });
    mocks.compile.mockResolvedValue({
      sql: "SELECT fixture",
      relation: "`analytics`.`sensor_scalar_sample`",
    });
    mocks.accounts.mockImplementation(async () => {
      order.push("account-check");
    });
    mocks.append.mockImplementation(async () => {
      order.push("effects");
    });
    mocks.verify.mockImplementation(async () => {
      order.push("verified");
    });
    mocks.checkpoint.mockImplementation(async () => {
      order.push("cursor");
    });
  });
  it("publishes scalar output and verified dedup effects before its cursor", async () => {
    await expect(runBoundedAnalyticsPage({ database, clickhouse, guards }, input)).resolves.toEqual(
      {
        progressed: true,
        remaining: false,
      },
    );
    expect(order).toEqual([
      "guard",
      "account-check",
      "output",
      "effects",
      "verified",
      "cursor",
      "released",
    ]);
    expect(mocks.append.mock.calls[0]?.[1]).toEqual([{ ...effect, stage: "dedup" }]);
    expect(mocks.compile.mock.calls[0]?.[0].vars.analytics_publication_revision).toBe(
      "1793750400000001",
    );
  });
  it("reports a visible failed page without publishing effects or checkpointing after memory failure", async () => {
    command.mockRejectedValueOnce(
      Object.assign(new Error("Memory limit exceeded"), { code: "241" }),
    );
    await expect(
      runBoundedAnalyticsPage({ database, clickhouse, guards }, input),
    ).rejects.toMatchObject({
      state: "failed",
      runId: input.runId,
      stage: "scalar",
      cause: { code: "241" },
    });
    expect(order).toEqual(["guard", "account-check", "released"]);
    expect(mocks.report).toHaveBeenCalled();
  });
  it("rechecks account activation after page discovery before dispatch", async () => {
    mocks.accounts.mockRejectedValueOnce(new Error("Account erasure is active"));
    await expect(
      runBoundedAnalyticsPage({ database, clickhouse, guards }, input),
    ).rejects.toMatchObject({
      state: "failed",
    });
    expect(order).toEqual(["guard", "released"]);
  });
  it("withholds the checkpoint if downstream publication cannot be verified", async () => {
    mocks.verify.mockRejectedValueOnce(new Error("Missing downstream receipt"));
    await expect(
      runBoundedAnalyticsPage({ database, clickhouse, guards }, input),
    ).rejects.toMatchObject({
      state: "failed",
    });
    expect(order).toEqual(["guard", "account-check", "output", "effects", "released"]);
  });
  it("uses the durable pending page revision after another owner reservation", async () => {
    mocks.admit.mockResolvedValueOnce({
      after: null,
      pageSize: 1,
      publicationRevision: "17",
      state: "pending",
      next: null,
    });
    await runBoundedAnalyticsPage({ database, clickhouse, guards }, input);
    expect(mocks.compile.mock.calls[0]?.[0].vars.analytics_publication_revision).toBe("17");
    expect(mocks.read.mock.calls[0]?.[1].limit).toBe(1);
  });
  it("recovers a proved attempt by verifying receipts and committing its cursor without republishing", async () => {
    mocks.admit.mockResolvedValueOnce({
      after: null,
      pageSize: 20,
      publicationRevision: "17",
      state: "pending",
      next: null,
      outputComplete: true,
    });
    await runBoundedAnalyticsPage({ database, clickhouse, guards }, input);
    expect(order).toEqual(["guard", "account-check", "verified", "cursor", "released"]);
    expect(mocks.checkpoint.mock.calls[0]?.[1].publicationRevision).toBe("17");
  });
});
