import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createUpdatesRouter } from "./updates.ts";

const PUBLIC_URL = "https://dofek.asherlc.com";

const silentLogger = {
  info: () => {},
  error: () => {},
};

const manifestSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  runtimeVersion: z.string(),
  launchAsset: z.object({
    hash: z.string(),
    key: z.string(),
    contentType: z.string(),
    url: z.string(),
  }),
  assets: z.array(
    z.object({
      hash: z.string(),
      key: z.string(),
      contentType: z.string(),
      fileExtension: z.string(),
      url: z.string(),
    }),
  ),
  metadata: z.record(z.unknown()),
  extra: z.record(z.unknown()),
});

/** Extract manifest JSON from multipart response body. Throws if parsing fails. */
function parseManifestFromMultipart(body: string) {
  const jsonMatch = body.match(/\r\n\r\n([\s\S]*?)\r\n--/);
  if (!jsonMatch) {
    throw new Error("Could not extract manifest JSON from multipart body");
  }
  return manifestSchema.parse(JSON.parse(jsonMatch[1]));
}

function validMetadata() {
  return {
    id: "2026-03-22-abc123",
    createdAt: "2026-03-22T12:00:00.000Z",
    runtimeVersion: "1.0",
    platform: "ios",
    launchAsset: {
      hash: "abc123base64url",
      key: "ios-abc123def456.hbc",
      contentType: "application/javascript",
    },
    assets: [
      {
        hash: "def456base64url",
        key: "asset_abc.png",
        contentType: "image/png",
        fileExtension: ".png",
      },
    ],
  };
}

let updatesDir: string;

function writeMetadata(metadata: Record<string, unknown>) {
  const currentDir = join(updatesDir, "current");
  mkdirSync(currentDir, { recursive: true });
  writeFileSync(join(currentDir, "metadata.json"), JSON.stringify(metadata));
}

function writeReleaseFiles(metadata: ReturnType<typeof validMetadata>) {
  const currentDir = join(updatesDir, "current");
  const bundlesDir = join(currentDir, "bundles");
  const assetsDir = join(currentDir, "assets");
  mkdirSync(bundlesDir, { recursive: true });
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(join(bundlesDir, metadata.launchAsset.key), "bundle-bytes");
  writeFileSync(join(assetsDir, metadata.assets[0].key), "asset-bytes");
}

function createTestApp(dir: string = updatesDir) {
  const app = express();
  app.use(
    "/updates",
    createUpdatesRouter({ updatesDir: dir, publicUrl: PUBLIC_URL, logger: silentLogger }),
  );
  return app;
}

function getPort(server: ReturnType<express.Express["listen"]>): number {
  const addr = server.address();
  if (addr !== null && typeof addr === "object") {
    return (addr satisfies AddressInfo).port;
  }
  throw new Error("Server address is not an object");
}

async function request(
  app: express.Express,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: Headers }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = getPort(server);
      fetch(`http://localhost:${port}${path}`, { headers })
        .then(async (res) => {
          resolve({
            status: res.status,
            body: await res.text(),
            headers: res.headers,
          });
          server.close();
        })
        .catch((_error: unknown) => {
          resolve({
            status: 500,
            body: "fetch error",
            headers: new Headers(),
          });
          server.close();
        });
    });
  });
}

