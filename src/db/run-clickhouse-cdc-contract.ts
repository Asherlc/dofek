import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Client } from "pg";
import { z } from "zod";
import { captureException } from "../lib/error-reporting.ts";
import { logger } from "../logger.ts";
import {
  createProcessingOperation,
  recordCanonicalCommit,
} from "../processing/processing-event-store.ts";
import { createClickHouseClientFromEnv } from "./clickhouse.ts";
import { createPeerDbMirrorApiClientFromEnv } from "./clickhouse-cdc.ts";
import { runClickHouseMigrations } from "./clickhouse-migrations.ts";
import { createDatabaseFromEnv, type Database } from "./index.ts";
import { peerDbMirrorContracts } from "./peerdb/mirror-contracts.ts";
import {
  finalizePeerDbDeployment,
  type PeerDbDeploymentCanary,
  type PeerDbDeploymentMarkerInput,
  type PeerDbDeploymentMarkerResult,
  peerDbDeploymentArtifactSchema,
  preparePeerDbDeployment,
  verifyPeerDbDeployment,
} from "./peerdb/mirror-deployment.ts";
import type { PeerDbMirrorApiClient } from "./peerdb/mirror-reconciler.ts";

type PeerDbContractCommand = "prepare" | "finalize" | "verify";

interface PeerDbContractClickHouseClient {
  query(options: {
    query: string;
    format: "JSONEachRow";
    query_params?: Record<string, unknown>;
  }): Promise<{ json(): Promise<unknown> }>;
}

export interface PeerDbContractCommandDependencies {
  clickHouseClient: PeerDbContractClickHouseClient;
  mirrorApiClient: PeerDbMirrorApiClient;
  prepareDestinationSchema(): Promise<void>;
  sourcePostgresClient: {
    query(queryText: string, values?: unknown[]): Promise<unknown>;
  };
  writeMarker(marker: PeerDbDeploymentMarkerInput): Promise<PeerDbDeploymentMarkerResult>;
}

const canaryTimeoutMs = 120_000;
const canaryPollIntervalMs = 1_000;
const clickHouseCountSchema = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^\d+$/).transform(Number),
]);
const markerCountRowsSchema = z.tuple([z.object({ marker_count: clickHouseCountSchema })]);

function requireArtifactPath(command: "finalize" | "verify", path: string | undefined): string {
  if (!path) throw new Error(`${command} requires an artifact path`);
  return path;
}

export async function writePeerDbDeploymentMarker(
  database: Database,
  marker: { batchKey: string; datasetKey: "activity" | "providers"; flowName: string },
) {
  const operation = await createProcessingOperation(database, {
    userId: null,
    kind: "analytics_build",
    externalCorrelationKey: `peerdb-deploy-canary:${marker.batchKey}`,
    datasetKeys: [marker.datasetKey],
  });
  const commit = await recordCanonicalCommit(database, {
    operationId: operation.id,
    datasetKey: marker.datasetKey,
    sourceWatermark: marker.batchKey,
    flowNames: [marker.flowName],
    idempotencyKey: marker.batchKey,
  });
  if (!commit.sourceWatermark) {
    throw new Error(`PeerDB deployment canary ${marker.flowName} has no source watermark`);
  }
  return { operationId: operation.id, sourceWatermark: commit.sourceWatermark };
}

async function hasMarker(
  clickHouseClient: PeerDbContractClickHouseClient,
  marker: PeerDbDeploymentCanary,
): Promise<boolean> {
  const result = await clickHouseClient.query({
    query: `SELECT count() AS marker_count
      FROM ${marker.destinationDatabase}.${marker.destinationTableIdentifier} FINAL
      WHERE operation_id = {operationId:UUID}
        AND dataset_key = {datasetKey:String}
        AND flow_name = {flowName:String}
        AND batch_key = {batchKey:String}
        AND source_watermark = {sourceWatermark:String}
        AND _peerdb_is_deleted = 0`,
    query_params: marker,
    format: "JSONEachRow",
  });
  const [row] = markerCountRowsSchema.parse(await result.json());
  return row.marker_count === 1;
}

