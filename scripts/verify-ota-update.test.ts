import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { HttpResponse, http, passthrough } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { verifyOtaUpdate } from "./verify-ota-update.ts";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const certificate = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const bytes = Buffer.from("signed OTA asset fixture");
const asset = {
  contentType: "application/javascript",
  key: "bundle",
  url: "https://ota.example.test/assets/bundle",
  hash: createHash("sha256").update(bytes).digest("base64url"),
};
const manifest = {
  id: "preserved-update-id",
  createdAt: "2026-10-29T12:00:00.000Z",
  runtimeVersion: "runtime-current",
  launchAsset: asset,
  assets: [{ ...asset, key: "image", url: "https://ota.example.test/assets/image" }],
  metadata: {},
  extra: {},
};
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function serve(
  options: {
    invalidSignature?: boolean;
    alteredAsset?: boolean;
    alteredImage?: boolean;
    misplacedSignature?: boolean;
    invalidBase64?: boolean;
  } = {},
) {
  server.use(
    http.get("https://ota.example.test/manifest", ({ request }) => {
      expect(request.headers.get("expo-expect-signature")).toContain('keyid="main"');
      expect(request.headers.has("expo-app-id")).toBe(false);
      const body = JSON.stringify(manifest);
      const signature = sign(
        "RSA-SHA256",
        Buffer.from(options.invalidSignature ? "wrong" : body),
        keys.privateKey,
      ).toString("base64");
      const header = `expo-signature: sig="${signature}${options.invalidBase64 ? "!" : ""}", keyid="main"\r\n`;
      const extensions = options.misplacedSignature
        ? `--boundary\r\nContent-Disposition: form-data; name="extensions"\r\nContent-Type: application/json\r\n${header}\r\n{}\r\n`
        : "";
      return new HttpResponse(
        `${extensions}--boundary\r\nContent-Disposition: form-data; name="manifest"\r\nContent-Type: application/json\r\n${options.misplacedSignature ? "" : header}\r\n${body}\r\n--boundary--\r\n`,
        {
          headers: {
            "content-type": "multipart/mixed; boundary=boundary",
            "expo-protocol-version": "1",
          },
        },
      );
    }),
  );
  server.use(
    http.get(
      "https://ota.example.test/assets/:key",
      ({ params }) =>
        new HttpResponse(
          options.alteredAsset || (options.alteredImage && params.key === "image")
            ? "changed"
            : bytes,
        ),
    ),
  );
}

const options = {
  url: "https://ota.example.test/manifest",
  runtimeVersion: "runtime-current",
  channel: "production",
  expectedId: manifest.id,
  certificate,
  fetchImplementation: (...arguments_: Parameters<typeof fetch>) => fetch(...arguments_),
};

describe("signed OTA update audit", () => {
  it("aborts a download that stalls after sending response headers", async () => {
    serve();
    const controller = new AbortController();
    const originalTimeout = AbortSignal.timeout;
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((delay) =>
        delay === 60_000 ? controller.signal : originalTimeout(delay),
      );
    const timers: ReturnType<typeof setTimeout>[] = [];
    const stalled = createServer((_request, response) => {
      response.writeHead(200);
      response.write(bytes.subarray(0, 1));
      timers.push(
        setTimeout(() => controller.abort(new DOMException("Asset timed out", "TimeoutError")), 25),
      );
      timers.push(setTimeout(() => response.destroy(), 300));
    });
    stalled.listen(0, "127.0.0.1");
    await once(stalled, "listening");
    const address = stalled.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture server address");
    const url = `http://127.0.0.1:${address.port}/asset`;
    server.use(http.get(url, () => passthrough()));
    try {
      await expect(
        verifyOtaUpdate({
          ...options,
          fetchImplementation: (input, init) =>
            fetch(String(input).startsWith("https://ota.example.test/assets/") ? url : input, init),
        }),
      ).rejects.toMatchObject({ name: expect.stringMatching(/AbortError|TimeoutError/) });
      expect(timeout).toHaveBeenCalledWith(60_000);
    } finally {
      timeout.mockRestore();
      for (const timer of timers) clearTimeout(timer);
      stalled.closeAllConnections();
      await new Promise<void>((resolve) => stalled.close(() => resolve()));
    }
  });
  it("verifies retained identity, device certificate and every asset hash", async () => {
    serve();
    await expect(verifyOtaUpdate(options)).resolves.toBe(manifest.id);
  });
  it("rejects a changed update identity", async () => {
    serve();
    await expect(verifyOtaUpdate({ ...options, expectedId: "different-id" })).rejects.toThrow(
      "identity",
    );
  });
  it("rejects invalid manifest signatures", async () => {
    serve({ invalidSignature: true });
    await expect(verifyOtaUpdate(options)).rejects.toThrow("signature");
  });
  it("rejects a valid signature with invalid base64 characters", async () => {
    serve({ invalidBase64: true });
    await expect(verifyOtaUpdate(options)).rejects.toThrow("base64");
  });
  it("rejects a signature on another MIME part even when it signs the manifest bytes", async () => {
    serve({ misplacedSignature: true });
    await expect(verifyOtaUpdate(options)).rejects.toThrow("signature is missing");
  });
  it("rejects asset byte changes", async () => {
    serve({ alteredAsset: true });
    await expect(verifyOtaUpdate(options)).rejects.toThrow("hash");
  });
  it("keeps temporary asset URLs out of hash failure messages", async () => {
    serve({ alteredAsset: true });
    await expect(verifyOtaUpdate(options)).rejects.not.toThrow(asset.url);
  });
  it("checks additional assets after a valid launch bundle", async () => {
    serve({ alteredImage: true });
    await expect(verifyOtaUpdate(options)).rejects.toThrow("hash");
  });
  it("rejects a manifest for the wrong runtime", async () => {
    serve();
    await expect(
      verifyOtaUpdate({ ...options, runtimeVersion: "different-runtime" }),
    ).rejects.toThrow("runtime");
  });
});
