import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { finalizePeerDbDeployment, preparePeerDbDeployment, verifyPeerDbDeployment } = vi.hoisted(
  () => ({
    preparePeerDbDeployment: vi.fn(async () => undefined),
    finalizePeerDbDeployment: vi.fn(async () => [
      {
        batchKey: "10000000-0000-4000-8000-000000000002",
        datasetKey: "activity",
        destinationDatabase: "postgres_fitness",
        destinationTableIdentifier: "processing_flow_marker",
        flowName: "dofek_fitness_raw_analytics",
        operationId: "10000000-0000-4000-8000-000000000001",
        sourceWatermark: "10000000-0000-4000-8000-000000000002",
      },
    ]),
    verifyPeerDbDeployment: vi.fn(async () => undefined),
  }),
);

vi.mock("./peerdb/mirror-deployment.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./peerdb/mirror-deployment.ts")>()),
  preparePeerDbDeployment,
  finalizePeerDbDeployment,
  verifyPeerDbDeployment,
}));

import {
  type PeerDbContractCommandDependencies,
  runClickHouseCdcContractCommand,
} from "./run-clickhouse-cdc-contract.ts";

const temporaryDirectories: string[] = [];
const unusedDependencies = {
  clickHouseClient: {
    command: vi.fn(async () => undefined),
    query: vi.fn(async () => ({ json: async () => [] })),
  },
  mirrorApiClient: {
    changeMirrorState: vi.fn(async () => undefined),
    getMirrorStatus: vi.fn(async () => ({ currentFlowState: "STATUS_RUNNING", tableMappings: [] })),
    listMirrors: vi.fn(async () => []),
  },
  prepareDestinationSchema: vi.fn(async () => undefined),
  sourcePostgresClient: {
    query: vi.fn(async () => ({ rows: [] })),
  },
  writeMarker: vi.fn(async () => ({
    operationId: "10000000-0000-4000-8000-000000000001",
    sourceWatermark: "10000000-0000-4000-8000-000000000002",
  })),
} satisfies PeerDbContractCommandDependencies;

afterEach(() => {
  vi.clearAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("run-clickhouse-cdc-contract", () => {
  it("dispatches prepare without requiring an artifact", async () => {
    await runClickHouseCdcContractCommand("prepare", undefined, unusedDependencies);
    expect(unusedDependencies.prepareDestinationSchema).toHaveBeenCalledOnce();
    expect(preparePeerDbDeployment).toHaveBeenCalledOnce();
  });

  it("writes finalize artifacts with owner-only permissions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "peerdb-contract-command-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "artifact.json");

    await runClickHouseCdcContractCommand("finalize", path, unusedDependencies);

    expect(JSON.parse(readFileSync(path, "utf8"))).toHaveLength(1);
    expect((await import("node:fs/promises")).stat(path)).resolves.toMatchObject({
      mode: 0o100600,
    });
  });

  it("fails verify when the artifact is missing", async () => {
    await expect(
      runClickHouseCdcContractCommand("verify", undefined, unusedDependencies),
    ).rejects.toThrow("verify requires an artifact path");
    expect(verifyPeerDbDeployment).not.toHaveBeenCalled();
  });
});
