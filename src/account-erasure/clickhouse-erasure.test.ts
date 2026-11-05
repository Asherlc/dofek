import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClickHouseCommandClient } from "../db/clickhouse.ts";
import type { PhysicalTable } from "./clickhouse-erasure-coverage.ts";
import {
  clickHouseAccountErasurePredicates,
  eraseClickHouseAccount,
  fenceClickHouseAccount,
  prepareClickHouseAccountErasure,
  prepareClickHouseAccountErasureIdentifiers,
} from "./clickhouse-erasure.ts";
import type { AccountErasureIdentifierStore } from "./identifier-store.ts";

const userId = "10000000-0000-4000-8000-000000001994";
const operationId = "20000000-0000-4000-8000-000000001994";
const activityId = "30000000-0000-4000-8000-000000001994";
const tableUuid = "40000000-0000-4000-8000-000000001994";

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  readIdentifierPage: vi.fn(),
  assertDetached: vi.fn(),
  executePhysical: vi.fn(),
  prepareBaseline: vi.fn(),
  preparePhysical: vi.fn(),
  sealPhysical: vi.fn(),
}));

vi.mock("./clickhouse-erasure-coverage.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./clickhouse-erasure-coverage.ts")>();
  return {
    ...actual,
    inspectClickHouseAccountErasureCoverage: mocks.inspect,
  };
});

vi.mock("./clickhouse-identifier-pages.ts", () => ({
  readClickHouseErasureIdentifierPage: mocks.readIdentifierPage,
}));

vi.mock("./clickhouse-physical-erasure.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./clickhouse-physical-erasure.ts")>();
  return {
    ...actual,
    assertNoClickHouseDetachedParts: mocks.assertDetached,
    executeClickHousePhysicalErasure: mocks.executePhysical,
    prepareClickHousePhysicalBaseline: mocks.prepareBaseline,
    prepareClickHousePhysicalErasure: mocks.preparePhysical,
    sealClickHousePhysicalErasure: mocks.sealPhysical,
  };
});