describe("createUpdatesRouter", () => {
  beforeAll(() => {
    updatesDir = join(
      tmpdir(),
      `dofek-updates-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    );
    mkdirSync(updatesDir, { recursive: true });
  });

  afterAll(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(updatesDir, { recursive: true, force: true });
  });

  it("returns 400 if expo-protocol-version header is missing", async () => {
    writeMetadata(validMetadata());
    const app = createTestApp();
    const res = await request(app, "/updates/manifest", {
      "expo-platform": "ios",
      "expo-runtime-version": "1.0",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 if expo-protocol-version header is not 1", async () => {
    writeMetadata(validMetadata());
    const app = createTestApp();
    const res = await request(app, "/updates/manifest", {
      "expo-protocol-version": "0",
      "expo-platform": "ios",
      "expo-runtime-version": "1.0",
    });
    expect(res.status).toBe(400);
  });

  it("returns 204 if no current/metadata.json exists", async () => {
    const emptyDir = join(
      tmpdir(),
      `dofek-updates-empty-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    );
    mkdirSync(emptyDir, { recursive: true });
    const app = createTestApp(emptyDir);
    const res = await request(app, "/updates/manifest", {
      "expo-protocol-version": "1",
      "expo-platform": "ios",
      "expo-runtime-version": "1.0",
    });
    expect(res.status).toBe(204);
  });

  it("returns 204 if runtime version does not match", async () => {
    writeMetadata(validMetadata());
    const app = createTestApp();
    const res = await request(app, "/updates/manifest", {
      "expo-protocol-version": "1",
      "expo-platform": "ios",
      "expo-runtime-version": "2.0",
    });
    expect(res.status).toBe(204);
  });

  it("returns 204 if platform does not match", async () => {
    writeMetadata(validMetadata());
    const app = createTestApp();
    const res = await request(app, "/updates/manifest", {
      "expo-protocol-version": "1",
      "expo-platform": "android",
      "expo-runtime-version": "1.0",
    });
    expect(res.status).toBe(204);
  });

  it("returns valid multipart manifest when everything matches", async () => {
    writeMetadata(validMetadata());
    const app = createTestApp();
    const res = await request(app, "/updates/manifest", {
      "expo-protocol-version": "1",
      "expo-platform": "ios",
      "expo-runtime-version": "1.0",
    });
    expect(res.status).toBe(200);

    const contentType = res.headers.get("content-type");
    expect(contentType).toContain("multipart/mixed");
    expect(contentType).toContain("boundary=");

    // Extract the manifest JSON from the multipart body
    const manifest = parseManifestFromMultipart(res.body);

    expect(manifest.id).toBe("2026-03-22-abc123");
    expect(manifest.createdAt).toBe("2026-03-22T12:00:00.000Z");
    expect(manifest.runtimeVersion).toBe("1.0");
    expect(manifest.metadata).toEqual({});
    expect(manifest.extra).toEqual({});
  });

  it("manifest contains correct full URLs for launch asset and assets", async () => {
    writeMetadata(validMetadata());
    const app = createTestApp();
    const res = await request(app, "/updates/manifest", {
      "expo-protocol-version": "1",
      "expo-platform": "ios",
      "expo-runtime-version": "1.0",
    });

    const manifest = parseManifestFromMultipart(res.body);

    expect(manifest.launchAsset).toEqual(
      expect.objectContaining({
        url: "https://dofek.asherlc.com/api/updates/releases/current/bundles/ios-abc123def456.hbc",
        hash: "abc123base64url",
        key: "ios-abc123def456.hbc",
        contentType: "application/javascript",
      }),
    );

    expect(manifest.assets).toHaveLength(1);
    expect(manifest.assets[0].url).toBe(
      "https://dofek.asherlc.com/api/updates/releases/current/assets/asset_abc.png",
    );
    expect(manifest.assets[0].hash).toBe("def456base64url");
    expect(manifest.assets[0].key).toBe("asset_abc.png");
    expect(manifest.assets[0].contentType).toBe("image/png");
    expect(manifest.assets[0].fileExtension).toBe(".png");
  });

  it("response includes expo-protocol-version: 1 header", async () => {
    writeMetadata(validMetadata());
    const app = createTestApp();
    const res = await request(app, "/updates/manifest", {
      "expo-protocol-version": "1",
      "expo-platform": "ios",
      "expo-runtime-version": "1.0",
    });
    expect(res.headers.get("expo-protocol-version")).toBe("1");
  });

  it("204 responses also include expo-protocol-version header", async () => {
    writeMetadata(validMetadata());
    const app = createTestApp();
    const res = await request(app, "/updates/manifest", {
      "expo-protocol-version": "1",
      "expo-platform": "ios",
      "expo-runtime-version": "99.0",
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("expo-protocol-version")).toBe("1");
  });

  it("returns 204 when metadata.json contains malformed JSON", async () => {
    const badDir = join(
      tmpdir(),
      `dofek-updates-malformed-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    );
    const currentDir = join(badDir, "current");
    mkdirSync(currentDir, { recursive: true });
    writeFileSync(join(currentDir, "metadata.json"), "{not valid json!!!");
    const app = createTestApp(badDir);
    const res = await request(app, "/updates/manifest", {
      "expo-protocol-version": "1",
      "expo-platform": "ios",
      "expo-runtime-version": "1.0",
    });
    expect(res.status).toBe(204);
  });

  it("returns 204 when metadata.json has invalid shape", async () => {
    const badDir = join(
      tmpdir(),
      `dofek-updates-bad-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    );
    const currentDir = join(badDir, "current");
    mkdirSync(currentDir, { recursive: true });
    writeFileSync(join(currentDir, "metadata.json"), JSON.stringify({ broken: true }));
    const app = createTestApp(badDir);
    const res = await request(app, "/updates/manifest", {
      "expo-protocol-version": "1",
      "expo-platform": "ios",
      "expo-runtime-version": "1.0",
    });
    expect(res.status).toBe(204);
  });

  it("caches metadata and re-reads on mtime change", async () => {
    writeMetadata(validMetadata());
    const app = createTestApp();

    // First request loads the metadata
    const res1 = await request(app, "/updates/manifest", {
      "expo-protocol-version": "1",
      "expo-platform": "ios",
      "expo-runtime-version": "1.0",
    });
    expect(res1.status).toBe(200);

    // Second request should use cache (same mtime)
    const res2 = await request(app, "/updates/manifest", {
      "expo-protocol-version": "1",
      "expo-platform": "ios",
      "expo-runtime-version": "1.0",
    });
    expect(res2.status).toBe(200);

    // Update metadata with new runtime version and force mtime change
    await new Promise((r) => setTimeout(r, 50));
    const updated = { ...validMetadata(), runtimeVersion: "2.0" };
    writeMetadata(updated);

    // Third request should re-read and get the new version
    const res3 = await request(app, "/updates/manifest", {
      "expo-protocol-version": "1",
      "expo-platform": "ios",
      "expo-runtime-version": "2.0",
    });
    expect(res3.status).toBe(200);

    const manifest = parseManifestFromMultipart(res3.body);
    expect(manifest.runtimeVersion).toBe("2.0");
  });

  it("strips trailing slash from publicUrl", async () => {
    writeMetadata(validMetadata());
    const app = express();
    app.use(
      "/updates",
      createUpdatesRouter({
        updatesDir,
        publicUrl: "https://dofek.asherlc.com/",
        logger: silentLogger,
      }),
    );

    const res = await request(app, "/updates/manifest", {
      "expo-protocol-version": "1",
      "expo-platform": "ios",
      "expo-runtime-version": "1.0",
    });

    const manifest = parseManifestFromMultipart(res.body);
    expect(manifest.launchAsset).toEqual(
      expect.objectContaining({
        url: "https://dofek.asherlc.com/api/updates/releases/current/bundles/ios-abc123def456.hbc",
      }),
    );
  });

  it("serves bundle bytes from /releases/:releaseId/bundles/:key", async () => {
    const metadata = validMetadata();
    writeMetadata(metadata);
    writeReleaseFiles(metadata);
    const app = createTestApp();
    const res = await request(app, `/updates/releases/current/bundles/${metadata.launchAsset.key}`);
    expect(res.status).toBe(200);
    expect(res.body).toBe("bundle-bytes");
    expect(res.headers.get("content-type")).toContain("application/javascript");
  });

  it("serves asset bytes from /releases/:releaseId/assets/:key", async () => {
    const metadata = validMetadata();
    writeMetadata(metadata);
    writeReleaseFiles(metadata);
    const app = createTestApp();
    const assetKey = metadata.assets[0].key;
    const res = await request(app, `/updates/releases/current/assets/${assetKey}`);
    expect(res.status).toBe(200);
    expect(res.body).toBe("asset-bytes");
    expect(res.headers.get("content-type")).toContain("image/png");
  });

  it("returns 404 when bundle file is missing from the requested release", async () => {
    const noBundleDir = join(
      tmpdir(),
      `dofek-updates-no-bundle-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    );
    const currentDir = join(noBundleDir, "current");
    mkdirSync(currentDir, { recursive: true });
    writeFileSync(join(currentDir, "metadata.json"), JSON.stringify(validMetadata()));
    const app = createTestApp(noBundleDir);
    const res = await request(app, "/updates/releases/current/bundles/ios-abc123def456.hbc");
    expect(res.status).toBe(404);
  });

  it("keeps legacy /bundles/:key path working via current release", async () => {
    const metadata = validMetadata();
    writeMetadata(metadata);
    writeReleaseFiles(metadata);
    const app = createTestApp();
    const res = await request(app, `/updates/bundles/${metadata.launchAsset.key}`);
    expect(res.status).toBe(200);
    expect(res.body).toBe("bundle-bytes");
  });
});
