import { describe, expect, it, vi } from "vitest";
import type { PeerDbMirrorContract, PeerDbTableMapping } from "./mirror-contracts.ts";
import {
  finalizePeerDbDeployment,
  preparePeerDbDeployment,
  verifyPeerDbDeployment,
} from "./mirror-deployment.ts";
import type { PeerDbMirrorApiClient } from "./mirror-reconciler.ts";

const contract = {
  name: "test_mirror",
  destinationDatabase: "destination",
  initialCopyPlaceholder: "TEST_INITIAL_COPY",
  tableMappingsPlaceholder: "TEST_MAPPINGS",
  processingMarker: {
    datasetKey: "activity",
    destinationTableIdentifier: "processing_flow_marker",
    flow: "test_flow",
  },
  tableMappings: [
    {
      sourceTableIdentifier: "fitness.activity",
      destinationTableIdentifier: "activity",
      exclude: [],
    },
  ],
} as const satisfies PeerDbMirrorContract;

const sourcePostgresClient = {
  query: vi.fn(async () => ({
    rows: [{ table_schema: "fitness", table_name: "activity", column_name: "id" }],
  })),
};
const clickHouseClient = {
  query: vi.fn(async (_options: unknown) => ({
    json: async () =>
      ["id", "_peerdb_is_deleted", "_peerdb_synced_at", "_peerdb_version"].map((name) => ({
        database: "destination",
        table: "activity",
        name,
        type: "String",
      })),
  })),
};

function existingMirror(initialMappings: readonly PeerDbTableMapping[]) {
  let currentFlowState = "STATUS_RUNNING";
  let tableMappings = [...initialMappings];
  const client: PeerDbMirrorApiClient = {
    async listMirrors() {
      return [{ destinationType: 3, isCdc: true, name: "test_mirror" }];
    },
    async getMirrorStatus() {
      return { currentFlowState, tableMappings };
    },
    async changeMirrorState(request) {
      currentFlowState = request.requestedFlowState;
      const update = request.flowConfigUpdate?.cdcFlowConfigUpdate;
      if (update?.removed_tables) {
        tableMappings = tableMappings.filter(
          (mapping) =>
            !update.removed_tables?.some(
              (removed) =>
                removed.sourceTableIdentifier === mapping.sourceTableIdentifier &&
                removed.destinationTableIdentifier === mapping.destinationTableIdentifier,
            ),
        );
      }
      if (update?.additional_tables) {
        tableMappings = [...tableMappings, ...update.additional_tables];
      }
    },
  };
  return { client, readMappings: () => tableMappings, readState: () => currentFlowState };
}

