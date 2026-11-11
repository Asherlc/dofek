import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
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
  destroy(error?: Error): void;
}
function respond(status: number, headers: Record<string, string>, bytes = png) {
  mocks.request.mockImplementationOnce(
    (_url: URL, _options: unknown, callback: (response: FakeImageResponse) => void) => {
      const chunks = Array.from({ length: Math.ceil(bytes.length / 65536) }, (_, i) =>
        bytes.subarray(i * 65536, (i + 1) * 65536),
      );
      const response = Object.assign(Readable.from(chunks), { statusCode: status, headers });
      const req = Object.assign(new EventEmitter(), {
        end() {
          callback(response);
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

it("fails before opening a socket when DNS returns no addresses", async () => {
  mocks.lookup.mockResolvedValue([]);
  await expect(
    downloadActivityImage({ url: "https://cdn.test/a", allowedOrigins: ["https://cdn.test"] }),
  ).rejects.toThrow("image_address_rejected");
  expect(mocks.request).not.toHaveBeenCalled();
});
it.each([301, 302, 303, 307, 308])(
  "follows relative redirect status %i within the allowed origin",
  async (status) => {
    respond(status, { location: "/final" });
    respond(200, { "content-type": "image/png" });
    const image = await downloadActivityImage({
      url: "https://cdn.test/start",
      allowedOrigins: ["https://cdn.test"],
    });
    try {
      expect(mocks.request.mock.calls[1]?.[0].href).toBe("https://cdn.test/final");
    } finally {
      await image.cleanup();
    }
  },
);
it("limits redirect chains to four requests", async () => {
  for (let n = 0; n < 4; n++) respond(302, { location: "/again" });
  await expect(
    downloadActivityImage({ url: "https://cdn.test/start", allowedOrigins: ["https://cdn.test"] }),
  ).rejects.toThrow("image_redirect_limit");
  expect(mocks.request).toHaveBeenCalledTimes(4);
});
it.each([408, 429, 500, 503, 404, 403, 302])(
  "classifies retry behavior for HTTP %i without a redirect target",
  async (status) => {
    respond(status, {});
    await expect(
      downloadActivityImage({ url: "https://cdn.test/a", allowedOrigins: ["https://cdn.test"] }),
    ).rejects.toMatchObject({
      code: `image_http_${status}`,
      retryable: [408, 429].includes(status) || status >= 500,
      retryAfterSeconds: 0,
    });
  },
);
it("supports HTTP-date Retry-After values", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  respond(429, { "retry-after": "Thu, 01 Jan 2026 00:10:00 GMT" });
  try {
    await expect(
      downloadActivityImage({ url: "https://cdn.test/a", allowedOrigins: ["https://cdn.test"] }),
    ).rejects.toMatchObject({ retryAfterSeconds: 600 });
  } finally {
    vi.useRealTimers();
  }
});
it("rejects declared or streamed bodies above the size limit", async () => {
  respond(200, { "content-type": "image/png", "content-length": String(50 * 1024 * 1024 + 1) });
  await expect(
    downloadActivityImage({ url: "https://cdn.test/a", allowedOrigins: ["https://cdn.test"] }),
  ).rejects.toThrow("image_size_limit");
  respond(200, { "content-type": "image/png" }, Buffer.alloc(50 * 1024 * 1024 + 1));
  await expect(
    downloadActivityImage({ url: "https://cdn.test/a", allowedOrigins: ["https://cdn.test"] }),
  ).rejects.toThrow("image_size_limit");
});
it.each(["8.8.8.8", "[2606:4700:4700::1111]"])(
  "validates literal public address %s without DNS lookup",
  async (host) => {
    respond(200, { "content-type": "image/png" });
    const origin = `https://${host}`;
    const image = await downloadActivityImage({ url: `${origin}/a`, allowedOrigins: [origin] });
    try {
      expect(mocks.lookup).not.toHaveBeenCalled();
    } finally {
      await image.cleanup();
    }
  },
);
it("includes the caller's abort signal and disables pooled connections", async () => {
  const controller = new AbortController();
  respond(200, { "content-type": "image/png" });
  const image = await downloadActivityImage({
    url: "https://cdn.test/a",
    allowedOrigins: ["https://cdn.test"],
    signal: controller.signal,
  });
  try {
    const options = mocks.request.mock.calls[0]?.[1];
    expect(options.agent).toBe(false);
    expect(options.family).toBe(4);
    expect(options.signal.aborted).toBe(false);
    controller.abort();
    expect(options.signal.aborted).toBe(true);
  } finally {
    await image.cleanup();
  }
});

it.each(["soon", "Infinity", "0"])(
  "normalizes Retry-After %s to a finite zero delay",
  async (value) => {
    respond(429, { "retry-after": value });
    await expect(
      downloadActivityImage({ url: "https://cdn.test/a", allowedOrigins: ["https://cdn.test"] }),
    ).rejects.toMatchObject({ retryAfterSeconds: 0 });
  },
);

it("streams chunks to disk without concatenating a complete original in memory", async () => {
  const original = Buffer.alloc(1024 * 1024);
  png.copy(original);
  const concat = vi.spyOn(Buffer, "concat");
  respond(200, { "content-type": "image/png" }, original);
  const image = await downloadActivityImage({
    url: "https://cdn.test/a",
    allowedOrigins: ["https://cdn.test"],
  });
  try {
    expect(
      concat.mock.calls.filter(
        ([chunks]) => chunks.reduce((n, chunk) => n + chunk.length, 0) >= original.length,
      ),
    ).toHaveLength(0);
    expect(await readFile(image.filePath)).toEqual(original);
    expect(image.sha256).toBe(createHash("sha256").update(original).digest("hex"));
  } finally {
    concat.mockRestore();
    await image.cleanup();
  }
});
