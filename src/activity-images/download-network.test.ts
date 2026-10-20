import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:https", () => ({ request: mocks.request }));

import { downloadActivityImage } from "./download.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=",
  "base64",
);
interface FakeImageResponse extends EventEmitter {
  statusCode: number;
  headers: Record<string, string>;
  resume(): void;
  destroy(): void;
}
function respond(status: number, headers: Record<string, string>, bytes = png) {
  mocks.request.mockImplementationOnce(
    (_url: URL, _options: unknown, callback: (response: FakeImageResponse) => void) => {
      const response = Object.assign(new EventEmitter(), {
        statusCode: status,
        headers,
        resume() {},
        destroy() {},
      });
      const req = Object.assign(new EventEmitter(), {
        end() {
          callback(response);
          queueMicrotask(() => {
            response.emit("data", bytes);
            response.emit("end");
          });
        },
      });
      return req;
    },
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
});
describe("image network boundary", () => {
  it("rejects a mixed public/private DNS answer before opening a socket", async () => {
    mocks.lookup.mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    await expect(
      downloadActivityImage({ url: "https://cdn.test/a", allowedOrigins: ["https://cdn.test"] }),
    ).rejects.toThrow("address_rejected");
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("revalidates redirected destinations and prevents a credential-bearing redirect", async () => {
    respond(302, { location: "https://user:password@cdn.test/private" });
    await expect(
      downloadActivityImage({ url: "https://cdn.test/a", allowedOrigins: ["https://cdn.test"] }),
    ).rejects.toThrow("origin_rejected");
    expect(mocks.request).toHaveBeenCalledOnce();
  });
  it("rejects truncated image responses and exposes Retry-After without source URLs", async () => {
    respond(200, { "content-type": "image/png", "content-length": String(png.length + 1) });
    await expect(
      downloadActivityImage({ url: "https://cdn.test/a", allowedOrigins: ["https://cdn.test"] }),
    ).rejects.toThrow("truncated");
    respond(429, { "retry-after": "600" });
    await expect(
      downloadActivityImage({ url: "https://cdn.test/a", allowedOrigins: ["https://cdn.test"] }),
    ).rejects.toMatchObject({ code: "image_http_429", retryable: true, retryAfterSeconds: 600 });
  });
  it("pins the validated DNS result and downloads original bytes without authorization", async () => {
    respond(200, { "content-type": "image/png", "content-length": String(png.length) });
    const image = await downloadActivityImage({
      url: "https://cdn.test/a?signature=secret",
      allowedOrigins: ["https://cdn.test"],
    });
    try {
      expect(image.sizeBytes).toBe(png.length);
      const options = mocks.request.mock.calls[0]?.[1];
      expect(options.headers).toEqual({ Accept: "image/*" });
      const callback = vi.fn();
      options.lookup("cdn.test", {}, callback);
      expect(callback).toHaveBeenCalledWith(null, "8.8.8.8", 4);
    } finally {
      await image.cleanup();
    }
  });
});