function physicalTable(
  overrides: Partial<PhysicalTable> & Pick<PhysicalTable, "name" | "columns">,
): PhysicalTable {
  return {
    database: "analytics",
    engine: "MergeTree",
    uuid: tableUuid,
    age_milliseconds: 3_600_000,
    ...overrides,
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createStore(
  overrides: Partial<{
    beginClosure: ReturnType<typeof vi.fn>;
    sealClosure: ReturnType<typeof vi.fn>;
    assertClosureComplete: ReturnType<typeof vi.fn>;
    append: ReturnType<typeof vi.fn>;
    readPage: ReturnType<typeof vi.fn>;
    loadPhysicalProgress: ReturnType<typeof vi.fn>;
    assertPhysicalPlanPrepared: ReturnType<typeof vi.fn>;
  }> = {},
) {
  return {
    beginClosure: overrides.beginClosure ?? vi.fn(async () => true),
    sealClosure: overrides.sealClosure ?? vi.fn(async () => undefined),
    assertClosureComplete: overrides.assertClosureComplete ?? vi.fn(async () => undefined),
    append: overrides.append ?? vi.fn(async () => false),
    readPage:
      overrides.readPage ??
      vi.fn(async () => ({
        entries: [] as Array<{ key: string; value: string }>,
        nextCursor: null as string | null,
      })),
    loadPhysicalProgress: overrides.loadPhysicalProgress ?? vi.fn(async () => null),
    assertPhysicalPlanPrepared:
      overrides.assertPhysicalPlanPrepared ?? vi.fn(async () => undefined),
  } satisfies Pick<
    AccountErasureIdentifierStore,
    | "beginClosure"
    | "sealClosure"
    | "assertClosureComplete"
    | "append"
    | "readPage"
    | "loadPhysicalProgress"
    | "assertPhysicalPlanPrepared"
  >;
}

function createOwner(queryImpl?: ClickHouseCommandClient["query"]) {
  const assertActive = vi.fn(async () => undefined);
  const command = vi.fn(async () => undefined);
  const insert = vi.fn(async () => undefined);
  const query =
    queryImpl ??
    vi.fn(async () => ({
      json: async () => [{ count: 0 }],
    }));
  return {
    assertActive,
    client: { command, insert, query },
  };
}

async function collectPredicates(
  table: PhysicalTable,
  store: Pick<AccountErasureIdentifierStore, "readPage">,
) {
  const predicates = [];
  for await (const predicate of clickHouseAccountErasurePredicates(table, userId, store)) {
    predicates.push(predicate);
  }
  return predicates;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inspect.mockResolvedValue([]);
  mocks.readIdentifierPage.mockResolvedValue({ values: [], nextCursor: null });
  mocks.assertDetached.mockResolvedValue(undefined);
  mocks.executePhysical.mockResolvedValue(undefined);
  mocks.prepareBaseline.mockResolvedValue(undefined);
  mocks.preparePhysical.mockResolvedValue(undefined);
  mocks.sealPhysical.mockResolvedValue(undefined);
});

describe("fenceClickHouseAccount", () => {
  it("rejects an oversized caller page before admitting any fence", async () => {
    const command = vi.fn<ClickHouseCommandClient["command"]>(async () => undefined);
    const insert = vi.fn<NonNullable<ClickHouseCommandClient["insert"]>>(async () => undefined);
    await expect(
      fenceClickHouseAccount(
        { command, insert, query: async () => ({ json: async () => [] }) },
        userId,
        Array.from({ length: 501 }, () => operationId),
      ),
    ).rejects.toMatchObject({ name: "AccountErasureIdentifierBudgetError" });
    expect(command).not.toHaveBeenCalled();
  });

  it("fences exact user and operation hashes, deduplicating its bounded input", async () => {
    const command = vi.fn<ClickHouseCommandClient["command"]>(async () => undefined);
    const insert = vi.fn<NonNullable<ClickHouseCommandClient["insert"]>>(async () => undefined);
    await fenceClickHouseAccount(
      { command, insert, query: async () => ({ json: async () => [] }) },
      userId,
      [operationId, operationId],
    );
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        query_params: { user_hash: hash(userId) },
      }),
    );
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        values: [{ operation_hash: hash(operationId) }],
      }),
    );
  });

  it("requires operation fence insertion support", async () => {
    await expect(
      fenceClickHouseAccount(
        { command: async () => undefined, query: async () => ({ json: async () => [] }) },
        userId,
        [operationId],
      ),
    ).rejects.toThrow("requires insert support");
  });

  it("writes only the user fence when the operation page is empty", async () => {
    const command = vi.fn<ClickHouseCommandClient["command"]>(async () => undefined);
    const insert = vi.fn<NonNullable<ClickHouseCommandClient["insert"]>>(async () => undefined);
    await fenceClickHouseAccount(
      { command, insert, query: async () => ({ json: async () => [] }) },
      userId,
      [],
    );
    expect(command).toHaveBeenCalledOnce();
    expect(insert).not.toHaveBeenCalled();
  });
});

