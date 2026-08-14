import type { SQLWrapper } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { PeerDbMirrorApiClient, PeerDbMirrorListItem } from "../db/clickhouse-cdc.ts";
import {
  capturePeerDbStagingInventory,
  type PeerDbStagingInventory,
  type PeerDbStagingStorage,
  peerDbStagingInventoriesEqual,
} from "./peerdb-staging-retention.ts";

const CLICKHOUSE_DB_TYPE = 8;
const BARRIER_LOCK_NAME = "dofek:peerdb-staging-account-erasure-boundary";
const BARRIER_POLL_INTERVAL_MS = 1_000;
const BARRIER_POLL_TIMEOUT_MS = 120_000;

interface PeerDbStagingBarrierTransaction {
  execute(query: SQLWrapper | string): Promise<Record<string, unknown>[]>;
}

export interface PeerDbStagingBarrierDatabase {
  transaction<T>(
    operation: (transaction: PeerDbStagingBarrierTransaction) => Promise<T>,
  ): Promise<T>;
}

const pausedMirrorSchema = z.object({
  name: z.string().min(1),
  status: z.literal("STATUS_PAUSED"),
});

const boundarySchema = z.object({
  cutoff: z.iso.datetime(),
  eTag: z.string().min(1),
  key: z.string().min(1),
  mirrors: z.array(pausedMirrorSchema),
});

export type PeerDbStagingBoundary = z.infer<typeof boundarySchema>;

const pauseRequestedProgressSchema = z.object({
  boundaryKey: z.string().min(1),
  mirrorNames: z.array(z.string().min(1)),
  stage: z.literal("pause_requested"),
});
const boundaryCapturedProgressSchema = z.object({
  boundary: boundarySchema,
  stage: z.literal("boundary_captured"),
});
const barrierProgressSchema = z.discriminatedUnion("stage", [
  pauseRequestedProgressSchema,
  boundaryCapturedProgressSchema,
]);

interface BarrierExecution {
  loadProgress(): Promise<Record<string, unknown> | null>;
  requestId: string;
  saveProgress(progress: Record<string, unknown>): Promise<void>;
}

interface BarrierTiming {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

const defaultTiming: BarrierTiming = {
  now: Date.now,
  sleep: (milliseconds) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    }),
};

function isClickHouseMirror(mirror: PeerDbMirrorListItem): boolean {
  return mirror.destinationType === "CLICKHOUSE" || mirror.destinationType === CLICKHOUSE_DB_TYPE;
}

function clickHouseWriterNames(mirrors: readonly PeerDbMirrorListItem[]): string[] {
  const clickHouseMirrors = mirrors.filter(isClickHouseMirror);
  for (const mirror of clickHouseMirrors) {
    if (!mirror.isCdc) {
      throw new Error(`PeerDB ClickHouse staging writer ${mirror.name} is not CDC`);
    }
  }
  const names = clickHouseMirrors.map((mirror) => mirror.name).sort();
  if (names.length === 0) {
    throw new Error("PeerDB did not return any ClickHouse CDC staging writers");
  }
  if (new Set(names).size !== names.length) {
    throw new Error("PeerDB returned duplicate ClickHouse staging writer identities");
  }
  return names;
}

function sameNames(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((name, index) => name === expected[index])
  );
}

async function waitForMirrorState(
  mirrorApi: PeerDbMirrorApiClient,
  mirrorName: string,
  expectedState: "STATUS_PAUSED" | "STATUS_RUNNING",
  timing: BarrierTiming,
): Promise<void> {
  const deadline = timing.now() + BARRIER_POLL_TIMEOUT_MS;
  while (true) {
    const status = await mirrorApi.getMirrorStatus(mirrorName);
    if (status.currentFlowState === expectedState) return;
    if (timing.now() >= deadline) {
      throw new Error(
        `Timed out waiting for PeerDB ClickHouse staging writer ${mirrorName} to reach ${expectedState}`,
      );
    }
    await timing.sleep(BARRIER_POLL_INTERVAL_MS);
  }
}

async function requireInitiallyRunning(
  mirrorApi: PeerDbMirrorApiClient,
  mirrorNames: readonly string[],
): Promise<void> {
  for (const mirrorName of mirrorNames) {
    const status = await mirrorApi.getMirrorStatus(mirrorName);
    if (status.currentFlowState !== "STATUS_RUNNING") {
      throw new Error(
        `PeerDB ClickHouse staging writer ${mirrorName} must be running before account-erasure quiescence; current state is ${status.currentFlowState}`,
      );
    }
  }
}

async function pauseWriters(
  mirrorApi: PeerDbMirrorApiClient,
  mirrorNames: readonly string[],
  timing: BarrierTiming,
): Promise<void> {
  for (const mirrorName of mirrorNames) {
    const status = await mirrorApi.getMirrorStatus(mirrorName);
    if (status.currentFlowState === "STATUS_RUNNING") {
      await mirrorApi.changeMirrorState({
        flowJobName: mirrorName,
        requestedFlowState: "STATUS_PAUSED",
      });
    } else if (
      status.currentFlowState !== "STATUS_PAUSING" &&
      status.currentFlowState !== "STATUS_PAUSED"
    ) {
      throw new Error(
        `PeerDB ClickHouse staging writer ${mirrorName} cannot be quiesced from ${status.currentFlowState}`,
      );
    }
  }
  for (const mirrorName of mirrorNames) {
    await waitForMirrorState(mirrorApi, mirrorName, "STATUS_PAUSED", timing);
  }
}

