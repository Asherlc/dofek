import { describe, expect, it, vi } from "vitest";
import type { PeerDbMirrorApiClient } from "../db/clickhouse-cdc.ts";
import type { PeerDbStagingStorage } from "./peerdb-staging-retention.ts";
import {
  capturePeerDbStagingBoundary,
  type PeerDbStagingBarrierDatabase,
  type PeerDbStagingBoundary,
} from "./peerdb-staging-writer-barrier.ts";

const requestId = "10000000-0000-4000-8000-000000001994";
const boundaryKey = `account-erasure-boundaries/${requestId}`;
const boundary: PeerDbStagingBoundary = {
  cutoff: "2026-08-03T12:00:00.000Z",
  eTag: '"boundary-etag"',
  key: boundaryKey,
  mirrors: [
    {
      name: "dofek_fitness_raw_analytics",
      status: "STATUS_PAUSED",
    },
    {
      name: "operator_clickhouse_mirror",
      status: "STATUS_PAUSED",
    },
  ],
};

function barrierDatabase(events: string[]): PeerDbStagingBarrierDatabase {
  return {
    async transaction(operation) {
      events.push("transaction");
      return operation({
        async execute() {
          events.push("advisory-lock");
          return [];
        },
      });
    },
  };
}

function mirrorApi(
  events: string[],
  overrides: Partial<PeerDbMirrorApiClient> = {},
): PeerDbMirrorApiClient {
  const states = new Map([
    ["dofek_fitness_raw_analytics", "STATUS_RUNNING"],
    ["operator_clickhouse_mirror", "STATUS_RUNNING"],
  ]);
  return {
    async changeMirrorState(request) {
      events.push(`${request.requestedFlowState}:${request.flowJobName}`);
      states.set(request.flowJobName, request.requestedFlowState);
    },
    async getMirrorStatus(name) {
      events.push(`status:${name}`);
      return {
        currentFlowState: states.get(name) ?? "STATUS_UNKNOWN",
        tableMappings: [],
      };
    },
    async listMirrors() {
      events.push("list-mirrors");
      return [
        {
          destinationType: "CLICKHOUSE",
          isCdc: true,
          name: "dofek_fitness_raw_analytics",
        },
        {
          destinationType: "CLICKHOUSE",
          isCdc: true,
          name: "operator_clickhouse_mirror",
        },
        {
          destinationType: "POSTGRES",
          isCdc: true,
          name: "unrelated_postgres_mirror",
        },
      ];
    },
    ...overrides,
  };
}

function storage(
  events: string[],
  overrides: Partial<PeerDbStagingStorage> = {},
): PeerDbStagingStorage {
  return {
    async createBoundaryMarker(key) {
      events.push(`marker:${key}`);
      return {
        eTag: boundary.eTag,
        lastModified: new Date(boundary.cutoff),
      };
    },
    async getLifecycleConfiguration() {
      return { rules: [] };
    },
    async getVersioningStatus() {
      return null;
    },
    async listMultipartUploads() {
      return {
        isTruncated: false,
        nextKeyMarker: null,
        nextUploadIdMarker: null,
        uploads: [],
      };
    },
    async listObjects() {
      return {
        isTruncated: false,
        nextContinuationToken: null,
        objects: [
          {
            eTag: boundary.eTag,
            key: boundaryKey,
            lastModified: new Date(boundary.cutoff),
          },
        ],
      };
    },
    ...overrides,
  };
}

