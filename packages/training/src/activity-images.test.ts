import { describe, expect, it } from "vitest";
import {
  ACTIVITY_IMAGES_QUERY_OPTIONS,
  type ActivityImage,
  activityImageCaption,
} from "./activity-images.ts";

function imageWithCaptions(captions: Array<string | null>): ActivityImage {
  return {
    id: "stored-image",
    url: "https://media.example.test/signed-image",
    width: 1200,
    height: 800,
    mimeType: "image/jpeg",
    sizeBytes: 1024,
    sources: captions.map((caption, position) => ({
      activityId: "activity",
      providerId: "strava",
      sourceId: `photo-${position}`,
      kind: "photo",
      caption,
      position,
    })),
  };
}

describe("activity image captions", () => {
  it("uses the first recorded caption with visible text across source associations", () => {
    expect(activityImageCaption(imageWithCaptions([null, "  ", "  Summit view  ", "Other"]))).toBe(
      "Summit view",
    );
  });

  it.each([{ captions: [] }, { captions: [null] }, { captions: ["  ", null] }])(
    "labels images without captions accessibly",
    ({ captions }) => {
      expect(activityImageCaption(imageWithCaptions(captions))).toBe("Activity photo");
    },
  );
});

describe("activity image refresh policy", () => {
  it.each(["pending", "processing", "retryable_failure"])(
    "refreshes while acquisition is %s even if another image is already stored",
    (state) => {
      expect(
        ACTIVITY_IMAGES_QUERY_OPTIONS.refetchInterval({
          state: {
            data: { images: [{ id: "stored-image" }], acquisition: [{ state }] },
            error: null,
          },
        }),
      ).toBe(3000);
    },
  );

  it("renews visible stored-image URLs before their five-minute expiry", () => {
    expect(
      ACTIVITY_IMAGES_QUERY_OPTIONS.refetchInterval({
        state: {
          data: { images: [{ id: "stored-image" }], acquisition: [{ state: "stored" }] },
          error: null,
        },
      }),
    ).toBe(240000);
  });

  it("keeps checking acquisition before the first image is stored", () => {
    expect(
      ACTIVITY_IMAGES_QUERY_OPTIONS.refetchInterval({
        state: { data: { images: [], acquisition: [{ state: "pending" }] }, error: null },
      }),
    ).toBe(3000);
  });

  it("keeps renewing retained stored images when another acquisition has failed", () => {
    expect(
      ACTIVITY_IMAGES_QUERY_OPTIONS.refetchInterval({
        state: {
          data: {
            images: [{ id: "retained-image" }],
            acquisition: [{ state: "terminal_failure" }],
          },
          error: null,
        },
      }),
    ).toBe(240000);
  });

  it.each([
    { acquisition: [] },
    { acquisition: [{ state: "terminal_failure" }] },
    { acquisition: [{ state: "stored" }] },
  ])("stops polling when no stored images or active acquisition remain", ({ acquisition }) => {
    expect(
      ACTIVITY_IMAGES_QUERY_OPTIONS.refetchInterval({
        state: { data: { images: [], acquisition }, error: null },
      }),
    ).toBe(false);
  });

  it("does not poll before the first response", () => {
    expect(ACTIVITY_IMAGES_QUERY_OPTIONS.refetchInterval({ state: { error: null } })).toBe(false);
  });

  it("retries failed link renewal while retained images still have valid signed URLs", () => {
    expect(
      ACTIVITY_IMAGES_QUERY_OPTIONS.refetchInterval({
        state: {
          data: { images: [{ id: "retained-image" }], acquisition: [{ state: "stored" }] },
          error: new Error("Image links could not be refreshed"),
        },
      }),
    ).toBe(30000);
  });

  it("does not keep polling an empty gallery after a refresh error", () => {
    expect(
      ACTIVITY_IMAGES_QUERY_OPTIONS.refetchInterval({
        state: {
          data: { images: [], acquisition: [] },
          error: new Error("Image links could not be refreshed"),
        },
      }),
    ).toBe(false);
  });

  it("preserves acquisition polling priority when retained links fail to refresh", () => {
    expect(
      ACTIVITY_IMAGES_QUERY_OPTIONS.refetchInterval({
        state: {
          data: { images: [{ id: "retained-image" }], acquisition: [{ state: "processing" }] },
          error: new Error("Image links could not be refreshed"),
        },
      }),
    ).toBe(3000);
  });
});
