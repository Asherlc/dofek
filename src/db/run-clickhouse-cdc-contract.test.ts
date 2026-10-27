import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type VerificationOptions = Parameters<
  typeof import("./peerdb/mirror-deployment.ts").verifyPeerDbDeployment
>[0];
type FinalizeOptions = Parameters<
  typeof import("./peerdb/mirror-deployment.ts").finalizePeerDbDeployment
>[0];

const {
  createDatabaseFromEnv,
  clientConstructor,
  createProcessingOperation,
  finalizePeerDbDeployment,
  postgresClient,
  recordCanonicalCommit,
  runClickHouseMigrations,
  runtimeClickHouseClient,
  runtimeMirrorApiClient,
  preparePeerDbDeployment,
  verifyPeerDbDeployment,
} = vi.hoisted(() => ({
  createDatabaseFromEnv: vi.fn(() => ({ execute: vi.fn() })),
  clientConstructor: vi.fn(),
  createProcessingOperation: vi.fn(async () => ({
    id: "10000000-0000-4000-8000-000000000001",
  })),
  postgresClient: {
    connect: vi.fn(async () => undefined),
    end: vi.fn(async () => undefined),
    query: vi.fn(async () => ({ rows: [] })),
  },
  recordCanonicalCommit: vi.fn(
    async (): Promise<{ sourceWatermark: string | null }> => ({
      sourceWatermark: "10000000-0000-4000-8000-000000000002",
    }),
  ),
  runClickHouseMigrations: vi.fn(async () => undefined),
  runtimeClickHouseClient: {
    close: vi.fn(async () => undefined),
    command: vi.fn(async () => undefined),
    query: vi.fn(async () => ({ json: async () => [] })),
  },
  runtimeMirrorApiClient: {
    changeMirrorState: vi.fn(async () => undefined),
    getMirrorStatus: vi.fn(async () => ({ currentFlowState: "STATUS_RUNNING", tableMappings: [] })),
    listMirrors: vi.fn(async () => []),
  },
  preparePeerDbDeployment: vi.fn(async () => undefined),
  finalizePeerDbDeployment: vi.fn(async (_options?: FinalizeOptions) => [
    {
      batchKey: "10000000-0000-4000-8000-000000000002",
      datasetKey: "activity",
      destinationDatabase: "postgres_fitness",
      destinationTableIdentifier: "processing_flow_marker",
      flowName: "dofek_fitness_raw_analytics",
      operationId: "10000000-0000-4000-8000-000000000001",
      sourceWatermark: "10000000-0000-4000-8000-000000000002",
    },
    {
      batchKey: "20000000-0000-4000-8000-000000000002",
      datasetKey: "providers",
      destinationDatabase: "postgres_fitness",
      destinationTableIdentifier: "processing_flow_marker_provider_inventory",
      flowName: "dofek_provider_inventory_raw_analytics",
      operationId: "20000000-0000-4000-8000-000000000001",
      sourceWatermark: "20000000-0000-4000-8000-000000000002",
    },
    {
      batchKey: "30000000-0000-4000-8000-000000000002",
      datasetKey: "activity",
      destinationDatabase: "postgres_fitness",
      destinationTableIdentifier: "processing_flow_marker_sensor_priority",
      flowName: "dofek_sensor_priority_raw_analytics",
      operationId: "30000000-0000-4000-8000-000000000001",
      sourceWatermark: "30000000-0000-4000-8000-000000000002",
    },
  ]),
  verifyPeerDbDeployment: vi.fn(async (_options: VerificationOptions) => undefined),
}));

vi.mock("pg", () => ({
  Client: class {
    constructor(options: unknown) {
      clientConstructor(options);
    }

    connect = postgresClient.connect;
    end = postgresClient.end;
    query = postgresClient.query;
  },
}));

vi.mock("../processing/processing-event-store.ts", () => ({
  createProcessingOperation,
  recordCanonicalCommit,
}));

vi.mock("./clickhouse.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./clickhouse.ts")>()),
  createClickHouseClientFromEnv: vi.fn(() => runtimeClickHouseClient),
}));

vi.mock("./clickhouse-cdc.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./clickhouse-cdc.ts")>()),
  createPeerDbMirrorApiClientFromEnv: vi.fn(() => runtimeMirrorApiClient),
}));

vi.mock("./clickhouse-migrations.ts", () => ({ runClickHouseMigrations }));
vi.mock("./index.ts", () => ({ createDatabaseFromEnv }));

