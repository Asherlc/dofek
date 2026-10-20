import { describe, expect, it, vi } from "vitest";

const send = vi.hoisted(() => vi.fn());
const destroy = vi.hoisted(() => vi.fn());
vi.mock("../r2-storage.ts", () => ({
  createR2Client: () => ({ send, destroy }),
  requiredR2EnvironmentVariable: () => "private-media",
}));

import { activityImageObjectKey, eraseActivityImageObjects } from "./storage.ts";

describe("activity image storage", () => {
  const a = "00000000-0000-4000-8000-000000000001",
    b = "00000000-0000-4000-8000-000000000002";
  it("shares identical files only within one account", () => {
    const hash = "a".repeat(64);
    expect(activityImageObjectKey(a, hash)).toBe(activityImageObjectKey(a, hash));
    expect(activityImageObjectKey(a, hash)).not.toBe(activityImageObjectKey(b, hash));
    expect(() => activityImageObjectKey("../escape", hash)).toThrow();
  });
  it("paginates erasure and verifies the prefix is empty", async () => {
    send.mockReset();
    send
      .mockResolvedValueOnce({
        Contents: [{ Key: `images/${a}/a` }],
        IsTruncated: true,
        NextContinuationToken: "next",
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Contents: [{ Key: `images/${a}/b` }] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Contents: [] });
    await eraseActivityImageObjects(a);
    expect(send).toHaveBeenCalledTimes(5);
    expect(send.mock.calls[2]?.[0].input.ContinuationToken).toBe("next");
  });
  it("propagates erasure failure rather than acknowledging deletion", async () => {
    send.mockReset().mockRejectedValue(new Error("R2 unavailable"));
    await expect(eraseActivityImageObjects(a)).rejects.toThrow("R2 unavailable");
  });
});
