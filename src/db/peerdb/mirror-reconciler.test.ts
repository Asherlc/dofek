import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PeerDbMirrorContract, PeerDbTableMapping } from "./mirror-contracts.ts";

const captureException = vi.hoisted(() => vi.fn());
vi.mock("../../lib/error-reporting.ts", () => ({ captureException }));

import {
  type PeerDbMirrorApiClient,
  type PeerDbMirrorStateChangeRequest,
  reconcileExistingPeerDbMirrors,
} from "./mirror-reconciler.ts";

const canonicalMapping = {
  sourceTableIdentifier: "fitness.daily_metrics",
  destinationTableIdentifier: "daily_metrics",
  exclude: ["stress_high_minutes"],
  allowAbsentExcludedSourceColumns: ["stress_high_minutes"],
} as const;
const contract = [
  {
    destinationDatabase: "postgres_fitness",
    initialCopyPlaceholder: "TEST_INITIAL_COPY",
    name: "test_mirror",
    processingMarker: undefined,
    tableMappingsPlaceholder: "TEST_TABLE_MAPPINGS",
    tableMappings: [canonicalMapping],
  },
] satisfies readonly PeerDbMirrorContract[];

function statefulApi(initialMappings: PeerDbTableMapping[]) {
  let currentFlowState = "STATUS_RUNNING";
  let tableMappings: PeerDbTableMapping[] = initialMappings;
  const requests: PeerDbMirrorStateChangeRequest[] = [];
  const client: PeerDbMirrorApiClient = {
    async changeMirrorState(request) {
      requests.push(request);
      currentFlowState = request.requestedFlowState;
      const update = request.flowConfigUpdate?.cdcFlowConfigUpdate;
      if (update?.removed_tables) {
        const removedSources = new Set(
          update.removed_tables.map(({ sourceTableIdentifier }) => sourceTableIdentifier),
        );
        tableMappings = tableMappings.filter(
          ({ sourceTableIdentifier }) => !removedSources.has(sourceTableIdentifier),
        );
      }
      if (update?.additional_tables) {
        tableMappings = [...tableMappings, ...update.additional_tables];
      }
    },
    async getMirrorStatus() {
      return { currentFlowState, tableMappings };
    },
    async listMirrors() {
      return [];
    },
  };
  return {
    client,
    requests,
    readMappings: () => tableMappings,
    readState: () => currentFlowState,
  };
}

