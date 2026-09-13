import { describe, expect, it, vi } from "vitest";
import type { PeerDbMirrorContract } from "./mirror-contracts.ts";
import {
  finalizePeerDbDeployment,
  preparePeerDbDeployment,
  verifyPeerDbDeployment,
} from "./mirror-deployment.ts";

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
      })),
  })),
};

describe("PeerDB deployment contract", () => {
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

    expect(events).toEqual(["list", "status", "validate"]);
  });

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

    await expect(
      verifyPeerDbDeployment({
        artifacts: [marker],
        hasMarker: vi.fn(async () => false),
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
        timeoutMs: 2_000,
        pollIntervalMs: 1_000,
      }),
    ).rejects.toThrow("PeerDB deployment canary did not arrive: test_flow");
  });
});