describe("clickHouseAccountErasurePredicates", () => {
  it("emits a single user predicate for UUID ownership columns", async () => {
    const store = createStore();
    const predicates = await collectPredicates(
      physicalTable({
        name: "daily_recovery",
        columns: [
          ["user_id", "UUID"],
          ["day", "Date"],
        ],
      }),
      store,
    );
    expect(predicates).toEqual([
      expect.objectContaining({
        binding: "user",
        sql: "user_id={erasure_user_id:UUID}",
        queryParameters: { erasure_user_id: userId },
        mutationQueryParameters: { erasure_user_hash: hash(userId) },
      }),
    ]);
    expect(store.readPage).not.toHaveBeenCalled();
  });

  it("uses the profile id column when user_profile has no user_id", async () => {
    const predicates = await collectPredicates(
      physicalTable({
        name: "user_profile",
        columns: [
          ["id", "UUID"],
          ["email", "String"],
        ],
      }),
      createStore(),
    );
    expect(predicates).toEqual([
      expect.objectContaining({
        binding: "user",
        sql: "id={erasure_user_id:UUID}",
      }),
    ]);
  });

  it("guards nullable owners and pages array relation bindings", async () => {
    const store = createStore({
      readPage: vi
        .fn()
        .mockResolvedValueOnce({
          entries: [
            { key: "a".repeat(64), value: activityId },
            { key: "b".repeat(64), value: activityId },
          ],
          nextCursor: "b".repeat(64),
        })
        .mockResolvedValueOnce({
          entries: [{ key: "c".repeat(64), value: activityId }],
          nextCursor: null,
        }),
    });
    const predicates = await collectPredicates(
      physicalTable({
        name: "activity_group",
        columns: [
          ["user_id", "Nullable(UUID)"],
          ["member_activity_ids", "Array(UUID)"],
        ],
      }),
      store,
    );
    expect(predicates[0]).toMatchObject({ binding: "user" });
    expect(predicates.slice(1)).toEqual([
      expect.objectContaining({
        binding: ["member_activity_ids", "activity", null, "b".repeat(64)],
        sql: expect.stringContaining("user_id IS NULL AND"),
        mutationSql: expect.stringContaining("hasAny(arrayMap"),
      }),
      expect.objectContaining({
        binding: ["member_activity_ids", "activity", "b".repeat(64), "c".repeat(64)],
      }),
    ]);
    expect(store.readPage).toHaveBeenNthCalledWith(1, "activity", undefined);
    expect(store.readPage).toHaveBeenNthCalledWith(2, "activity", "b".repeat(64));
  });

  it("hashes string relation values from retained base64 pages", async () => {
    const groupValue = Buffer.from("group-1").toString("base64");
    const store = createStore({
      readPage: vi.fn(async () => ({
        entries: [{ key: "d".repeat(64), value: groupValue }],
        nextCursor: null,
      })),
    });
    const predicates = await collectPredicates(
      physicalTable({
        name: "activity_bundle",
        columns: [
          ["user_id", "Nullable(UUID)"],
          ["group_id", "String"],
        ],
      }),
      store,
    );
    expect(predicates).toHaveLength(2);
    expect(predicates[1]).toMatchObject({
      binding: ["group_id", "group_string", null, "d".repeat(64)],
      mutationSql: expect.stringContaining("assumeNotNull(`group_id`)"),
      queryParameters: {
        erasure_relation_ids: [
          createHash("sha256").update(Buffer.from(groupValue, "base64")).digest("hex"),
        ],
      },
    });
  });

  it("skips empty retained relation pages without emitting a predicate", async () => {
    const store = createStore({
      readPage: vi.fn(async () => ({ entries: [], nextCursor: null })),
    });
    const predicates = await collectPredicates(
      physicalTable({
        name: "activity_bundle",
        columns: [
          ["user_id", "Nullable(UUID)"],
          ["group_id", "String"],
        ],
      }),
      store,
    );
    expect(predicates).toEqual([expect.objectContaining({ binding: "user" })]);
  });

  it("captures activity id families when the table owns a scalar id", async () => {
    const store = createStore({
      readPage: vi.fn(async () => ({
        entries: [{ key: "e".repeat(64), value: activityId }],
        nextCursor: null,
      })),
    });
    const predicates = await collectPredicates(
      physicalTable({
        name: "activity",
        columns: [
          ["user_id", "Nullable(UUID)"],
          ["id", "UUID"],
        ],
      }),
      store,
    );
    expect(predicates.some((predicate) => predicate.binding === "user")).toBe(true);
    expect(
      predicates.some(
        (predicate) =>
          Array.isArray(predicate.binding) &&
          predicate.binding[0] === "id" &&
          predicate.binding[1] === "activity",
      ),
    ).toBe(true);
  });
});

