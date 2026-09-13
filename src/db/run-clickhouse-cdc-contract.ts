import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Client } from "pg";
import { captureException } from "../lib/error-reporting.ts";
import { logger } from "../logger.ts";
import {
  createProcessingOperation,
  recordCanonicalCommit,
} from "../processing/processing-event-store.ts";
import { type ClickHouseClient, createClickHouseClientFromEnv } from "./clickhouse.ts";
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

export interface PeerDbContractCommandDependencies {
  clickHouseClient: ClickHouseClient;
  mirrorApiClient: PeerDbMirrorApiClient;
  prepareDestinationSchema(): Promise<void>;
  sourcePostgresClient: {
    query(queryText: string, values?: unknown[]): Promise<unknown>;
  };
  writeMarker(marker: PeerDbDeploymentMarkerInput): Promise<PeerDbDeploymentMarkerResult>;
}

const canaryTimeoutMs = 120_000;
const canaryPollIntervalMs = 1_000;

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
  clickHouseClient: ClickHouseClient,
  marker: PeerDbDeploymentCanary,
): Promise<boolean> {
  const result = await clickHouseClient.query<{ marker_count: number | string }>({
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
  const rows = await result.json();
  return Number(rows[0]?.marker_count ?? 0) === 1;
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