function assertCompleteDeploymentArtifacts(artifacts: readonly PeerDbDeploymentCanary[]): void {
  const remainingContracts = new Map<string, (typeof peerDbMirrorContracts)[number]>(
    peerDbMirrorContracts.map((contract) => [contract.processingMarker.flow, contract]),
  );
  if (artifacts.length !== remainingContracts.size) {
    throw new Error("PeerDB deployment artifact does not match the managed mirror contracts");
  }
  for (const artifact of artifacts) {
    const contract = remainingContracts.get(artifact.flowName);
    if (
      !contract ||
      artifact.datasetKey !== contract.processingMarker.datasetKey ||
      artifact.destinationDatabase !== contract.destinationDatabase ||
      artifact.destinationTableIdentifier !== contract.processingMarker.destinationTableIdentifier
    ) {
      throw new Error("PeerDB deployment artifact does not match the managed mirror contracts");
    }
    remainingContracts.delete(artifact.flowName);
  }
}

export async function runClickHouseCdcContractCommand(
  command: PeerDbContractCommand,
  artifactPath: string | undefined,
  dependencies: PeerDbContractCommandDependencies,
): Promise<void> {
  const validationDependencies = {
    clickHouseClient: dependencies.clickHouseClient,
    contracts: peerDbMirrorContracts,
    sourcePostgresClient: dependencies.sourcePostgresClient,
  };
  if (command === "prepare") {
    await dependencies.prepareDestinationSchema();
    await preparePeerDbDeployment({
      ...validationDependencies,
      mirrorApiClient: dependencies.mirrorApiClient,
    });
    return;
  }
  if (command === "finalize") {
    const path = requireArtifactPath(command, artifactPath);
    const artifacts = await finalizePeerDbDeployment({
      ...validationDependencies,
      createId: randomUUID,
      writeMarker: dependencies.writeMarker,
    });
    await writeFile(path, `${JSON.stringify(artifacts)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return;
  }

  const path = requireArtifactPath(command, artifactPath);
  const artifacts = peerDbDeploymentArtifactSchema.parse(JSON.parse(await readFile(path, "utf8")));
  assertCompleteDeploymentArtifacts(artifacts);
  await verifyPeerDbDeployment({
    artifacts,
    hasMarker: (marker) => hasMarker(dependencies.clickHouseClient, marker),
    now: Date.now,
    pollIntervalMs: canaryPollIntervalMs,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    timeoutMs: canaryTimeoutMs,
  });
}

export async function runClickHouseCdcContractCli(): Promise<void> {
  const command = process.argv[2];
  if (command !== "prepare" && command !== "finalize" && command !== "verify") {
    throw new Error("Expected PeerDB CDC contract command: prepare, finalize, or verify");
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL environment variable is required");
  const sourcePostgresClient = new Client({ connectionString: databaseUrl });
  const clickHouseClient = createClickHouseClientFromEnv();
  try {
    await sourcePostgresClient.connect();
    const database = createDatabaseFromEnv();
    await runClickHouseCdcContractCommand(command, process.argv[3], {
      clickHouseClient,
      mirrorApiClient: createPeerDbMirrorApiClientFromEnv(),
      prepareDestinationSchema: async () => {
        await runClickHouseMigrations(clickHouseClient, databaseUrl, { phase: "pre-cdc" });
      },
      sourcePostgresClient,
      writeMarker: (marker) => writePeerDbDeploymentMarker(database, marker),
    });
  } finally {
    await sourcePostgresClient.end();
    await clickHouseClient.close?.();
  }
}

const isDirectRun =
  typeof process.argv[1] === "string" &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));

if (isDirectRun) {
  runClickHouseCdcContractCli()
    .then(() => process.exit(0))
    .catch((error) => {
      captureException(error);
      logger.error(`[peerdb-cdc-contract] ${error}`);
      process.exit(1);
    });
}
