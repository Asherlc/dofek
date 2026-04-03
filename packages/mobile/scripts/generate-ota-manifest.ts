#!/usr/bin/env node
/**
 * Generates an expo-updates protocol v1 manifest from an `expo export` output directory.
 *
 * Reads dist/metadata.json, computes SHA-256 hashes for each asset and the bundle,
 * copies files into the expected directory structure (bundles/ + assets/), and writes
 * expo-updates-manifest.json.
 */
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

interface ExportMetadata {
  version: number;
  bundler: string;
  fileMetadata: Record<
    string,
    | {
        bundle: string;
        assets: Array<{ path: string; ext: string }>;
      }
    | undefined
  >;
}

interface ManifestAsset {
  hash: string;
  key: string;
  contentType: string;
  fileExtension: string;
}

interface OtaManifest {
  id: string;
  createdAt: string;
  runtimeVersion: string;
  platform: string;
  launchAsset: {
    hash: string;
    key: string;
    contentType: string;
  };
  assets: ManifestAsset[];
}

interface GenerateOptions {
  distDir: string;
  outputDir: string;
  platform: string;
  releaseId: string;
  runtimeVersion: string;
}

const CONTENT_TYPES: Record<string, string> = {
  ttf: "font/ttf",
  otf: "font/otf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  json: "application/json",
};

function sha256Base64Url(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("base64url");
}

function contentTypeForExtension(extension: string): string {
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

export function generateOtaManifest(options: GenerateOptions): OtaManifest {
  const { distDir, outputDir, platform, releaseId, runtimeVersion } = options;

  const metadata: ExportMetadata = JSON.parse(
    readFileSync(join(distDir, "metadata.json"), "utf-8"),
  );

  const platformMetadata = metadata.fileMetadata[platform];
  if (!platformMetadata) {
    throw new Error(`No metadata for platform: ${platform}`);
  }

  // Process the JS bundle
  const bundlePath = join(distDir, platformMetadata.bundle);
  const bundleBuffer = readFileSync(bundlePath);
  const bundleHash = sha256Base64Url(bundleBuffer);
  const bundleKey = basename(platformMetadata.bundle);

  mkdirSync(join(outputDir, "bundles"), { recursive: true });
  copyFileSync(bundlePath, join(outputDir, "bundles", bundleKey));

  // Process assets, deduplicating by path
  mkdirSync(join(outputDir, "assets"), { recursive: true });
  const seenPaths = new Set<string>();
  const assets: ManifestAsset[] = [];

  for (const asset of platformMetadata.assets) {
    if (seenPaths.has(asset.path)) continue;
    seenPaths.add(asset.path);

    const assetPath = join(distDir, asset.path);
    const assetBuffer = readFileSync(assetPath);
    const assetHash = sha256Base64Url(assetBuffer);
    const assetKey = basename(asset.path);

    copyFileSync(assetPath, join(outputDir, "assets", assetKey));

    assets.push({
      hash: assetHash,
      key: assetKey,
      contentType: contentTypeForExtension(asset.ext),
      fileExtension: `.${asset.ext}`,
    });
  }

  const manifest: OtaManifest = {
    id: releaseId,
    createdAt: new Date().toISOString(),
    runtimeVersion,
    platform,
    launchAsset: {
      hash: bundleHash,
      key: bundleKey,
      contentType: "application/javascript",
    },
    assets,
  };

  writeFileSync(join(outputDir, "expo-updates-manifest.json"), JSON.stringify(manifest, null, 2));

  return manifest;
}

// CLI entrypoint
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^file:\/\//, ""))) {
  const [distDir, outputDir, platform = "ios", releaseId, runtimeVersion] = process.argv.slice(2);

  if (!distDir || !outputDir || !releaseId || !runtimeVersion) {
    // biome-ignore lint/suspicious/noConsole: CLI script output
    console.error(
      "Usage: generate-ota-manifest <distDir> <outputDir> <platform> <releaseId> <runtimeVersion>",
    );
    process.exit(1);
  }

  const manifest = generateOtaManifest({ distDir, outputDir, platform, releaseId, runtimeVersion });
  // biome-ignore lint/suspicious/noConsole: CLI script output
  console.log(`Generated manifest with ${manifest.assets.length} assets for platform ${platform}`);
  // biome-ignore lint/suspicious/noConsole: CLI script output
  console.log(`Bundle: ${manifest.launchAsset.key}`);
  // biome-ignore lint/suspicious/noConsole: CLI script output
  console.log(`Runtime version: ${manifest.runtimeVersion}`);
}
