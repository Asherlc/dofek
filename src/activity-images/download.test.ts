import { describe, expect, it } from "vitest";
import { inspectImageBytes, isPublicImageAddress, validateImageUrl } from "./download.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=",
  "base64",
);
describe("private image downloads", () => {
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
      expect(() => validateImageUrl(url, ["https://cdn.test"])).toThrow();
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
