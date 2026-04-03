import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateOtaManifest } from "./generate-ota-manifest.ts";

function sha256Base64Url(data: Buffer): string {
  return createHash("sha256").update(data).digest("base64url");
}

function setupExportFixture(dir: string) {
  const bundleContent = Buffer.from("fake-hermes-bytecode");
  const assetContent = Buffer.from("fake-png-data");

  mkdirSync(join(dir, "_expo/static/js/ios"), { recursive: true });
  mkdirSync(join(dir, "assets"), { recursive: true });

  const bundlePath = "_expo/static/js/ios/index-abc123.hbc";
  writeFileSync(join(dir, bundlePath), bundleContent);
  writeFileSync(join(dir, "assets/deadbeef"), assetContent);

  const metadata = {
    version: 0,
    bundler: "metro",
    fileMetadata: {
      ios: {
        bundle: bundlePath,
        assets: [{ path: "assets/deadbeef", ext: "png" }],
      },
    },
  };
  writeFileSync(join(dir, "metadata.json"), JSON.stringify(metadata));

  return { bundleContent, assetContent };
}

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ota-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  // cleanup handled by OS temp directory
});

describe("generateOtaManifest", () => {
  it("generates a valid manifest from expo export output", () => {
    const distDir = makeTempDir();
    const outputDir = makeTempDir();
    const { bundleContent, assetContent } = setupExportFixture(distDir);

    const manifest = generateOtaManifest({
      distDir,
      outputDir,
      platform: "ios",
      releaseId: "2026-04-03-abc12345",
      runtimeVersion: "1.0",
    });

    expect(manifest.id).toBe("2026-04-03-abc12345");
    expect(manifest.runtimeVersion).toBe("1.0");
    expect(manifest.platform).toBe("ios");
    expect(manifest.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(manifest.launchAsset.key).toBe("index-abc123.hbc");
    expect(manifest.launchAsset.hash).toBe(sha256Base64Url(bundleContent));
    expect(manifest.launchAsset.contentType).toBe("application/javascript");

    expect(manifest.assets).toHaveLength(1);
    expect(manifest.assets[0].key).toBe("deadbeef");
    expect(manifest.assets[0].hash).toBe(sha256Base64Url(assetContent));
    expect(manifest.assets[0].contentType).toBe("image/png");
    expect(manifest.assets[0].fileExtension).toBe(".png");
  });

  it("copies bundle to bundles/ and assets to assets/ in output dir", () => {
    const distDir = makeTempDir();
    const outputDir = makeTempDir();
    const { bundleContent, assetContent } = setupExportFixture(distDir);

    generateOtaManifest({
      distDir,
      outputDir,
      platform: "ios",
      releaseId: "test-release",
      runtimeVersion: "1.0",
    });

    const copiedBundle = readFileSync(join(outputDir, "bundles/index-abc123.hbc"));
    expect(copiedBundle).toEqual(bundleContent);

    const copiedAsset = readFileSync(join(outputDir, "assets/deadbeef"));
    expect(copiedAsset).toEqual(assetContent);

    const manifestFile = JSON.parse(
      readFileSync(join(outputDir, "expo-updates-manifest.json"), "utf-8"),
    );
    expect(manifestFile.id).toBe("test-release");
  });

  it("deduplicates assets with the same path", () => {
    const distDir = makeTempDir();
    const outputDir = makeTempDir();

    const bundleContent = Buffer.from("bundle");
    mkdirSync(join(distDir, "_expo/static/js/ios"), { recursive: true });
    mkdirSync(join(distDir, "assets"), { recursive: true });
    writeFileSync(join(distDir, "_expo/static/js/ios/index-abc.hbc"), bundleContent);
    writeFileSync(join(distDir, "assets/samehash"), Buffer.from("asset"));

    const metadata = {
      version: 0,
      bundler: "metro",
      fileMetadata: {
        ios: {
          bundle: "_expo/static/js/ios/index-abc.hbc",
          assets: [
            { path: "assets/samehash", ext: "png" },
            { path: "assets/samehash", ext: "png" },
          ],
        },
      },
    };
    writeFileSync(join(distDir, "metadata.json"), JSON.stringify(metadata));

    const manifest = generateOtaManifest({
      distDir,
      outputDir,
      platform: "ios",
      releaseId: "dedup-test",
      runtimeVersion: "1.0",
    });

    expect(manifest.assets).toHaveLength(1);
  });

  it("throws when metadata.json is missing platform entry", () => {
    const distDir = makeTempDir();
    const outputDir = makeTempDir();

    writeFileSync(
      join(distDir, "metadata.json"),
      JSON.stringify({ version: 0, bundler: "metro", fileMetadata: {} }),
    );

    expect(() =>
      generateOtaManifest({
        distDir,
        outputDir,
        platform: "ios",
        releaseId: "test",
        runtimeVersion: "1.0",
      }),
    ).toThrow("No metadata for platform: ios");
  });
});
