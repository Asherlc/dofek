import { z } from "zod";
import type { ProcessingDatasetKey } from "../../processing/dataset-contracts.ts";
import type { PeerDbMirrorContract } from "./mirror-contracts.ts";
import { type PeerDbMirrorApiClient, reconcileExistingPeerDbMirrors } from "./mirror-reconciler.ts";
import { assertPeerDbMirrorSchemasCompatible } from "./mirror-schema-validator.ts";

interface SourcePostgresClient {
  query(queryText: string, values?: unknown[]): Promise<unknown>;
}

interface ClickHouseClient {
  query(options: {
    query: string;
    format: "JSONEachRow";
    query_params?: Record<string, unknown>;
  }): Promise<{ json(): Promise<unknown> }>;
}

export const peerDbDeploymentCanarySchema = z.object({
  batchKey: z.uuid(),
  datasetKey: z.enum(["activity", "providers"]),
  destinationDatabase: z.string().min(1),
  destinationTableIdentifier: z.string().min(1),
  flowName: z.string().min(1),
  operationId: z.uuid(),
  sourceWatermark: z.uuid(),
});

export const peerDbDeploymentArtifactSchema = z.array(peerDbDeploymentCanarySchema).min(1);

export type PeerDbDeploymentCanary = z.infer<typeof peerDbDeploymentCanarySchema>;

export interface PeerDbDeploymentMarkerInput {
  batchKey: string;
  datasetKey: "activity" | "providers";
  flowName: string;
}

export interface PeerDbDeploymentMarkerResult {
  operationId: string;
  sourceWatermark: string;
}

interface PreparePeerDbDeploymentOptions {
  clickHouseClient: ClickHouseClient;
  contracts: readonly PeerDbMirrorContract[];
  mirrorApiClient: PeerDbMirrorApiClient;
  sourcePostgresClient: SourcePostgresClient;
}

interface FinalizePeerDbDeploymentOptions {
  clickHouseClient: ClickHouseClient;
  contracts: readonly PeerDbMirrorContract[];
  createId(): string;
  sourcePostgresClient: SourcePostgresClient;
  writeMarker(marker: PeerDbDeploymentMarkerInput): Promise<PeerDbDeploymentMarkerResult>;
}

interface VerifyPeerDbDeploymentOptions {
  artifacts: readonly PeerDbDeploymentCanary[];
  hasMarker(marker: PeerDbDeploymentCanary): Promise<boolean>;
  now(): number;
  pollIntervalMs: number;
  sleep(milliseconds: number): Promise<void>;
  timeoutMs: number;
}

function peerDbDeploymentTimeoutError(pending: ReadonlyMap<string, PeerDbDeploymentCanary>): Error {
  return new Error(
    `PeerDB deployment canary did not arrive: ${[...pending.keys()].sort().join(", ")}`,
  );
}

export async function preparePeerDbDeployment(
  options: PreparePeerDbDeploymentOptions,
): Promise<void> {
  const existingMirrors = await options.mirrorApiClient.listMirrors();
  const existingMirrorNames = new Set(
    existingMirrors.filter(({ isCdc }) => isCdc).map(({ name }) => name),
  );
  await reconcileExistingPeerDbMirrors(
    options.mirrorApiClient,
    existingMirrorNames,
    options.contracts,
  );
  await assertPeerDbMirrorSchemasCompatible(options);
}

export async function finalizePeerDbDeployment(
  options: FinalizePeerDbDeploymentOptions,
): Promise<PeerDbDeploymentCanary[]> {
  await assertPeerDbMirrorSchemasCompatible(options);
  const canaries: PeerDbDeploymentCanary[] = [];
  for (const contract of options.contracts) {
    const batchKey = options.createId();
    const marker = await options.writeMarker({
      batchKey,
      datasetKey: contract.processingMarker.datasetKey,
      flowName: contract.processingMarker.flow,
    });
    const canary = peerDbDeploymentCanarySchema.parse({
      batchKey,
      datasetKey: contract.processingMarker.datasetKey satisfies ProcessingDatasetKey,
      destinationDatabase: contract.destinationDatabase,
      destinationTableIdentifier: contract.processingMarker.destinationTableIdentifier,
      flowName: contract.processingMarker.flow,
      operationId: marker.operationId,
      sourceWatermark: marker.sourceWatermark,
    });
    canaries.push(canary);
  }
  return peerDbDeploymentArtifactSchema.parse(canaries);
}

export async function verifyPeerDbDeployment(
  options: VerifyPeerDbDeploymentOptions,
): Promise<void> {
  const pending = new Map(options.artifacts.map((artifact) => [artifact.flowName, artifact]));
  const deadline = options.now() + options.timeoutMs;
  for (;;) {
    if (pending.size === 0) return;
    for (const [flowName, artifact] of pending) {
      const remainingTimeoutMs = deadline - options.now();
      if (remainingTimeoutMs <= 0) break;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timeoutProbe = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(peerDbDeploymentTimeoutError(pending)),
          remainingTimeoutMs,
        );
      });
      const markerFound = await Promise.race([options.hasMarker(artifact), timeoutProbe]).finally(
        () => clearTimeout(timeout),
      );
      if (options.now() >= deadline) throw peerDbDeploymentTimeoutError(pending);
      if (markerFound) {
        pending.delete(flowName);
        if (pending.size === 0) return;
      }
    }
    if (options.now() >= deadline) {
      throw peerDbDeploymentTimeoutError(pending);
    }
    await options.sleep(options.pollIntervalMs);
  }
}
