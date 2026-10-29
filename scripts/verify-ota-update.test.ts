import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
      const header = `expo-signature: sig="${signature}", keyid="main"\r\n`;
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
