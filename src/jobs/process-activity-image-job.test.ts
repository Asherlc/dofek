import { describe, expect, it, vi } from "vitest";
import { ImageDownloadError } from "../activity-images/download.ts";
import type { ActivityImageWork, ProviderImageCandidate } from "../activity-images/types.ts";
import { captureException } from "../lib/error-reporting.ts";
import { processActivityImageJob } from "./process-activity-image-job.ts";

vi.mock("../lib/error-reporting.ts", () => ({ captureException: vi.fn() }));

const work: ActivityImageWork = {
  id: "work",
  userId: "owner",
  providerId: "strava",
  activityId: "activity",
  activityExternalId: "1",
  imageId: "image",
  generation: 1,
  attempts: 0,
  candidate: {
    sourceId: "1",
    kind: "photo",
    caption: null,
    position: 0,
    variants: [{ url: "https://cdn.test/old", width: 100, height: 100 }],
    revision: null,
    raw: {},
  },
};
function dependencies() {
  const cleanup = vi.fn(async () => {});
  return {
    load: vi.fn(async (): Promise<ActivityImageWork | null> => work),
    claim: vi.fn(async () => true),
    acquire: vi.fn(async (_work: ActivityImageWork) => ({ stored: true })),
    fail: vi.fn(async () => {}),
    refresh: vi.fn(
      async (): Promise<ProviderImageCandidate> => ({
        ...work.candidate,
        variants: [{ url: "https://cdn.test/new", width: 100, height: 100 }],
      }),
    ),
    cleanup,
  };
}
describe("durable image acquisition", () => {
  it("does not redownload work already acknowledged or removed", async () => {
    const deps = dependencies();
    deps.load.mockResolvedValue(null);
    await processActivityImageJob({ workId: "work", userId: "owner" }, deps);
    expect(deps.acquire).not.toHaveBeenCalled();
  });
  it("does not duplicate a concurrently claimed job", async () => {
    const deps = dependencies();
    deps.claim.mockResolvedValue(false);
    await processActivityImageJob({ workId: "work", userId: "owner" }, deps);
    expect(deps.acquire).not.toHaveBeenCalled();
  });
  it("refreshes an expired URL once and preserves stable source identity", async () => {
    const deps = dependencies();
    deps.acquire.mockRejectedValueOnce(new ImageDownloadError("image_http_403"));
    await processActivityImageJob({ workId: "work", userId: "owner" }, deps);
    expect(deps.refresh).toHaveBeenCalledWith(work);
    expect(deps.acquire.mock.calls[1]?.[0].candidate.variants[0]?.url).toBe("https://cdn.test/new");
    expect(deps.fail).not.toHaveBeenCalled();
  });
  it("uses Retry-After and records bounded retry state without logging URLs", async () => {
    const deps = dependencies();
    deps.acquire.mockRejectedValue(new ImageDownloadError("image_http_429", true, 900));
    await processActivityImageJob({ workId: "work", userId: "owner" }, deps);
    expect(deps.fail).toHaveBeenCalledWith(work, true, "image_http_429", 900);
  });
  it("does not store a replacement photo under the expired generation", async () => {
    const deps = dependencies();
    deps.acquire.mockRejectedValueOnce(new ImageDownloadError("image_http_403"));
    deps.refresh.mockResolvedValueOnce({ ...work.candidate, revision: "replaced" });
    await processActivityImageJob({ workId: "work", userId: "owner" }, deps);
    expect(deps.acquire).toHaveBeenCalledTimes(1);
    expect(deps.fail).toHaveBeenCalledWith(work, false, "image_revision_changed", 30);
  });
  it("records generic download errors without leaking their URL", async () => {
    const deps = dependencies();
    deps.acquire.mockRejectedValue(Error("secret https://cdn.test/a?token=x"));
    await processActivityImageJob({ workId: "work", userId: "owner" }, deps);
    expect(deps.fail).toHaveBeenCalledWith(work, true, "image_acquisition_failed", 30);
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Image acquisition failed" }),
      { tags: { provider: work.providerId, context: "image-acquisition" } },
    );
  });
  it("retires stale completion rather than leaving a processing lease", async () => {
    const deps = dependencies();
    deps.acquire.mockResolvedValue({ stored: false });
    await processActivityImageJob({ workId: "work", userId: "owner" }, deps);
    expect(deps.fail).toHaveBeenCalledWith(work, false, "superseded", 0);
  });
});
