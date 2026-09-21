import { captureException } from "../../lib/error-reporting.ts";
import type {
  PeerDbMirrorContract,
  PeerDbMirrorTableContract,
  PeerDbTableMapping,
} from "./mirror-contracts.ts";

export interface PeerDbMirrorStatus {
  currentFlowState: string;
  tableMappings: readonly PeerDbTableMapping[];
}

export interface PeerDbRemovedTableMapping {
  destinationTableIdentifier: string;
  sourceTableIdentifier: string;
}

export interface PeerDbCdcFlowConfigUpdate {
  additional_tables?: readonly PeerDbTableMapping[];
  removed_tables?: readonly PeerDbRemovedTableMapping[];
}

export interface PeerDbMirrorStateChangeRequest {
  flowJobName: string;
  requestedFlowState: "STATUS_PAUSED" | "STATUS_RUNNING";
  flowConfigUpdate?: {
    cdcFlowConfigUpdate: PeerDbCdcFlowConfigUpdate;
  };
}

export interface PeerDbMirrorListItem {
  destinationType: number | string;
  isCdc: boolean;
  name: string;
}

export interface PeerDbMirrorApiClient {
  getMirrorStatus(mirrorName: string): Promise<PeerDbMirrorStatus>;
  listMirrors(): Promise<PeerDbMirrorListItem[]>;
  changeMirrorState(request: PeerDbMirrorStateChangeRequest): Promise<void>;
}

const peerDbMirrorStatePollIntervalMs = 1_000;
const peerDbMirrorStatePollTimeoutMs = 120_000;

function apiMapping(mapping: PeerDbMirrorTableContract): PeerDbTableMapping {
  return {
    destinationTableIdentifier: mapping.destinationTableIdentifier,
    exclude: [...mapping.exclude],
    sourceTableIdentifier: mapping.sourceTableIdentifier,
  };
}

function exclusionsEqual(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    [...left].sort().every((column, index) => column === [...right].sort()[index])
  );
}

function mappingsEqual(left: PeerDbTableMapping, right: PeerDbTableMapping): boolean {
  return (
    left.sourceTableIdentifier === right.sourceTableIdentifier &&
    left.destinationTableIdentifier === right.destinationTableIdentifier &&
    exclusionsEqual(left.exclude, right.exclude)
  );
}

function hasMapping(status: PeerDbMirrorStatus, mapping: PeerDbTableMapping): boolean {
  return status.tableMappings.some((candidate) => mappingsEqual(candidate, mapping));
}

function hasRemovedMapping(
  status: PeerDbMirrorStatus,
  mapping: PeerDbRemovedTableMapping,
): boolean {
  return status.tableMappings.some(
    (candidate) =>
      candidate.sourceTableIdentifier === mapping.sourceTableIdentifier &&
      candidate.destinationTableIdentifier === mapping.destinationTableIdentifier,
  );
}

function isCanonical(status: PeerDbMirrorStatus, desiredMappings: readonly PeerDbTableMapping[]) {
  return (
    status.tableMappings.length === desiredMappings.length &&
    desiredMappings.every((mapping) => hasMapping(status, mapping))
  );
}

async function waitForPeerDbMirror(
  client: PeerDbMirrorApiClient,
  mirrorName: string,
  description: string,
  predicate: (status: PeerDbMirrorStatus) => boolean,
): Promise<PeerDbMirrorStatus> {
  const deadline = Date.now() + peerDbMirrorStatePollTimeoutMs;
  while (true) {
    const status = await client.getMirrorStatus(mirrorName);
    if (predicate(status)) return status;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for PeerDB mirror ${mirrorName} to ${description}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, peerDbMirrorStatePollIntervalMs));
  }
}

async function ensureMirrorPaused(
  client: PeerDbMirrorApiClient,
  mirrorName: string,
): Promise<void> {
  const status = await client.getMirrorStatus(mirrorName);
  if (status.currentFlowState === "STATUS_PAUSED") return;
  if (status.currentFlowState !== "STATUS_RUNNING") {
    throw new Error(
      `PeerDB mirror ${mirrorName} must be running or paused before reconciliation; current state is ${status.currentFlowState}`,
    );
  }
  await client.changeMirrorState({
    flowJobName: mirrorName,
    requestedFlowState: "STATUS_PAUSED",
  });
  await waitForPeerDbMirror(
    client,
    mirrorName,
    "reach STATUS_PAUSED",
    (currentStatus) => currentStatus.currentFlowState === "STATUS_PAUSED",
  );
}