async function resumeWriters(
  mirrorApi: PeerDbMirrorApiClient,
  mirrorNames: readonly string[],
  timing: BarrierTiming,
): Promise<void> {
  const results = await Promise.allSettled(
    mirrorNames.map(async (mirrorName) => {
      let status = await mirrorApi.getMirrorStatus(mirrorName);
      if (status.currentFlowState === "STATUS_PAUSING") {
        await waitForMirrorState(mirrorApi, mirrorName, "STATUS_PAUSED", timing);
        status = await mirrorApi.getMirrorStatus(mirrorName);
      }
      if (status.currentFlowState === "STATUS_PAUSED") {
        await mirrorApi.changeMirrorState({
          flowJobName: mirrorName,
          requestedFlowState: "STATUS_RUNNING",
        });
      } else if (status.currentFlowState !== "STATUS_RUNNING") {
        throw new Error(
          `PeerDB ClickHouse staging writer ${mirrorName} cannot be resumed from ${status.currentFlowState}`,
        );
      }
      await waitForMirrorState(mirrorApi, mirrorName, "STATUS_RUNNING", timing);
    }),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "Unable to resume every PeerDB ClickHouse staging writer");
  }
}

async function assertWriterSetPaused(
  mirrorApi: PeerDbMirrorApiClient,
  expectedNames: readonly string[],
  phase:
    | "before marker capture"
    | "between storage inventory passes"
    | "before boundary persistence",
): Promise<void> {
  const actualNames = clickHouseWriterNames(await mirrorApi.listMirrors());
  if (!sameNames(actualNames, expectedNames)) {
    throw new Error(
      "PeerDB ClickHouse staging writer set changed during account-erasure quiescence",
    );
  }
  for (const mirrorName of expectedNames) {
    const status = await mirrorApi.getMirrorStatus(mirrorName);
    if (status.currentFlowState !== "STATUS_PAUSED") {
      throw new Error(`PeerDB ClickHouse staging writer ${mirrorName} left STATUS_PAUSED ${phase}`);
    }
  }
}

function boundaryKey(requestId: string): string {
  return `account-erasure-boundaries/${z.uuid().parse(requestId)}`;
}

function requireMarkerInInventory(
  inventory: PeerDbStagingInventory,
  marker: { eTag: string; key: string },
): void {
  if (
    !inventory.objects.some((object) => object.key === marker.key && object.eTag === marker.eTag)
  ) {
    throw new Error("PeerDB staging inventory did not contain the exact boundary marker");
  }
}

function storageCutoff(
  markerLastModified: Date,
  inventories: readonly PeerDbStagingInventory[],
): Date {
  let cutoff = markerLastModified;
  for (const inventory of inventories) {
    if (inventory.latestStorageTimestamp && inventory.latestStorageTimestamp > cutoff) {
      cutoff = inventory.latestStorageTimestamp;
    }
  }
  return cutoff;
}

export async function capturePeerDbStagingBoundary(
  database: PeerDbStagingBarrierDatabase,
  mirrorApi: PeerDbMirrorApiClient,
  storage: PeerDbStagingStorage,
  execution: BarrierExecution,
  timing: BarrierTiming = defaultTiming,
): Promise<PeerDbStagingBoundary> {
  return database.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${BARRIER_LOCK_NAME}, 0))`,
    );

    const storedProgress = barrierProgressSchema.nullable().parse(await execution.loadProgress());
    if (storedProgress?.stage === "boundary_captured") {
      const capturedBoundary = storedProgress.boundary;
      await resumeWriters(
        mirrorApi,
        capturedBoundary.mirrors.map((mirror) => mirror.name),
        timing,
      );
      return capturedBoundary;
    }

    let markerKey: string;
    let mirrorNames: string[];
    if (storedProgress) {
      markerKey = storedProgress.boundaryKey;
      mirrorNames = [...storedProgress.mirrorNames].sort();
    } else {
      markerKey = boundaryKey(execution.requestId);
      mirrorNames = clickHouseWriterNames(await mirrorApi.listMirrors());
      await requireInitiallyRunning(mirrorApi, mirrorNames);
      await execution.saveProgress({
        boundaryKey: markerKey,
        mirrorNames,
        stage: "pause_requested",
      });
    }

    try {
      await pauseWriters(mirrorApi, mirrorNames, timing);
      await assertWriterSetPaused(mirrorApi, mirrorNames, "before marker capture");
      const marker = await storage.createBoundaryMarker(markerKey);
      const firstInventory = await capturePeerDbStagingInventory(storage);
      requireMarkerInInventory(firstInventory, { eTag: marker.eTag, key: markerKey });
      await assertWriterSetPaused(mirrorApi, mirrorNames, "between storage inventory passes");
      const secondInventory = await capturePeerDbStagingInventory(storage);
      requireMarkerInInventory(secondInventory, { eTag: marker.eTag, key: markerKey });
      await assertWriterSetPaused(mirrorApi, mirrorNames, "before boundary persistence");
      if (!peerDbStagingInventoriesEqual(firstInventory, secondInventory)) {
        throw new Error(
          "PeerDB staging storage inventory changed during account-erasure quiescence",
        );
      }
      const boundary = boundarySchema.parse({
        cutoff: storageCutoff(marker.lastModified, [firstInventory, secondInventory]).toISOString(),
        eTag: marker.eTag,
        key: markerKey,
        mirrors: mirrorNames.map((name) => ({
          name,
          status: "STATUS_PAUSED",
        })),
      });
      await execution.saveProgress({
        boundary,
        stage: "boundary_captured",
      });
      return boundary;
    } finally {
      await resumeWriters(mirrorApi, mirrorNames, timing);
    }
  });
}
