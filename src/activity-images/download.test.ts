import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { inspectImageBytes, isPublicImageAddress, validateImageUrl } from "./download.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=",
  "base64",
);
describe("private image downloads", () => {
  it("loads image errors and retry metadata in Node's production TypeScript mode", () => {
    const moduleUrl = new URL("./download.ts", import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        `
          import assert from "node:assert/strict";
          const { ImageDownloadError, validateImageUrl } = await import(${JSON.stringify(moduleUrl)});
          const permanent = new ImageDownloadError("image_size_limit");
          assert.ok(permanent instanceof Error);
          assert.equal(permanent.message, "image_size_limit");
          assert.equal(permanent.code, "image_size_limit");
          assert.equal(permanent.retryable, false);
          assert.equal(permanent.retryAfterSeconds, 0);
          const retryable = new ImageDownloadError("image_http_429", true, 60);
          assert.equal(retryable.code, "image_http_429");
          assert.equal(retryable.retryable, true);
          assert.equal(retryable.retryAfterSeconds, 60);
          assert.throws(
            () => validateImageUrl("http://cdn.test/image.png", ["https://cdn.test"]),
            (error) => error instanceof ImageDownloadError && error.code === "image_origin_rejected",
          );
        `,
      ],
      { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" }, timeout: 10_000 },
    );
    expect(result.status, result.stderr || result.error?.message).toBe(0);
  });

  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.0.1",
    "100.64.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fd00::1",
    "2001:db8::1",
  ])("rejects nonpublic address %s", (ip) => {
    expect(isPublicImageAddress(ip)).toBe(false);
  });
  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("allows public address %s", (ip) =>
    expect(isPublicImageAddress(ip)).toBe(true),
  );
  it("restricts protocols, ports, credentials and origins", () => {
    for (const url of [
      "http://cdn.test/a",
      "https://user:pass@cdn.test/a",
      "https://cdn.test:444/a",
      "https://other.test/a",
    ])
      expect(() => validateImageUrl(url, ["https://cdn.test"])).toThrow(
        expect.objectContaining({
          code: "image_origin_rejected",
          retryable: false,
          retryAfterSeconds: 0,
        }),
      );
    expect(validateImageUrl("https://cdn.test/a?secret=x", ["https://cdn.test"]).hostname).toBe(
      "cdn.test",
    );
  });
  it("recognizes originals without transforming bytes", async () => {
    const metadata = await inspectImageBytes(png, "image/png");
    expect(metadata).toMatchObject({
      width: 1,
      height: 1,
      mimeType: "image/png",
      sizeBytes: png.length,
    });
    expect(metadata.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it("rejects fake images and mismatched content types", async () => {
    await expect(
      inspectImageBytes(Buffer.from("<html>error</html>"), "image/png"),
    ).rejects.toThrow();
    await expect(inspectImageBytes(png, "image/jpeg")).rejects.toThrow("MIME");
  });
});

it.each(["jpeg", "png", "webp", "gif", "avif"])(
  "recognizes %s originals without recompressing them",
  async (format) => {
    const { default: sharp } = await import("sharp");
    let image = sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: 1, g: 2, b: 3 } },
    });
    switch (format) {
      case "jpeg":
        image = image.jpeg();
        break;
      case "png":
        image = image.png();
        break;
      case "webp":
        image = image.webp();
        break;
      case "gif":
        image = image.gif();
        break;
      case "avif":
        image = image.avif();
        break;
    }
    const bytes = await image.toBuffer();
    const before = Buffer.from(bytes);
    const metadata = await inspectImageBytes(bytes, `image/${format}`);
    expect(bytes).toEqual(before);
    expect(metadata).toMatchObject({ width: 2, height: 2, mimeType: `image/${format}` });
  },
);

it.each([
  "0.1.2.3",
  "172.16.0.1",
  "172.31.255.255",
  "192.0.0.1",
  "192.0.2.1",
  "198.18.0.1",
  "198.51.100.1",
  "203.0.113.1",
  "224.0.0.1",
  "240.0.0.1",
  "255.255.255.255",
  "2001::1",
  "2002::1",
  "not-an-ip",
  "fe80::1",
])("blocks special-use image address %s", (ip) => expect(isPublicImageAddress(ip)).toBe(false));
it.each(["172.15.255.255", "172.32.0.1", "192.1.1.1", "2001:4860:4860::8888", "3000::1"])(
  "allows routable image address %s",
  (ip) => expect(isPublicImageAddress(ip)).toBe(true),
);
it("normalizes a declared image type including whitespace and MIME parameters", async () => {
  expect(await inspectImageBytes(png, "  IMAGE/PNG  ; charset=binary")).toMatchObject({
    mimeType: "image/png",
    width: 1,
    height: 1,
    sizeBytes: png.length,
  });
  await expect(inspectImageBytes(Buffer.alloc(0), "image/png")).rejects.toThrow("image_size_limit");
  await expect(inspectImageBytes(Buffer.alloc(50 * 1024 * 1024 + 1), "image/png")).rejects.toThrow(
    "image_size_limit",
  );
});

it("enforces transport restrictions independently of the provider origin allowlist", () => {
  for (const [url, origin] of [
    ["http://cdn.test/a", "http://cdn.test"],
    ["https://cdn.test:444/a", "https://cdn.test:444"],
    ["https://user@cdn.test/a", "https://cdn.test"],
    ["https://:pass@cdn.test/a", "https://cdn.test"],
  ])
    expect(() => validateImageUrl(url ?? "", [origin ?? ""])).toThrow("image_origin_rejected");
  expect(isPublicImageAddress("2-not-an-ip")).toBe(false);
});
it("accepts an original at the exact byte limit", async () => {
  const bytes = Buffer.concat([png, Buffer.alloc(50 * 1024 * 1024 - png.length)]);
  expect(await inspectImageBytes(bytes, "image/png")).toMatchObject({
    sizeBytes: 50 * 1024 * 1024,
    mimeType: "image/png",
  });
});