vi.mock("./peerdb/mirror-deployment.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./peerdb/mirror-deployment.ts")>()),
  preparePeerDbDeployment,
  finalizePeerDbDeployment,
  verifyPeerDbDeployment,
}));

import { peerDbMirrorContracts } from "./peerdb/mirror-contracts.ts";
import {
  type PeerDbDeploymentCanary,
  peerDbDeploymentArtifactSchema,
} from "./peerdb/mirror-deployment.ts";
import {
  type PeerDbContractCommandDependencies,
  runClickHouseCdcContractCli,
  runClickHouseCdcContractCommand,
} from "./run-clickhouse-cdc-contract.ts";

const temporaryDirectories: string[] = [];
const originalArgv = [...process.argv];
const originalDatabaseUrl = process.env.DATABASE_URL;
const runtimeClose = runtimeClickHouseClient.close;
const unusedDependencies = {
  clickHouseClient: {
    query: vi.fn(async () => ({ json: async (): Promise<unknown> => [] })),
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

function duplicateFirstArtifact(artifacts: PeerDbDeploymentCanary[]): PeerDbDeploymentCanary[] {
  const first = artifacts[0];
  if (!first) throw new Error("Expected a deployment artifact fixture");
  return [...artifacts.slice(0, -1), first];
}

function replaceFirstArtifactWithUnexpectedFlow(
  artifacts: PeerDbDeploymentCanary[],
): PeerDbDeploymentCanary[] {
  const [first, ...remaining] = artifacts;
  if (!first) throw new Error("Expected a deployment artifact fixture");
  return [...remaining, { ...first, flowName: "unexpected_flow" }];
}

type ArtifactRoutingOverride = Partial<
  Pick<PeerDbDeploymentCanary, "datasetKey" | "destinationDatabase" | "destinationTableIdentifier">
>;

function replaceFirstArtifactRouting(
  artifacts: PeerDbDeploymentCanary[],
  override: ArtifactRoutingOverride,
): PeerDbDeploymentCanary[] {
  const [first, ...remaining] = artifacts;
  if (!first) throw new Error("Expected a deployment artifact fixture");
  return [{ ...first, ...override }, ...remaining];
}

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
  runtimeClickHouseClient.close = runtimeClose;
  process.argv.splice(0, process.argv.length, ...originalArgv);
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("run-clickhouse-cdc-contract", () => {
  it("runs the prepare CLI with production clients and pre-CDC migrations", async () => {
    process.argv.splice(0, process.argv.length, "node", "command", "prepare");
    process.env.DATABASE_URL = "postgres://health:test@db/health";

    await runClickHouseCdcContractCli();

    expect(postgresClient.connect).toHaveBeenCalledOnce();
    expect(clientConstructor).toHaveBeenCalledWith({
      connectionString: "postgres://health:test@db/health",
    });
    expect(runClickHouseMigrations).toHaveBeenCalledWith(
      runtimeClickHouseClient,
      "postgres://health:test@db/health",
      { phase: "pre-cdc" },
    );
    expect(preparePeerDbDeployment).toHaveBeenCalledOnce();
    expect(postgresClient.end).toHaveBeenCalledOnce();
    expect(runtimeClickHouseClient.close).toHaveBeenCalledOnce();
  });

  it("runs the finalize CLI through the canonical marker writer", async () => {
    const directory = mkdtempSync(join(tmpdir(), "peerdb-contract-cli-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "artifact.json");
    process.argv.splice(0, process.argv.length, "node", "command", "finalize", path);
    process.env.DATABASE_URL = "postgres://health:test@db/health";
    finalizePeerDbDeployment.mockImplementationOnce(async (options) => {
      if (!options) throw new Error("Expected finalize dependencies");
      const markerResult = await options.writeMarker({
        batchKey: "10000000-0000-4000-8000-000000000002",
        datasetKey: "activity",
        flowName: "dofek_fitness_raw_analytics",
      });
      expect(markerResult).toEqual({
        operationId: "10000000-0000-4000-8000-000000000001",
        sourceWatermark: "10000000-0000-4000-8000-000000000002",
      });
      return peerDbDeploymentArtifactSchema.parse([
        {
          batchKey: "10000000-0000-4000-8000-000000000002",
          datasetKey: "activity",
          destinationDatabase: "postgres_fitness",
          destinationTableIdentifier: "processing_flow_marker",
          flowName: "dofek_fitness_raw_analytics",
          operationId: "10000000-0000-4000-8000-000000000001",
          sourceWatermark: "10000000-0000-4000-8000-000000000002",
        },
      ]);
    });

    await runClickHouseCdcContractCli();

    expect(createProcessingOperation).toHaveBeenCalledWith(expect.anything(), {
      datasetKeys: ["activity"],
      externalCorrelationKey: "peerdb-deploy-canary:10000000-0000-4000-8000-000000000002",
      kind: "analytics_build",
      userId: null,
    });
    expect(recordCanonicalCommit).toHaveBeenCalledWith(expect.anything(), {
      datasetKey: "activity",
      flowNames: ["dofek_fitness_raw_analytics"],
      idempotencyKey: "10000000-0000-4000-8000-000000000002",
      operationId: "10000000-0000-4000-8000-000000000001",
      sourceWatermark: "10000000-0000-4000-8000-000000000002",
    });
  });

  it("fails the finalize CLI when its canonical commit has no source watermark", async () => {
    const directory = mkdtempSync(join(tmpdir(), "peerdb-contract-cli-"));
    temporaryDirectories.push(directory);
    process.argv.splice(
      0,
      process.argv.length,
      "node",
      "command",
      "finalize",
      join(directory, "artifact.json"),
    );
    process.env.DATABASE_URL = "postgres://health:test@db/health";
    recordCanonicalCommit.mockResolvedValueOnce({ sourceWatermark: null });
    finalizePeerDbDeployment.mockImplementationOnce(async (options) => {
      if (!options) throw new Error("Expected finalize dependencies");
      await options.writeMarker({
        batchKey: "10000000-0000-4000-8000-000000000002",
        datasetKey: "activity",
        flowName: "dofek_fitness_raw_analytics",
      });
      return [];
    });

    await expect(runClickHouseCdcContractCli()).rejects.toThrow(
      "PeerDB deployment canary dofek_fitness_raw_analytics has no source watermark",
    );
  });

  it("accepts the verify CLI command and clients without an optional close method", async () => {
    const directory = mkdtempSync(join(tmpdir(), "peerdb-contract-cli-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "artifact.json");
    writeFileSync(path, JSON.stringify(await finalizePeerDbDeployment()));
    process.argv.splice(0, process.argv.length, "node", "command", "verify", path);
    process.env.DATABASE_URL = "postgres://health:test@db/health";
    Reflect.deleteProperty(runtimeClickHouseClient, "close");

    await runClickHouseCdcContractCli();

    expect(verifyPeerDbDeployment).toHaveBeenCalledOnce();
    expect(postgresClient.end).toHaveBeenCalledOnce();
  });

  it("rejects invalid CLI commands and missing database configuration", async () => {
    process.argv.splice(0, process.argv.length, "node", "command", "invalid");
    await expect(runClickHouseCdcContractCli()).rejects.toThrow(
      "Expected PeerDB CDC contract command",
    );

    process.argv.splice(0, process.argv.length, "node", "command", "prepare");
    delete process.env.DATABASE_URL;
    await expect(runClickHouseCdcContractCli()).rejects.toThrow(
      "DATABASE_URL environment variable is required",
    );
  });

  it("dispatches prepare without requiring an artifact", async () => {
    await runClickHouseCdcContractCommand("prepare", undefined, unusedDependencies);
    expect(unusedDependencies.prepareDestinationSchema).toHaveBeenCalledOnce();
    expect(preparePeerDbDeployment).toHaveBeenCalledWith({
      clickHouseClient: unusedDependencies.clickHouseClient,
      contracts: peerDbMirrorContracts,
      mirrorApiClient: unusedDependencies.mirrorApiClient,
      sourcePostgresClient: unusedDependencies.sourcePostgresClient,
    });
  });

  it("writes finalize artifacts with owner-only permissions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "peerdb-contract-command-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "artifact.json");

    await runClickHouseCdcContractCommand("finalize", path, unusedDependencies);

    expect(finalizePeerDbDeployment).toHaveBeenCalledWith({
      clickHouseClient: unusedDependencies.clickHouseClient,
      contracts: peerDbMirrorContracts,
      createId: expect.any(Function),
      sourcePostgresClient: unusedDependencies.sourcePostgresClient,
      writeMarker: unusedDependencies.writeMarker,
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toHaveLength(3);
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

  it.each([
    ["missing", (artifacts: PeerDbDeploymentCanary[]) => artifacts.slice(1)],
    ["duplicate", duplicateFirstArtifact],
    ["unexpected", replaceFirstArtifactWithUnexpectedFlow],
  ])("rejects a %s managed-flow artifact set", async (_case, alterArtifacts) => {
    const directory = mkdtempSync(join(tmpdir(), "peerdb-contract-command-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "artifact.json");
    const artifacts = peerDbDeploymentArtifactSchema.parse(await finalizePeerDbDeployment());
    writeFileSync(path, JSON.stringify(alterArtifacts(artifacts)));

    await expect(
      runClickHouseCdcContractCommand("verify", path, unusedDependencies),
    ).rejects.toThrow("PeerDB deployment artifact does not match the managed mirror contracts");
    expect(verifyPeerDbDeployment).not.toHaveBeenCalled();
  });

  it.each<[string, ArtifactRoutingOverride]>([
    ["dataset key", { datasetKey: "providers" }],
    ["destination database", { destinationDatabase: "other_database" }],
    ["destination table", { destinationTableIdentifier: "other_marker" }],
  ])("rejects an artifact with a mismatched %s", async (_case, override) => {
    const directory = mkdtempSync(join(tmpdir(), "peerdb-contract-command-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "artifact.json");
    const artifacts = peerDbDeploymentArtifactSchema.parse(await finalizePeerDbDeployment());
    writeFileSync(path, JSON.stringify(replaceFirstArtifactRouting(artifacts, override)));

    await expect(
      runClickHouseCdcContractCommand("verify", path, unusedDependencies),
    ).rejects.toThrow("PeerDB deployment artifact does not match the managed mirror contracts");
    expect(verifyPeerDbDeployment).not.toHaveBeenCalled();
  });

  it("verifies the parsed artifact through the ClickHouse marker dependency", async () => {
    const directory = mkdtempSync(join(tmpdir(), "peerdb-contract-command-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "artifact.json");
    const artifacts = peerDbDeploymentArtifactSchema.parse(await finalizePeerDbDeployment());
    const artifact = artifacts[0];
    if (!artifact) throw new Error("Expected a deployment artifact fixture");
    writeFileSync(path, JSON.stringify(artifacts));
    finalizePeerDbDeployment.mockClear();
    unusedDependencies.clickHouseClient.query.mockResolvedValueOnce({
      json: async () => JSON.parse('[{"marker_count":"1"}]'),
    });
    unusedDependencies.clickHouseClient.query.mockResolvedValueOnce({
      json: async () => JSON.parse('[{"marker_count":"0"}]'),
    });
    unusedDependencies.clickHouseClient.query.mockResolvedValueOnce({
      json: async () => [{ marker_count: 1 }],
    });
    vi.useFakeTimers();
    verifyPeerDbDeployment.mockImplementationOnce(async (options) => {
      expect(await options.hasMarker(artifact)).toBe(true);
      expect(await options.hasMarker(artifact)).toBe(false);
      expect(await options.hasMarker(artifact)).toBe(true);
      const sleepPromise = options.sleep(123);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(123);
      await sleepPromise;
    });

    await runClickHouseCdcContractCommand("verify", path, unusedDependencies);

    expect(finalizePeerDbDeployment).not.toHaveBeenCalled();
    expect(unusedDependencies.clickHouseClient.query).toHaveBeenCalledWith({
      format: "JSONEachRow",
      query: expect.stringMatching(
        /FROM postgres_fitness\.processing_flow_marker FINAL[\s\S]*operation_id = \{operationId:UUID\}[\s\S]*_peerdb_is_deleted = 0/,
      ),
      query_params: artifact,
    });
    expect(verifyPeerDbDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        artifacts,
        hasMarker: expect.any(Function),
        now: Date.now,
      }),
    );
  });

  it("rejects malformed ClickHouse marker counts at the database boundary", async () => {
    const directory = mkdtempSync(join(tmpdir(), "peerdb-contract-command-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "artifact.json");
    const artifacts = peerDbDeploymentArtifactSchema.parse(await finalizePeerDbDeployment());
    writeFileSync(path, JSON.stringify(artifacts));
    unusedDependencies.clickHouseClient.query.mockResolvedValueOnce({
      json: async () => [{ marker_count: "not-a-number" }],
    });
    verifyPeerDbDeployment.mockImplementationOnce(async (options) => {
      const artifact = artifacts[0];
      if (!artifact) throw new Error("Expected a deployment artifact fixture");
      await options.hasMarker(artifact);
    });

    await expect(
      runClickHouseCdcContractCommand("verify", path, unusedDependencies),
    ).rejects.toThrow();
  });
});
