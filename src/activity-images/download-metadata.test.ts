import sharp from "sharp";
import { expect, it, vi } from "vitest";
import { inspectImageBytes } from "./download.ts";

const mocks = vi.hoisted(() => ({ metadata: vi.fn() }));
vi.mock("sharp", () => ({ default: vi.fn(() => ({ metadata: mocks.metadata })) }));
it.each([
  { format: "tiff", width: 1, height: 1 },
  { format: "png", width: 0, height: 1 },
  { format: "png", width: 1, height: 0 },
])("rejects unsupported or dimensionless decoded image metadata (%j)", async (metadata) => {
  mocks.metadata.mockResolvedValue(metadata);
  await expect(inspectImageBytes(Buffer.from("image"), "image/png")).rejects.toThrow(
    "unsupported_image",
  );
});
it("enforces the decoded pixel limit and allows its exact boundary", async () => {
  mocks.metadata
    .mockResolvedValueOnce({ format: "png", width: 10001, height: 10000 })
    .mockResolvedValueOnce({ format: "png", width: 10000, height: 10000 });
  await expect(inspectImageBytes(Buffer.from("image"), "image/png")).rejects.toThrow(
    "image_pixel_limit",
  );
  expect(await inspectImageBytes(Buffer.from("image"), "image/png")).toMatchObject({
    width: 10000,
    height: 10000,
  });
  expect(sharp).toHaveBeenCalledWith(Buffer.from("image"), {
    limitInputPixels: 100000000,
    animated: true,
  });
});
it("accepts HEIC as the declared type for HEIF but rejects unrelated MIME values", async () => {
  mocks.metadata.mockResolvedValue({ format: "heif", compression: "hevc", width: 1, height: 1 });
  expect(await inspectImageBytes(Buffer.from("image"), "image/heic")).toMatchObject({
    mimeType: "image/heif",
  });
  await expect(inspectImageBytes(Buffer.from("image"), "image/png")).rejects.toThrow(
    "image_MIME_mismatch",
  );
});
it("interprets AV1 only within the HEIF container as AVIF", async () => {
  mocks.metadata
    .mockResolvedValueOnce({ format: "heif", compression: "av1", width: 1, height: 1 })
    .mockResolvedValueOnce({ format: "png", compression: "av1", width: 1, height: 1 });
  expect(await inspectImageBytes(Buffer.from("image"), "image/avif")).toMatchObject({
    mimeType: "image/avif",
  });
  expect(await inspectImageBytes(Buffer.from("image"), "image/png")).toMatchObject({
    mimeType: "image/png",
  });
});