describe("PeerDB deployment contract", () => {
  it("accepts an empty direct verification set without polling", async () => {
    const hasMarker = vi.fn(async () => true);
    const sleep = vi.fn(async () => undefined);

    await expect(
      verifyPeerDbDeployment({
        artifacts: [],
        hasMarker,
        now: () => 0,
        sleep,
        timeoutMs: 2_000,
        pollIntervalMs: 1_000,
      }),
    ).resolves.toBeUndefined();

    expect(hasMarker).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("reconciles existing mirrors before validating their schemas", async () => {
    const events: string[] = [];
    const mirrorApiClient = {
      listMirrors: vi.fn(async () => {
        events.push("list");
        return [{ destinationType: 3, isCdc: true, name: "test_mirror" }];
      }),
      getMirrorStatus: vi.fn(async () => {
        events.push("status");
        return { currentFlowState: "STATUS_RUNNING", tableMappings: contract.tableMappings };
      }),
      changeMirrorState: vi.fn(async () => undefined),
    };

    await preparePeerDbDeployment({
      clickHouseClient: {
        query: vi.fn(async (options) => {
          events.push("validate");
          return clickHouseClient.query(options);
        }),
      },
      contracts: [contract],
      mirrorApiClient,
      sourcePostgresClient,
    });

    expect(events).toEqual(["list", "status", "status", "validate"]);
  });

  it("defers new table mappings and their schema checks until after migration", async () => {
    const mirror = existingMirror(contract.tableMappings);

    await expect(
      preparePeerDbDeployment({
        clickHouseClient,
        contracts: [
          {
            ...contract,
            tableMappings: [
              ...contract.tableMappings,
              {
                sourceTableIdentifier: "fitness.provider_field_priority",
                destinationTableIdentifier: "provider_field_priority",
                exclude: [],
              },
            ],
          },
        ],
        mirrorApiClient: mirror.client,
        sourcePostgresClient,
      }),
    ).resolves.toBeUndefined();

    expect(mirror.readMappings()).toEqual([
      {
        sourceTableIdentifier: "fitness.activity",
        destinationTableIdentifier: "activity",
        exclude: [],
      },
    ]);
    expect(mirror.readState()).toBe("STATUS_RUNNING");
  });

  it.each([
    { sourceTableIdentifier: "fitness.activity", destinationTableIdentifier: "new_activity" },
    { sourceTableIdentifier: "fitness.new_activity", destinationTableIdentifier: "activity" },
  ])(
    "defers the changed mapping $sourceTableIdentifier -> $destinationTableIdentifier and removes its obsolete mapping",
    async (mapping) => {
      const mirror = existingMirror(contract.tableMappings);

      await expect(
        preparePeerDbDeployment({
          clickHouseClient,
          contracts: [{ ...contract, tableMappings: [{ ...mapping, exclude: [] }] }],
          mirrorApiClient: mirror.client,
          sourcePostgresClient,
        }),
      ).resolves.toBeUndefined();

      expect(mirror.readMappings()).toEqual([]);
      expect(mirror.readState()).toBe("STATUS_RUNNING");
    },
  );

  it("reconciles changed exclusions for existing table identities before schema validation", async () => {
    const mirror = existingMirror(contract.tableMappings);

    await preparePeerDbDeployment({
      clickHouseClient,
      contracts: [
        {
          ...contract,
          tableMappings: [{ ...contract.tableMappings[0], exclude: ["provider_estimate"] }],
        },
      ],
      mirrorApiClient: mirror.client,
      sourcePostgresClient: {
        query: async () => ({
          rows: ["id", "provider_estimate"].map((column_name) => ({
            table_schema: "fitness",
            table_name: "activity",
            column_name,
          })),
        }),
      },
    });

    expect(mirror.readMappings()).toEqual([
      {
        sourceTableIdentifier: "fitness.activity",
        destinationTableIdentifier: "activity",
        exclude: ["provider_estimate"],
      },
    ]);
    expect(mirror.readState()).toBe("STATUS_RUNNING");
  });

  it("removes obsolete mappings before migration", async () => {
    const mirror = existingMirror([
      ...contract.tableMappings,
      {
        sourceTableIdentifier: "fitness.legacy_activity",
        destinationTableIdentifier: "legacy_activity",
        exclude: [],
      },
    ]);

    await preparePeerDbDeployment({
      clickHouseClient,
      contracts: [contract],
      mirrorApiClient: mirror.client,
      sourcePostgresClient,
    });

    expect(mirror.readMappings()).toEqual([
      {
        sourceTableIdentifier: "fitness.activity",
        destinationTableIdentifier: "activity",
        exclude: [],
      },
    ]);
    expect(mirror.readState()).toBe("STATUS_RUNNING");
  });

  it.each([
    { description: "absent mirror", mirrors: [] },
    {
      description: "non-CDC flow with a managed name",
      mirrors: [{ destinationType: 3, isCdc: false, name: "test_mirror" }],
    },
  ])("defers reconciliation and schema validation for an $description", async ({ mirrors }) => {
    const mirrorApiClient = {
      listMirrors: vi.fn(async () => mirrors),
      getMirrorStatus: vi.fn(async () => ({
        currentFlowState: "STATUS_RUNNING",
        tableMappings: contract.tableMappings,
      })),
      changeMirrorState: vi.fn(async () => undefined),
    };

    await preparePeerDbDeployment({
      clickHouseClient: { query: async () => ({ json: async () => [] }) },
      contracts: [contract],
      mirrorApiClient,
      sourcePostgresClient: { query: async () => ({ rows: [] }) },
    });

    expect(mirrorApiClient.getMirrorStatus).not.toHaveBeenCalled();
  });

  it("rejects an invalid existing mirror state before migration", async () => {
    const mirror = existingMirror([]);
    vi.spyOn(mirror.client, "getMirrorStatus").mockResolvedValue({
      currentFlowState: "STATUS_SNAPSHOT",
      tableMappings: [],
    });

    await expect(
      preparePeerDbDeployment({
        clickHouseClient,
        contracts: [contract],
        mirrorApiClient: mirror.client,
        sourcePostgresClient,
      }),
    ).rejects.toThrow("current state is STATUS_SNAPSHOT");
  });

  it.each([
    {
      sourceColumns: [],
      destinationColumns: ["id", "_peerdb_is_deleted", "_peerdb_synced_at", "_peerdb_version"],
      issue: "missing_source_table",
    },
    { sourceColumns: ["id"], destinationColumns: [], issue: "missing_destination_table" },
    {
      sourceColumns: ["id", "name"],
      destinationColumns: ["id", "_peerdb_is_deleted", "_peerdb_synced_at", "_peerdb_version"],
      issue: "missing_destination_columns=[name]",
    },
    {
      sourceColumns: ["id"],
      destinationColumns: ["id"],
      issue: "missing_peerdb_metadata_columns",
    },
  ])(
    "continues failing existing mapping schema checks for $issue",
    async ({ sourceColumns, destinationColumns, issue }) => {
      const mirror = existingMirror(contract.tableMappings);

      await expect(
        preparePeerDbDeployment({
          clickHouseClient: {
            query: async () => ({
              json: async () =>
                destinationColumns.map((name) => ({
                  database: "destination",
                  table: "activity",
                  name,
                  type: "String",
                })),
            }),
          },
          contracts: [contract],
          mirrorApiClient: mirror.client,
          sourcePostgresClient: {
            query: async () => ({
              rows: sourceColumns.map((column_name) => ({
                table_schema: "fitness",
                table_name: "activity",
                column_name,
              })),
            }),
          },
        }),
      ).rejects.toThrow(issue);
    },
  );

  it("validates then writes one unique canary for each marker-bearing contract", async () => {
    const writeMarker = vi.fn(async () => ({
      operationId: "10000000-0000-4000-8000-000000000001",
      sourceWatermark: "10000000-0000-4000-8000-000000000002",
    }));
    const artifacts = await finalizePeerDbDeployment({
      clickHouseClient,
      contracts: [contract],
      createId: vi.fn().mockReturnValueOnce("10000000-0000-4000-8000-000000000002"),
      sourcePostgresClient,
      writeMarker,
    });

    expect(writeMarker).toHaveBeenCalledOnce();
    expect(writeMarker).toHaveBeenCalledWith({
      batchKey: "10000000-0000-4000-8000-000000000002",
      datasetKey: "activity",
      flowName: "test_flow",
    });
    expect(artifacts).toEqual([
      expect.objectContaining({
        batchKey: "10000000-0000-4000-8000-000000000002",
        datasetKey: "activity",
        destinationTableIdentifier: "processing_flow_marker",
        flowName: "test_flow",
        operationId: "10000000-0000-4000-8000-000000000001",
      }),
    ]);
  });

  it("fails verification when the exact causal marker does not arrive", async () => {
    const marker = {
      batchKey: "10000000-0000-4000-8000-000000000002",
      datasetKey: "activity" as const,
      destinationDatabase: "destination",
      destinationTableIdentifier: "processing_flow_marker",
      flowName: "test_flow",
      operationId: "10000000-0000-4000-8000-000000000001",
      sourceWatermark: "10000000-0000-4000-8000-000000000002",
    };
    let now = 0;

    const hasMarker = vi.fn(async () => false);
    await expect(
      verifyPeerDbDeployment({
        artifacts: [marker],
        hasMarker,
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
        timeoutMs: 2_000,
        pollIntervalMs: 1_000,
      }),
    ).rejects.toThrow("PeerDB deployment canary did not arrive: test_flow");
    expect(hasMarker).toHaveBeenCalledTimes(2);
    expect(now).toBe(2_000);
  });

  it("returns immediately after every exact marker arrives", async () => {
    const marker = {
      batchKey: "10000000-0000-4000-8000-000000000002",
      datasetKey: "activity" as const,
      destinationDatabase: "destination",
      destinationTableIdentifier: "processing_flow_marker",
      flowName: "test_flow",
      operationId: "10000000-0000-4000-8000-000000000001",
      sourceWatermark: "10000000-0000-4000-8000-000000000002",
    };
    vi.useFakeTimers();
    const sleep = vi.fn(async () => undefined);
    const hasMarker = vi.fn(async () => true);

    await expect(
      verifyPeerDbDeployment({
        artifacts: [marker, { ...marker, flowName: "second_flow" }],
        hasMarker,
        now: () => 0,
        sleep,
        timeoutMs: 2_000,
        pollIntervalMs: 1_000,
      }),
    ).resolves.toBeUndefined();

    expect(sleep).not.toHaveBeenCalled();
    expect(hasMarker).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a marker probe by the remaining deployment deadline", async () => {
    const marker = {
      batchKey: "10000000-0000-4000-8000-000000000002",
      datasetKey: "activity" as const,
      destinationDatabase: "destination",
      destinationTableIdentifier: "processing_flow_marker",
      flowName: "test_flow",
      operationId: "10000000-0000-4000-8000-000000000001",
      sourceWatermark: "10000000-0000-4000-8000-000000000002",
    };
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const verification = expect(
      verifyPeerDbDeployment({
        artifacts: [marker],
        hasMarker: vi.fn(() => new Promise<boolean>(() => undefined)),
        now: Date.now,
        sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
        timeoutMs: 20,
        pollIntervalMs: 1_000,
      }),
    ).rejects.toThrow("PeerDB deployment canary did not arrive: test_flow");

    await vi.advanceTimersByTimeAsync(20);
    await verification;
    expect(Date.now()).toBe(20);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a marker result that arrives after the deployment deadline", async () => {
    const marker = {
      batchKey: "10000000-0000-4000-8000-000000000002",
      datasetKey: "activity" as const,
      destinationDatabase: "destination",
      destinationTableIdentifier: "processing_flow_marker",
      flowName: "test_flow",
      operationId: "10000000-0000-4000-8000-000000000001",
      sourceWatermark: "10000000-0000-4000-8000-000000000002",
    };
    let now = 0;

    await expect(
      verifyPeerDbDeployment({
        artifacts: [marker],
        hasMarker: vi.fn(async () => {
          now = 2_000;
          return true;
        }),
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
        timeoutMs: 2_000,
        pollIntervalMs: 1_000,
      }),
    ).rejects.toThrow("PeerDB deployment canary did not arrive: test_flow");
  });

  it("sorts missing flow names in timeout diagnostics", async () => {
    const marker = {
      batchKey: "10000000-0000-4000-8000-000000000002",
      datasetKey: "activity" as const,
      destinationDatabase: "destination",
      destinationTableIdentifier: "processing_flow_marker",
      operationId: "10000000-0000-4000-8000-000000000001",
      sourceWatermark: "10000000-0000-4000-8000-000000000002",
    };
    let now = 0;

    await expect(
      verifyPeerDbDeployment({
        artifacts: [
          { ...marker, flowName: "z_flow" },
          { ...marker, flowName: "a_flow" },
        ],
        hasMarker: vi.fn(async () => false),
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
        timeoutMs: 1,
        pollIntervalMs: 1,
      }),
    ).rejects.toEqual(new Error("PeerDB deployment canary did not arrive: a_flow, z_flow"));
  });
});