describe("PeerDB mirror reconciler", () => {
  beforeEach(() => captureException.mockReset());
  afterEach(() => vi.useRealTimers());

  it("does nothing when the live mapping exactly matches the contract", async () => {
    const api = statefulApi([
      {
        sourceTableIdentifier: canonicalMapping.sourceTableIdentifier,
        destinationTableIdentifier: canonicalMapping.destinationTableIdentifier,
        exclude: [...canonicalMapping.exclude],
      },
    ]);

    await reconcileExistingPeerDbMirrors(api.client, new Set(["test_mirror"]), contract);

    expect(api.requests).toEqual([]);
  });

  it("treats exclusion order as immaterial", async () => {
    const baseContract = contract[0];
    if (!baseContract) throw new Error("Missing test mirror contract");
    const orderedContract = [
      {
        ...baseContract,
        tableMappings: [{ ...canonicalMapping, exclude: ["first", "second"] }],
      },
    ];
    const api = statefulApi([
      {
        sourceTableIdentifier: canonicalMapping.sourceTableIdentifier,
        destinationTableIdentifier: canonicalMapping.destinationTableIdentifier,
        exclude: ["second", "first"],
      },
    ]);

    await reconcileExistingPeerDbMirrors(api.client, new Set(["test_mirror"]), orderedContract);

    expect(api.requests).toEqual([]);
  });

  it("remaps changed exclusions through two verified pause-edit-resume cycles", async () => {
    const api = statefulApi([
      {
        sourceTableIdentifier: canonicalMapping.sourceTableIdentifier,
        destinationTableIdentifier: canonicalMapping.destinationTableIdentifier,
        exclude: [],
      },
    ]);

    await reconcileExistingPeerDbMirrors(api.client, new Set(["test_mirror"]), contract);

    expect(api.requests).toEqual([
      { flowJobName: "test_mirror", requestedFlowState: "STATUS_PAUSED" },
      {
        flowJobName: "test_mirror",
        requestedFlowState: "STATUS_RUNNING",
        flowConfigUpdate: {
          cdcFlowConfigUpdate: {
            removed_tables: [
              {
                destinationTableIdentifier: "daily_metrics",
                sourceTableIdentifier: "fitness.daily_metrics",
              },
            ],
          },
        },
      },
      { flowJobName: "test_mirror", requestedFlowState: "STATUS_PAUSED" },
      {
        flowJobName: "test_mirror",
        requestedFlowState: "STATUS_RUNNING",
        flowConfigUpdate: {
          cdcFlowConfigUpdate: {
            additional_tables: [
              {
                destinationTableIdentifier: "daily_metrics",
                exclude: ["stress_high_minutes"],
                sourceTableIdentifier: "fitness.daily_metrics",
              },
            ],
          },
        },
      },
    ]);
    expect(api.readMappings()).toEqual([
      {
        destinationTableIdentifier: "daily_metrics",
        exclude: ["stress_high_minutes"],
        sourceTableIdentifier: "fitness.daily_metrics",
      },
    ]);
  });

  it("adds a missing mapping in one pause-edit-resume cycle", async () => {
    const api = statefulApi([]);

    await reconcileExistingPeerDbMirrors(api.client, new Set(["test_mirror"]), contract);

    expect(api.requests).toEqual([
      { flowJobName: "test_mirror", requestedFlowState: "STATUS_PAUSED" },
      {
        flowJobName: "test_mirror",
        requestedFlowState: "STATUS_RUNNING",
        flowConfigUpdate: {
          cdcFlowConfigUpdate: {
            additional_tables: [
              {
                destinationTableIdentifier: "daily_metrics",
                exclude: ["stress_high_minutes"],
                sourceTableIdentifier: "fitness.daily_metrics",
              },
            ],
          },
        },
      },
    ]);
  });

  it("removes mappings outside the canonical contract", async () => {
    const api = statefulApi([
      {
        sourceTableIdentifier: canonicalMapping.sourceTableIdentifier,
        destinationTableIdentifier: canonicalMapping.destinationTableIdentifier,
        exclude: [...canonicalMapping.exclude],
      },
      {
        sourceTableIdentifier: "fitness.legacy",
        destinationTableIdentifier: "legacy",
        exclude: [],
      },
    ]);

    await reconcileExistingPeerDbMirrors(api.client, new Set(["test_mirror"]), contract);

    expect(api.requests.at(1)?.flowConfigUpdate?.cdcFlowConfigUpdate.removed_tables).toEqual([
      {
        destinationTableIdentifier: "legacy",
        sourceTableIdentifier: "fitness.legacy",
      },
    ]);
    expect(api.readMappings()).toEqual([
      {
        sourceTableIdentifier: canonicalMapping.sourceTableIdentifier,
        destinationTableIdentifier: canonicalMapping.destinationTableIdentifier,
        exclude: [...canonicalMapping.exclude],
      },
    ]);
  });

  it("pauses and reports an edit failure instead of resuming an unverified mapping", async () => {
    const api = statefulApi([]);
    const editFailure = new Error("add failed");
    const originalChangeMirrorState = api.client.changeMirrorState.bind(api.client);
    const changeMirrorState = vi
      .spyOn(api.client, "changeMirrorState")
      .mockImplementation(async (request) => {
        if (request.flowConfigUpdate?.cdcFlowConfigUpdate.additional_tables) throw editFailure;
        await originalChangeMirrorState(request);
      });

    await expect(
      reconcileExistingPeerDbMirrors(api.client, new Set(["test_mirror"]), contract),
    ).rejects.toThrow("add failed");

    expect(changeMirrorState).toHaveBeenCalledTimes(2);
    expect(api.readState()).toBe("STATUS_PAUSED");
    expect(captureException).toHaveBeenCalledWith(editFailure, {
      tags: { mirror: "test_mirror", operation: "peerdb-mirror-reconciliation" },
    });
  });

  it("times out on a read-back mismatch and pauses the mirror", async () => {
    vi.useFakeTimers();
    let currentFlowState = "STATUS_RUNNING";
    const requests: PeerDbMirrorStateChangeRequest[] = [];
    const client: PeerDbMirrorApiClient = {
      async changeMirrorState(request) {
        requests.push(request);
        currentFlowState = request.requestedFlowState;
      },
      async getMirrorStatus() {
        return { currentFlowState, tableMappings: [] };
      },
      async listMirrors() {
        return [];
      },
    };

    const reconciliation = reconcileExistingPeerDbMirrors(
      client,
      new Set(["test_mirror"]),
      contract,
    );
    const rejection = expect(reconciliation).rejects.toThrow(
      "Timed out waiting for PeerDB mirror test_mirror to resume with canonical table mappings",
    );
    await vi.advanceTimersByTimeAsync(121_000);

    await rejection;
    expect(currentFlowState).toBe("STATUS_PAUSED");
    expect(requests.at(-1)).toEqual({
      flowJobName: "test_mirror",
      requestedFlowState: "STATUS_PAUSED",
    });
  });

  it("rejects a mirror state that cannot be edited", async () => {
    const api = statefulApi([]);
    vi.spyOn(api.client, "getMirrorStatus").mockResolvedValue({
      currentFlowState: "STATUS_TERMINATING",
      tableMappings: [],
    });

    await expect(
      reconcileExistingPeerDbMirrors(api.client, new Set(["test_mirror"]), contract),
    ).rejects.toThrow(
      "PeerDB mirror test_mirror must be running or paused before reconciliation; current state is STATUS_TERMINATING",
    );
    expect(api.requests).toEqual([]);
  });
});