describe("prepareClickHouseAccountErasureIdentifiers", () => {
  it("returns immediately when closure is already sealed", async () => {
    const owner = createOwner();
    const store = createStore({ beginClosure: vi.fn(async () => false) });
    await prepareClickHouseAccountErasureIdentifiers(owner, store, {
      userId,
      stage: "initial",
    });
    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(store.sealClosure).not.toHaveBeenCalled();
  });

  it("seals on the first clean pass when no identifier columns expand", async () => {
    mocks.inspect.mockResolvedValue([
      physicalTable({
        name: "daily_recovery",
        columns: [
          ["user_id", "UUID"],
          ["day", "Date"],
        ],
      }),
    ]);
    const owner = createOwner();
    const store = createStore();
    await prepareClickHouseAccountErasureIdentifiers(owner, store, {
      userId,
      stage: "initial",
    });
    expect(store.append).not.toHaveBeenCalled();
    expect(store.sealClosure).toHaveBeenCalledWith("initial");
  });

  it("expands retained identifiers until a clean pass seals the closure", async () => {
    mocks.inspect.mockResolvedValue([
      physicalTable({
        name: "activity",
        columns: [
          ["user_id", "UUID"],
          ["operation_id", "UUID"],
        ],
      }),
    ]);
    mocks.readIdentifierPage
      .mockResolvedValueOnce({ values: [operationId], nextCursor: null })
      .mockResolvedValue({ values: [], nextCursor: null });
    const owner = createOwner();
    const store = createStore({
      append: vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false),
    });
    await prepareClickHouseAccountErasureIdentifiers(
      owner,
      store,
      { userId, stage: "initial" },
      { identifierExpansionMaximumPasses: 4 },
    );
    expect(store.append).toHaveBeenCalledWith("operation", [operationId]);
    expect(store.sealClosure).toHaveBeenCalledWith("initial");
  });

  it("fails loudly when identifier expansion does not converge", async () => {
    mocks.inspect.mockResolvedValue([
      physicalTable({
        name: "activity",
        columns: [
          ["user_id", "UUID"],
          ["id", "UUID"],
        ],
      }),
    ]);
    mocks.readIdentifierPage.mockResolvedValue({ values: [activityId], nextCursor: null });
    const owner = createOwner();
    const store = createStore({ append: vi.fn(async () => true) });
    await expect(
      prepareClickHouseAccountErasureIdentifiers(
        owner,
        store,
        { userId, stage: "initial" },
        { identifierExpansionMaximumPasses: 1 },
      ),
    ).rejects.toThrow(/did not converge within 1 passes/);
    expect(store.sealClosure).not.toHaveBeenCalled();
  });

  it("rejects young dbt staging tables before expansion", async () => {
    mocks.inspect.mockResolvedValue([
      physicalTable({
        name: "daily_recovery__dbt_new_data_12345678_1234_4234_8234_123456789abc",
        age_milliseconds: 60_000,
        columns: [["user_id", "UUID"]],
      }),
    ]);
    const owner = createOwner();
    await expect(
      prepareClickHouseAccountErasureIdentifiers(owner, createStore(), {
        userId,
        stage: "initial",
      }),
    ).rejects.toThrow(/active dbt staging table/);
  });

  it("rejects old staging tables that still have active queries", async () => {
    mocks.inspect.mockResolvedValue([
      physicalTable({
        name: "daily_recovery__dbt_new_data_12345678_1234_4234_8234_123456789abc",
        age_milliseconds: 3_600_000,
        columns: [["user_id", "UUID"]],
      }),
    ]);
    const owner = createOwner(
      vi.fn(async () => ({
        json: async () => [{ count: 2 }],
      })),
    );
    await expect(
      prepareClickHouseAccountErasureIdentifiers(owner, createStore(), {
        userId,
        stage: "initial",
      }),
    ).rejects.toThrow(/active dbt staging table/);
  });
});