describe("capturePeerDbStagingBoundary", () => {
  it("pauses every ClickHouse CDC writer, persists a storage marker, then resumes", async () => {
    const events: string[] = [];
    const saveProgress = vi.fn(async (progress: Record<string, unknown>) => {
      const stage = typeof progress.stage === "string" ? progress.stage : "unknown";
      events.push(`save:${stage}`);
    });

    await expect(
      capturePeerDbStagingBoundary(barrierDatabase(events), mirrorApi(events), storage(events), {
        loadProgress: vi.fn(async () => null),
        requestId,
        saveProgress,
      }),
    ).resolves.toEqual(boundary);

    expect(events.filter((event) => event === "list-mirrors")).toHaveLength(4);
    expect(events.indexOf("advisory-lock")).toBeLessThan(events.indexOf("list-mirrors"));
    expect(events.indexOf("save:pause_requested")).toBeLessThan(
      events.indexOf("STATUS_PAUSED:dofek_fitness_raw_analytics"),
    );
    expect(events.indexOf(`marker:${boundaryKey}`)).toBeLessThan(
      events.indexOf("save:boundary_captured"),
    );
    expect(events.indexOf("save:boundary_captured")).toBeLessThan(
      events.indexOf("STATUS_RUNNING:dofek_fitness_raw_analytics"),
    );
    expect(saveProgress).toHaveBeenNthCalledWith(1, {
      boundaryKey,
      mirrorNames: ["dofek_fitness_raw_analytics", "operator_clickhouse_mirror"],
      stage: "pause_requested",
    });
    expect(saveProgress).toHaveBeenNthCalledWith(2, {
      boundary,
      stage: "boundary_captured",
    });
  });

  it("fails closed when a ClickHouse writer is not a pausable CDC mirror", async () => {
    const events: string[] = [];
    const api = mirrorApi(events, {
      listMirrors: vi.fn(async () => [
        {
          destinationType: "CLICKHOUSE",
          isCdc: false,
          name: "clickhouse_initial_snapshot",
        },
      ]),
    });
    const saveProgress = vi.fn(async () => undefined);

    await expect(
      capturePeerDbStagingBoundary(barrierDatabase(events), api, storage(events), {
        loadProgress: vi.fn(async () => null),
        requestId,
        saveProgress,
      }),
    ).rejects.toThrow("PeerDB ClickHouse staging writer clickhouse_initial_snapshot is not CDC");

    expect(saveProgress).not.toHaveBeenCalled();
    expect(events.some((event) => event.startsWith("STATUS_"))).toBe(false);
  });

  it("fails closed when PeerDB does not expose any ClickHouse CDC staging writer", async () => {
    const events: string[] = [];
    const saveProgress = vi.fn(async () => undefined);

    await expect(
      capturePeerDbStagingBoundary(
        barrierDatabase(events),
        mirrorApi(events, {
          listMirrors: vi.fn(async () => []),
        }),
        storage(events),
        {
          loadProgress: vi.fn(async () => null),
          requestId,
          saveProgress,
        },
      ),
    ).rejects.toThrow("PeerDB did not return any ClickHouse CDC staging writers");

    expect(saveProgress).not.toHaveBeenCalled();
    expect(events.some((event) => event.startsWith("STATUS_"))).toBe(false);
  });

  it("rejects duplicate ClickHouse writer identities", async () => {
    const events: string[] = [];
    await expect(
      capturePeerDbStagingBoundary(
        barrierDatabase(events),
        mirrorApi(events, {
          listMirrors: vi.fn(async () => [
            { destinationType: 8, isCdc: true, name: "duplicate-writer" },
            { destinationType: "CLICKHOUSE", isCdc: true, name: "duplicate-writer" },
          ]),
        }),
        storage(events),
        {
          loadProgress: vi.fn(async () => null),
          requestId,
          saveProgress: vi.fn(async () => undefined),
        },
      ),
    ).rejects.toThrow("duplicate ClickHouse staging writer identities");
  });

  it("detects a same-sized writer set with a different identity", async () => {
    const events: string[] = [];
    let state = "STATUS_RUNNING";
    const listMirrors = vi
      .fn<PeerDbMirrorApiClient["listMirrors"]>()
      .mockResolvedValueOnce([{ destinationType: "CLICKHOUSE", isCdc: true, name: "writer-a" }])
      .mockResolvedValueOnce([{ destinationType: "CLICKHOUSE", isCdc: true, name: "writer-b" }]);
    const api = mirrorApi(events, {
      listMirrors,
      getMirrorStatus: vi.fn(async (name) => {
        events.push(`status:${name}`);
        return { currentFlowState: state, tableMappings: [] };
      }),
      changeMirrorState: vi.fn(async (request) => {
        state = request.requestedFlowState;
        events.push(`${request.requestedFlowState}:${request.flowJobName}`);
      }),
    });

    await expect(
      capturePeerDbStagingBoundary(barrierDatabase(events), api, storage(events), {
        loadProgress: vi.fn(async () => null),
        requestId,
        saveProgress: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow("writer set changed during account-erasure quiescence");
  });

  it("preserves a pre-existing operator pause when no durable intent owns it", async () => {
    const events: string[] = [];
    const api = mirrorApi(events, {
      getMirrorStatus: vi.fn(async () => ({
        currentFlowState: "STATUS_PAUSED",
        tableMappings: [],
      })),
    });

    await expect(
      capturePeerDbStagingBoundary(barrierDatabase(events), api, storage(events), {
        loadProgress: vi.fn(async () => null),
        requestId,
        saveProgress: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow(
      "PeerDB ClickHouse staging writer dofek_fitness_raw_analytics must be running before account-erasure quiescence",
    );

    expect(events.some((event) => event.startsWith("STATUS_"))).toBe(false);
  });

  it("re-lists after pausing and compensates when the writer identity set changes", async () => {
    const events: string[] = [];
    const listMirrors = vi
      .fn<PeerDbMirrorApiClient["listMirrors"]>()
      .mockResolvedValueOnce([
        {
          destinationType: "CLICKHOUSE",
          isCdc: true,
          name: "dofek_fitness_raw_analytics",
        },
      ])
      .mockResolvedValueOnce([
        {
          destinationType: "CLICKHOUSE",
          isCdc: true,
          name: "dofek_fitness_raw_analytics",
        },
        {
          destinationType: "CLICKHOUSE",
          isCdc: true,
          name: "new_clickhouse_writer",
        },
      ]);
    const api = mirrorApi(events, { listMirrors });

    await expect(
      capturePeerDbStagingBoundary(barrierDatabase(events), api, storage(events), {
        loadProgress: vi.fn(async () => null),
        requestId,
        saveProgress: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow(
      "PeerDB ClickHouse staging writer set changed during account-erasure quiescence",
    );

    expect(events).toContain("STATUS_RUNNING:dofek_fitness_raw_analytics");
    expect(events).not.toContain(`marker:${boundaryKey}`);
  });

  it("compensates when durable boundary persistence fails and leaves retry intent intact", async () => {
    const events: string[] = [];
    const persistenceError = new Error("account-erasure progress unavailable");
    const saveProgress = vi
      .fn<(progress: Record<string, unknown>) => Promise<void>>()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(persistenceError);

    await expect(
      capturePeerDbStagingBoundary(barrierDatabase(events), mirrorApi(events), storage(events), {
        loadProgress: vi.fn(async () => null),
        requestId,
        saveProgress,
      }),
    ).rejects.toBe(persistenceError);

    expect(events).toContain(`marker:${boundaryKey}`);
    expect(events).toContain("STATUS_RUNNING:dofek_fitness_raw_analytics");
    expect(saveProgress).toHaveBeenCalledTimes(2);
  });

  it("finishes a persisted resume without replacing the captured boundary", async () => {
    const events: string[] = [];
    const api = mirrorApi(events, {
      getMirrorStatus: vi
        .fn<PeerDbMirrorApiClient["getMirrorStatus"]>()
        .mockResolvedValueOnce({ currentFlowState: "STATUS_PAUSED", tableMappings: [] })
        .mockResolvedValue({ currentFlowState: "STATUS_RUNNING", tableMappings: [] }),
    });
    const createBoundaryMarker = vi.fn<PeerDbStagingStorage["createBoundaryMarker"]>();

    await expect(
      capturePeerDbStagingBoundary(
        barrierDatabase(events),
        api,
        storage(events, { createBoundaryMarker }),
        {
          loadProgress: vi.fn(async () => ({
            boundary,
            stage: "boundary_captured",
          })),
          requestId,
          saveProgress: vi.fn(async () => undefined),
        },
      ),
    ).resolves.toEqual(boundary);

    expect(createBoundaryMarker).not.toHaveBeenCalled();
    expect(events).not.toContain("list-mirrors");
    expect(events).toContain("STATUS_RUNNING:dofek_fitness_raw_analytics");
  });

  it("finishes a persisted pause request after a writer reaches paused state", async () => {
    const events: string[] = [];
    let state = "STATUS_PAUSING";
    const api = mirrorApi(events, {
      listMirrors: vi.fn(async () => [
        {
          destinationType: "CLICKHOUSE",
          isCdc: true,
          name: "dofek_fitness_raw_analytics",
        },
      ]),
      getMirrorStatus: vi.fn(async (name) => {
        const currentFlowState = state;
        events.push(`status:${name}`);
        if (state === "STATUS_PAUSING") state = "STATUS_PAUSED";
        return { currentFlowState, tableMappings: [] };
      }),
      changeMirrorState: vi.fn(async (request) => {
        state = request.requestedFlowState;
        events.push(`${request.requestedFlowState}:${request.flowJobName}`);
      }),
    });

    await expect(
      capturePeerDbStagingBoundary(barrierDatabase(events), api, storage(events), {
        loadProgress: vi.fn(async () => ({
          boundaryKey,
          mirrorNames: ["dofek_fitness_raw_analytics"],
          stage: "pause_requested",
        })),
        requestId,
        saveProgress: vi.fn(async () => undefined),
      }),
    ).resolves.toEqual({
      ...boundary,
      mirrors: [{ name: "dofek_fitness_raw_analytics", status: "STATUS_PAUSED" }],
    });
  });

  it("times out when a persisted resume never reaches running state", async () => {
    const events: string[] = [];
    let statusCalls = 0;
    const api = mirrorApi(events, {
      getMirrorStatus: vi.fn(async (name) => {
        statusCalls += 1;
        events.push(`status:${name}`);
        return {
          currentFlowState: statusCalls === 1 ? "STATUS_PAUSED" : "STATUS_PAUSING",
          tableMappings: [],
        };
      }),
      changeMirrorState: vi.fn(async () => undefined),
    });
    let nowCalls = 0;
    const timing = {
      now: () => nowCalls++ * 120_001,
      sleep: async () => undefined,
    };

    await expect(
      capturePeerDbStagingBoundary(
        barrierDatabase(events),
        api,
        storage(events),
        {
          loadProgress: vi.fn(async () => ({
            boundary: { ...boundary, mirrors: boundary.mirrors.slice(0, 1) },
            stage: "boundary_captured",
          })),
          requestId,
          saveProgress: vi.fn(async () => undefined),
        },
        timing,
      ),
    ).rejects.toThrow("Unable to resume every PeerDB ClickHouse staging writer");
  });

  it("re-lists after marker capture and rejects a writer that resumed before persistence", async () => {
    const events: string[] = [];
    let listCount = 0;
    let state = "STATUS_RUNNING";
    const api: PeerDbMirrorApiClient = {
      async changeMirrorState(request) {
        events.push(`${request.requestedFlowState}:${request.flowJobName}`);
        state = request.requestedFlowState;
      },
      async getMirrorStatus(name) {
        events.push(`status:${name}`);
        return { currentFlowState: state, tableMappings: [] };
      },
      async listMirrors() {
        listCount += 1;
        if (listCount === 4) state = "STATUS_RUNNING";
        return [
          {
            destinationType: "CLICKHOUSE",
            isCdc: true,
            name: "dofek_fitness_raw_analytics",
          },
        ];
      },
    };

    await expect(
      capturePeerDbStagingBoundary(barrierDatabase(events), api, storage(events), {
        loadProgress: vi.fn(async () => null),
        requestId,
        saveProgress: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow(
      "PeerDB ClickHouse staging writer dofek_fitness_raw_analytics left STATUS_PAUSED before boundary persistence",
    );

    expect(listCount).toBe(4);
  });

  it("persists the newest storage-native timestamp across marker, objects, and uploads", async () => {
    const events: string[] = [];
    const objectLastModified = new Date("2026-08-03T12:02:00.000Z");
    const uploadInitiated = new Date("2026-08-03T12:03:00.000Z");
    const candidateStorage = storage(events, {
      listMultipartUploads: vi.fn(async () => ({
        isTruncated: false,
        nextKeyMarker: null,
        nextUploadIdMarker: null,
        uploads: [
          {
            initiated: uploadInitiated,
            key: "pending-stage.avro",
            uploadId: "pending-upload",
          },
        ],
      })),
      listObjects: vi.fn(async () => ({
        isTruncated: false,
        nextContinuationToken: null,
        objects: [
          {
            eTag: boundary.eTag,
            key: boundaryKey,
            lastModified: new Date(boundary.cutoff),
          },
          {
            eTag: '"completed-stage-etag"',
            key: "completed-stage.avro",
            lastModified: objectLastModified,
          },
        ],
      })),
    });
    const saveProgress = vi.fn(async () => undefined);

    const result = await capturePeerDbStagingBoundary(
      barrierDatabase(events),
      mirrorApi(events),
      candidateStorage,
      {
        loadProgress: vi.fn(async () => null),
        requestId,
        saveProgress,
      },
    );

    expect(result.cutoff).toBe(uploadInitiated.toISOString());
    expect(saveProgress).toHaveBeenLastCalledWith({
      boundary: {
        ...boundary,
        cutoff: uploadInitiated.toISOString(),
      },
      stage: "boundary_captured",
    });
  });

  it("uses a completed object's timestamp when it is newer than every upload", async () => {
    const events: string[] = [];
    const objectLastModified = new Date("2026-08-03T12:04:00.000Z");
    const candidateStorage = storage(events, {
      listMultipartUploads: vi.fn(async () => ({
        isTruncated: false,
        nextKeyMarker: null,
        nextUploadIdMarker: null,
        uploads: [
          {
            initiated: new Date("2026-08-03T12:03:00.000Z"),
            key: "pending-stage.avro",
            uploadId: "pending-upload",
          },
        ],
      })),
      listObjects: vi.fn(async () => ({
        isTruncated: false,
        nextContinuationToken: null,
        objects: [
          {
            eTag: boundary.eTag,
            key: boundaryKey,
            lastModified: new Date(boundary.cutoff),
          },
          {
            eTag: '"newest-completed-stage-etag"',
            key: "newest-completed-stage.avro",
            lastModified: objectLastModified,
          },
        ],
      })),
    });

    await expect(
      capturePeerDbStagingBoundary(barrierDatabase(events), mirrorApi(events), candidateStorage, {
        loadProgress: vi.fn(async () => null),
        requestId,
        saveProgress: vi.fn(async () => undefined),
      }),
    ).resolves.toMatchObject({ cutoff: objectLastModified.toISOString() });
  });

  it("fails closed when an exhaustive listing cannot see the exact marker", async () => {
    const events: string[] = [];

    await expect(
      capturePeerDbStagingBoundary(
        barrierDatabase(events),
        mirrorApi(events),
        storage(events, {
          listObjects: vi.fn(async () => ({
            isTruncated: false,
            nextContinuationToken: null,
            objects: [
              {
                eTag: '"different-etag"',
                key: boundaryKey,
                lastModified: new Date(boundary.cutoff),
              },
            ],
          })),
        }),
        {
          loadProgress: vi.fn(async () => null),
          requestId,
          saveProgress: vi.fn(async () => undefined),
        },
      ),
    ).rejects.toThrow("PeerDB staging inventory did not contain the exact boundary marker");

    expect(events).toContain("STATUS_RUNNING:dofek_fitness_raw_analytics");
  });

  it("fails closed when the exhaustive storage inventory changes between paused passes", async () => {
    const events: string[] = [];
    const listObjects = vi
      .fn<PeerDbStagingStorage["listObjects"]>()
      .mockResolvedValueOnce({
        isTruncated: false,
        nextContinuationToken: null,
        objects: [
          {
            eTag: boundary.eTag,
            key: boundaryKey,
            lastModified: new Date(boundary.cutoff),
          },
        ],
      })
      .mockResolvedValueOnce({
        isTruncated: false,
        nextContinuationToken: null,
        objects: [
          {
            eTag: boundary.eTag,
            key: boundaryKey,
            lastModified: new Date(boundary.cutoff),
          },
          {
            eTag: '"late-etag"',
            key: "late-stage.avro",
            lastModified: new Date("2026-08-03T12:00:01.000Z"),
          },
        ],
      });

    await expect(
      capturePeerDbStagingBoundary(
        barrierDatabase(events),
        mirrorApi(events),
        storage(events, { listObjects }),
        {
          loadProgress: vi.fn(async () => null),
          requestId,
          saveProgress: vi.fn(async () => undefined),
        },
      ),
    ).rejects.toThrow("PeerDB staging storage inventory changed during account-erasure quiescence");

    expect(events).toContain("STATUS_RUNNING:dofek_fitness_raw_analytics");
  });

  it("fails closed when a multipart upload identity changes between paused passes", async () => {
    const events: string[] = [];
    const initiated = new Date("2026-08-03T12:01:00.000Z");
    const listMultipartUploads = vi
      .fn<PeerDbStagingStorage["listMultipartUploads"]>()
      .mockResolvedValueOnce({
        isTruncated: false,
        nextKeyMarker: null,
        nextUploadIdMarker: null,
        uploads: [{ initiated, key: "stage.avro", uploadId: "first-upload" }],
      })
      .mockResolvedValueOnce({
        isTruncated: false,
        nextKeyMarker: null,
        nextUploadIdMarker: null,
        uploads: [{ initiated, key: "stage.avro", uploadId: "second-upload" }],
      });

    await expect(
      capturePeerDbStagingBoundary(
        barrierDatabase(events),
        mirrorApi(events),
        storage(events, { listMultipartUploads }),
        {
          loadProgress: vi.fn(async () => null),
          requestId,
          saveProgress: vi.fn(async () => undefined),
        },
      ),
    ).rejects.toThrow("PeerDB staging storage inventory changed during account-erasure quiescence");
  });

  it("fails closed when stable objects are reached through different continuation cursors", async () => {
    const events: string[] = [];
    const markerObject = {
      eTag: boundary.eTag,
      key: boundaryKey,
      lastModified: new Date(boundary.cutoff),
    };
    const listObjects = vi
      .fn<PeerDbStagingStorage["listObjects"]>()
      .mockResolvedValueOnce({
        isTruncated: true,
        nextContinuationToken: "first-pass",
        objects: [],
      })
      .mockResolvedValueOnce({
        isTruncated: false,
        nextContinuationToken: null,
        objects: [markerObject],
      })
      .mockResolvedValueOnce({
        isTruncated: true,
        nextContinuationToken: "second-pass",
        objects: [],
      })
      .mockResolvedValueOnce({
        isTruncated: false,
        nextContinuationToken: null,
        objects: [markerObject],
      });

    await expect(
      capturePeerDbStagingBoundary(
        barrierDatabase(events),
        mirrorApi(events),
        storage(events, { listObjects }),
        {
          loadProgress: vi.fn(async () => null),
          requestId,
          saveProgress: vi.fn(async () => undefined),
        },
      ),
    ).rejects.toThrow("PeerDB staging storage inventory changed during account-erasure quiescence");
  });

  it("fails closed when stable uploads are reached through different continuation cursors", async () => {
    const events: string[] = [];
    const upload = {
      initiated: new Date("2026-08-03T12:01:00.000Z"),
      key: "stage.avro",
      uploadId: "stable-upload",
    };
    const listMultipartUploads = vi
      .fn<PeerDbStagingStorage["listMultipartUploads"]>()
      .mockResolvedValueOnce({
        isTruncated: true,
        nextKeyMarker: "first-key",
        nextUploadIdMarker: "first-upload",
        uploads: [],
      })
      .mockResolvedValueOnce({
        isTruncated: false,
        nextKeyMarker: null,
        nextUploadIdMarker: null,
        uploads: [upload],
      })
      .mockResolvedValueOnce({
        isTruncated: true,
        nextKeyMarker: "second-key",
        nextUploadIdMarker: "second-upload",
        uploads: [],
      })
      .mockResolvedValueOnce({
        isTruncated: false,
        nextKeyMarker: null,
        nextUploadIdMarker: null,
        uploads: [upload],
      });

    await expect(
      capturePeerDbStagingBoundary(
        barrierDatabase(events),
        mirrorApi(events),
        storage(events, { listMultipartUploads }),
        {
          loadProgress: vi.fn(async () => null),
          requestId,
          saveProgress: vi.fn(async () => undefined),
        },
      ),
    ).rejects.toThrow("PeerDB staging storage inventory changed during account-erasure quiescence");
  });
});