function reconciliationChanges(
  status: PeerDbMirrorStatus,
  desiredMappings: readonly PeerDbTableMapping[],
): {
  additions: PeerDbTableMapping[];
  removals: PeerDbRemovedTableMapping[];
} {
  const removals = status.tableMappings
    .filter(
      (liveMapping) => !desiredMappings.some((desired) => mappingsEqual(liveMapping, desired)),
    )
    .map(({ destinationTableIdentifier, sourceTableIdentifier }) => ({
      destinationTableIdentifier,
      sourceTableIdentifier,
    }));
  const additions = desiredMappings.filter(
    (desiredMapping) => !status.tableMappings.some((live) => mappingsEqual(live, desiredMapping)),
  );
  return { additions, removals };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function pauseAfterFailure(
  client: PeerDbMirrorApiClient,
  mirrorName: string,
  reconciliationError: unknown,
): Promise<never> {
  captureException(reconciliationError, {
    tags: { mirror: mirrorName, operation: "peerdb-mirror-reconciliation" },
  });
  try {
    await ensureMirrorPaused(client, mirrorName);
  } catch (pauseError) {
    captureException(pauseError, {
      tags: { mirror: mirrorName, operation: "peerdb-mirror-reconciliation-pause" },
    });
    throw new AggregateError(
      [reconciliationError, pauseError],
      `PeerDB mirror ${mirrorName} reconciliation failed and the mirror could not be paused: ${errorMessage(reconciliationError)}; ${errorMessage(pauseError)}`,
    );
  }
  throw reconciliationError;
}

async function reconcileMirror(
  client: PeerDbMirrorApiClient,
  contract: PeerDbMirrorContract,
): Promise<void> {
  const initialStatus = await client.getMirrorStatus(contract.name);
  if (
    initialStatus.currentFlowState !== "STATUS_RUNNING" &&
    initialStatus.currentFlowState !== "STATUS_PAUSED"
  ) {
    throw new Error(
      `PeerDB mirror ${contract.name} must be running or paused before reconciliation; current state is ${initialStatus.currentFlowState}`,
    );
  }
  const desiredMappings = contract.tableMappings.map(apiMapping);
  const { additions, removals } = reconciliationChanges(initialStatus, desiredMappings);
  if (additions.length === 0 && removals.length === 0) return;

  try {
    await ensureMirrorPaused(client, contract.name);
    if (removals.length > 0) {
      await client.changeMirrorState({
        flowJobName: contract.name,
        requestedFlowState: "STATUS_RUNNING",
        flowConfigUpdate: { cdcFlowConfigUpdate: { removed_tables: removals } },
      });
      await waitForPeerDbMirror(
        client,
        contract.name,
        "resume without obsolete table mappings",
        (status) =>
          status.currentFlowState === "STATUS_RUNNING" &&
          removals.every((mapping) => !hasRemovedMapping(status, mapping)),
      );
    }
    if (additions.length > 0) {
      if (removals.length > 0) await ensureMirrorPaused(client, contract.name);
      await client.changeMirrorState({
        flowJobName: contract.name,
        requestedFlowState: "STATUS_RUNNING",
        flowConfigUpdate: { cdcFlowConfigUpdate: { additional_tables: additions } },
      });
      await waitForPeerDbMirror(
        client,
        contract.name,
        "resume with canonical table mappings",
        (status) =>
          status.currentFlowState === "STATUS_RUNNING" && isCanonical(status, desiredMappings),
      );
    } else {
      await waitForPeerDbMirror(
        client,
        contract.name,
        "resume with canonical table mappings",
        (status) =>
          status.currentFlowState === "STATUS_RUNNING" && isCanonical(status, desiredMappings),
      );
    }
  } catch (error) {
    await pauseAfterFailure(client, contract.name, error);
  }
}

export async function reconcileExistingPeerDbMirrors(
  client: PeerDbMirrorApiClient,
  existingMirrorNames: ReadonlySet<string>,
  contracts: readonly PeerDbMirrorContract[],
): Promise<void> {
  for (const contract of contracts) {
    if (existingMirrorNames.has(contract.name)) await reconcileMirror(client, contract);
  }
}