describe("prepareClickHouseAccountErasure", () => {
  it("reuses a prepared physical plan without rebuilding baselines", async () => {
    mocks.inspect.mockResolvedValue([
      physicalTable({
        name: "daily_recovery",
        columns: [["user_id", "UUID"]],
      }),
    ]);
    const owner = createOwner();
    const store = createStore({
      loadPhysicalProgress: vi.fn(async () => ({ step: "physical" as const })),
    });
    await prepareClickHouseAccountErasure(owner, store, { userId, stage: "initial" });
    expect(store.assertPhysicalPlanPrepared).toHaveBeenCalledOnce();
    expect(mocks.prepareBaseline).not.toHaveBeenCalled();
    expect(mocks.sealPhysical).not.toHaveBeenCalled();
  });

  it("prepares baselines and seals when no physical progress exists", async () => {
    mocks.inspect.mockResolvedValue([
      physicalTable({
        name: "daily_recovery",
        columns: [["user_id", "UUID"]],
      }),
    ]);
    const owner = createOwner();
    const store = createStore();
    await prepareClickHouseAccountErasure(owner, store, { userId, stage: "initial" });
    expect(mocks.prepareBaseline).toHaveBeenCalledOnce();
    expect(mocks.preparePhysical).toHaveBeenCalledWith(
      owner,
      store,
      expect.objectContaining({
        intent: expect.arrayContaining(["initial", "analytics", "daily_recovery"]),
        predicate: expect.objectContaining({ binding: "user" }),
      }),
    );
    expect(mocks.sealPhysical).toHaveBeenCalledOnce();
  });
});

describe("eraseClickHouseAccount", () => {
  it("fences retained operations then resolves user and relation intents", async () => {
    const table = physicalTable({
      name: "activity",
      columns: [
        ["user_id", "Nullable(UUID)"],
        ["id", "UUID"],
        ["operation_id", "UUID"],
      ],
    });
    mocks.inspect.mockResolvedValue([table]);
    const owner = createOwner();
    const relationPage = {
      entries: [{ key: "g".repeat(64), value: activityId }],
      nextCursor: null,
    };
    const store = createStore({
      readPage: vi
        .fn()
        .mockResolvedValueOnce({
          entries: [{ key: "f".repeat(64), value: operationId }],
          nextCursor: null,
        })
        .mockResolvedValue(relationPage),
    });
    const { clickHouseErasureSchemaDigest } = await import("./clickhouse-erasure-coverage.ts");
    const digest = clickHouseErasureSchemaDigest([table]);
    mocks.executePhysical.mockImplementation(async (_owner, _store, _stage, resolveIntent) => {
      await expect(
        resolveIntent(["initial", table.database, table.name, table.uuid, digest, "user"]),
      ).resolves.toMatchObject({
        predicate: expect.objectContaining({ binding: "user" }),
      });
      await expect(
        resolveIntent([
          "initial",
          table.database,
          table.name,
          table.uuid,
          digest,
          ["id", "activity", null, "g".repeat(64)],
        ]),
      ).resolves.toMatchObject({
        predicate: expect.objectContaining({
          binding: ["id", "activity", null, "g".repeat(64)],
        }),
      });
      await expect(
        resolveIntent(["initial", table.database, "missing", table.uuid, digest, "user"]),
      ).rejects.toThrow(/UUID\/schema changed/);
      store.readPage.mockResolvedValueOnce({
        entries: [{ key: "wrong".repeat(16).slice(0, 64), value: activityId }],
        nextCursor: null,
      });
      await expect(
        resolveIntent([
          "initial",
          table.database,
          table.name,
          table.uuid,
          digest,
          ["id", "activity", null, "missing-upper"],
        ]),
      ).rejects.toThrow(/identity interval is incomplete/);
      await expect(
        resolveIntent([
          "initial",
          table.database,
          table.name,
          table.uuid,
          digest,
          ["unknown_column", "activity", null, "g".repeat(64)],
        ]),
      ).rejects.toThrow(/relationship is unsupported/);
    });

    await eraseClickHouseAccount(owner, store, { userId, stage: "initial" });

    expect(store.assertClosureComplete).toHaveBeenCalledWith("initial");
    expect(mocks.assertDetached).toHaveBeenCalledOnce();
    expect(owner.client.command).toHaveBeenCalled();
    expect(owner.client.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        values: [{ operation_hash: hash(operationId) }],
      }),
    );
    expect(mocks.executePhysical).toHaveBeenCalledOnce();
  });
});
