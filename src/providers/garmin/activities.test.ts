import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderArtifactStorage } from "../../provider-artifact-storage.ts";
import { createMockDatabase } from "../test-helpers.ts";
import { syncGarminActivityRecord } from "./activities.ts";

const { importFitFile, upsertProviderActivity } = vi.hoisted(() => ({
  importFitFile: vi.fn(),
  upsertProviderActivity: vi.fn(),
}));
vi.mock("../../jobs/process-fit-file-import-job.ts", () => ({ importFitFile }));
vi.mock("../../db/provider-activity-sync.ts", () => ({ upsertProviderActivity }));

const userId = "00000000-0000-0000-0000-000000000001";
const summary = {
  userId: "garmin-owner",
  summaryId: "summary-123",
  activityId: 123,
  activityType: "TRAIL_RUNNING",
  activityName: "Trail run",
  startTimeInSeconds: 1792454400,
  startTimeOffsetInSeconds: -25200,
  durationInSeconds: 1800,
  manual: true,
};
const file = {
  userId: "garmin-owner",
  summaryId: "summary-file-123",
  activityId: 123,
  activityType: "RUNNING",
  activityName: "Morning run",
  startTimeInSeconds: summary.startTimeInSeconds,
  fileType: "FIT",
  callbackURL: "https://apis.garmin.com/wellness-api/rest/activityFile?id=123&token=signed-token",
  manual: true,
};

function dependencies() {
  const retained = new Map<string, Buffer>();
  const materializedPaths: string[] = [];
  const downloadedOwners: Array<{ userId: string; providerId: string; artifactId: string }> = [];
  const artifacts: ProviderArtifactStorage = {
    async ensureArtifact({ download, ...owner }) {
      downloadedOwners.push(owner);
      const key = `provider-artifacts/${owner.userId}/${owner.providerId}/${owner.artifactId}.fit`;
      if (!retained.has(key)) {
        const chunks: Buffer[] = [];
        for await (const chunk of await download()) chunks.push(Buffer.from(chunk));
        retained.set(key, Buffer.concat(chunks));
      }
      return key;
    },
    async materializeArtifact(key, path) {
      const bytes = retained.get(key);
      if (!bytes) throw new Error("Missing retained artifact");
      materializedPaths.push(path);
      await writeFile(path, bytes);
    },
    async deleteForUser() {},
    async deleteForProvider() {},
  };
  const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response("fit-data"));
  return {
    artifacts,
    fetchFn,
    accessToken: "official-access",
    retained,
    materializedPaths,
    downloadedOwners,
  };
}

beforeEach(() => {
  importFitFile.mockReset();
  upsertProviderActivity.mockReset();
  importFitFile.mockResolvedValue({ recordsSynced: 0, errors: [] });
  upsertProviderActivity.mockResolvedValue({ id: "activity-row" });
});
afterEach(() => vi.restoreAllMocks());

