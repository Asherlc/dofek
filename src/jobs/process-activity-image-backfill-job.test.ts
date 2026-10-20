import { describe, expect, it, vi } from "vitest";
import { processImageBackfillPage } from "./process-activity-image-backfill-job.ts";

describe("historical image backfill", () => {
  it("preserves timestamp ties and continues after a failed discovery", async () => {
    const discover = vi
      .fn()
      .mockResolvedValueOnce({ coverage: "complete", images: [1, 2] })
      .mockRejectedValueOnce(Error("rate limited"))
      .mockResolvedValueOnce({ coverage: "unavailable", images: [] });
    const result = await processImageBackfillPage(
      [
        { id: "a", externalId: "1", startedAt: "2020-01-01T00:00:00Z" },
        { id: "b", externalId: "2", startedAt: "2020-01-01T00:00:00Z" },
        { id: "c", externalId: "3", startedAt: "2020-01-02T00:00:00Z" },
      ],
      discover,
    );
    expect(result).toMatchObject({ scanned: 3, discovered: 2, failed: 1, cursor: { id: "c" } });
    expect(discover).toHaveBeenCalledTimes(3);
  });
  it("handles an empty historical range without inventing a cursor", async () =>
    expect(await processImageBackfillPage([], vi.fn())).toEqual({
      scanned: 0,
      discovered: 0,
      failed: 0,
      cursor: null,
    }));
});