describe("official Garmin activity ingestion", () => {
  it("requires an explicit Dofek owner before downloading or writing", async () => {
    const { db } = createMockDatabase();
    const deps = dependencies();
    await expect(syncGarminActivityRecord(db, "activities", summary, {}, deps)).rejects.toThrow(
      "userId",
    );
    expect(upsertProviderActivity).not.toHaveBeenCalled();
    expect(deps.fetchFn).not.toHaveBeenCalled();
  });

  it("preserves the remote activity identity, manual provenance, and type", async () => {
    const { db } = createMockDatabase();
    await expect(
      syncGarminActivityRecord(db, "activities", summary, { userId }, dependencies()),
    ).resolves.toBe(1);
    const values = upsertProviderActivity.mock.calls[0]?.[1];
    expect(values).toMatchObject({
      userId,
      providerId: "garmin",
      externalId: "123",
      name: "Trail run",
      raw: summary,
      activityType: { canonicalType: "running", providerType: "TRAIL_RUNNING", modality: null },
      startUtcOffsetMinutes: -420,
    });
    expect(values.startedAt).toEqual(new Date(summary.startTimeInSeconds * 1000));
    expect(values.endedAt).toEqual(new Date((summary.startTimeInSeconds + 1800) * 1000));
  });

  it("accepts a manually updated activity without activityId using its summary identity", async () => {
    const { db } = createMockDatabase();
    const { activityId: _activityId, ...manual } = summary;
    await syncGarminActivityRecord(
      db,
      "manuallyUpdatedActivities",
      manual,
      { userId },
      dependencies(),
    );
    expect(upsertProviderActivity.mock.calls[0]?.[1]).toMatchObject({
      externalId: "summary-123",
      raw: manual,
    });
  });

  it("persists the streamed FIT artifact before importing and cleans its local materialization", async () => {
    const { db } = createMockDatabase();
    const deps = dependencies();
    importFitFile.mockImplementation(async (_db, data) => {
      expect(await readFile(data.filePath, "utf8")).toBe("fit-data");
      expect(deps.retained.size).toBe(1);
      expect(data).toMatchObject({
        providerId: "garmin",
        userId,
        activitySummary: { externalId: "123", raw: file },
      });
      expect(data.originalPath).not.toContain("signed-token");
      return { recordsSynced: 0, errors: [] };
    });
    const abortController = new AbortController();
    await expect(
      syncGarminActivityRecord(
        db,
        "activityFiles",
        file,
        { userId, signal: abortController.signal },
        deps,
      ),
    ).resolves.toBe(1);
    expect(deps.fetchFn).toHaveBeenCalledWith(file.callbackURL, {
      headers: { Authorization: "Bearer official-access" },
      redirect: "error",
      signal: abortController.signal,
    });
    expect(deps.downloadedOwners).toEqual([
      {
        userId,
        providerId: "garmin",
        artifactId: createHash("sha256").update(file.callbackURL).digest("hex"),
      },
    ]);
    await expect(access(deps.materializedPaths[0] ?? "missing-path")).rejects.toThrow();
  });

  it("preserves known name and manual provenance when a FIT notification omits them", async () => {
    const { db } = createMockDatabase({
      tokensResult: [{ name: "Known run", raw: { manual: true, distanceInMeters: 5000 } }],
    });
    const { activityName: _name, manual: _manual, ...sparseFile } = file;
    await syncGarminActivityRecord(db, "activityFiles", sparseFile, { userId }, dependencies());
    expect(importFitFile.mock.calls[0]?.[1].activitySummary).toMatchObject({
      name: "Known run",
      raw: { ...sparseFile, manual: true },
    });
    expect(importFitFile.mock.calls[0]?.[1].activitySummary.raw).toEqual({
      ...sparseFile,
      manual: true,
    });
  });

  it("preserves known name and manual provenance when a summary correction omits them", async () => {
    const { db } = createMockDatabase({
      tokensResult: [{ name: "Known run", raw: { manual: true } }],
    });
    const { activityName: _name, manual: _manual, ...sparseSummary } = summary;
    await syncGarminActivityRecord(db, "activities", sparseSummary, { userId }, dependencies());
    expect(upsertProviderActivity.mock.calls[0]?.[1]).toMatchObject({
      name: "Known run",
      raw: { ...sparseSummary, manual: true },
    });
  });

  it.each(["Corrected run", ""])(
    "honors the supplied FIT name %j and an explicit nonmanual correction",
    async (activityName) => {
      const { db } = createMockDatabase({
        tokensResult: [{ name: "Known run", raw: { manual: true } }],
      });
      await syncGarminActivityRecord(
        db,
        "activityFiles",
        { ...file, activityName, manual: false },
        { userId },
        dependencies(),
      );
      expect(importFitFile.mock.calls[0]?.[1].activitySummary).toMatchObject({
        name: activityName,
        raw: { manual: false },
      });
    },
  );

  it("reuses retained bytes after parsing fails instead of downloading again", async () => {
    const { db } = createMockDatabase();
    const deps = dependencies();
    importFitFile.mockResolvedValueOnce({
      recordsSynced: 0,
      errors: [{ message: "FIT decoding failed" }],
    });
    await expect(
      syncGarminActivityRecord(db, "activityFiles", file, { userId }, deps),
    ).rejects.toThrow("FIT decoding failed");
    await expect(access(deps.materializedPaths[0] ?? "missing-path")).rejects.toThrow();
    await expect(
      syncGarminActivityRecord(db, "activityFiles", file, { userId }, deps),
    ).resolves.toBe(1);
    expect(deps.fetchFn).toHaveBeenCalledOnce();
    expect(deps.retained.size).toBe(1);
  });

  it.each([401, 403, 429, 500])(
    "propagates an HTTP %s download failure for durable retry",
    async (status) => {
      const { db } = createMockDatabase();
      const deps = dependencies();
      deps.fetchFn.mockResolvedValue(new Response("opaque error body", { status }));
      await expect(
        syncGarminActivityRecord(db, "activityFiles", file, { userId }, deps),
      ).rejects.toThrow(String(status));
      expect(deps.retained.size).toBe(0);
      expect(importFitFile).not.toHaveBeenCalled();
    },
  );

  it("rejects unsafe callbacks and non-FIT files before downloading", async () => {
    const { db } = createMockDatabase();
    const deps = dependencies();
    await expect(
      syncGarminActivityRecord(
        db,
        "activityFiles",
        { ...file, callbackURL: "https://attacker.example/file" },
        { userId },
        deps,
      ),
    ).rejects.toThrow();
    await expect(
      syncGarminActivityRecord(db, "activityFiles", { ...file, fileType: "TCX" }, { userId }, deps),
    ).rejects.toThrow("FIT");
    expect(deps.fetchFn).not.toHaveBeenCalled();
  });

  it("propagates materialization and thrown parser failures without deleting retained bytes", async () => {
    const { db } = createMockDatabase();
    const deps = dependencies();
    importFitFile.mockRejectedValueOnce(new Error("Parser unavailable"));
    await expect(
      syncGarminActivityRecord(db, "activityFiles", file, { userId }, deps),
    ).rejects.toThrow("Parser unavailable");
    await expect(access(deps.materializedPaths[0] ?? "missing-path")).rejects.toThrow();
    expect(deps.retained.size).toBe(1);
    vi.spyOn(deps.artifacts, "materializeArtifact").mockRejectedValueOnce(
      new Error("R2 unavailable"),
    );
    await expect(
      syncGarminActivityRecord(db, "activityFiles", file, { userId }, deps),
    ).rejects.toThrow("R2 unavailable");
    expect(deps.retained.size).toBe(1);
  });
});
