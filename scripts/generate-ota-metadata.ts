/**
 * Generates metadata.json for the self-hosted Expo Updates OTA server
 * from the output of `expo export --platform ios`.
 *
 * Usage:
 *   node --experimental-transform-types scripts/generate-ota-metadata.ts \
 *     --dist packages/mobile/dist \
 *     --runtime-version 1.0 \
 *     --output /tmp/ota-release/metadata.json
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

function parseArgs(argv: Array<string>): { dist: string; runtimeVersion: string; output: string } {
  let dist = "";
  let runtimeVersion = "";
  let output = "";

  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--dist" && argv[i + 1]) {
      dist = argv[++i];
    } else if (argv[i] === "--runtime-version" && argv[i + 1]) {
      runtimeVersion = argv[++i];
    } else if (argv[i] === "--output" && argv[i + 1]) {
      output = argv[++i];
    }
  }

  if (!dist || !runtimeVersion || !output) {
    console.error(
      "Usage: generate-ota-metadata.ts --dist <path> --runtime-version <ver> --output <path>",
    );
    process.exit(1);
  }

  return { dist, runtimeVersion, output };
}

function sha256Base64Url(data: Buffer): string {
  return createHash("sha256").update(data).digest("base64url");
}

function findFiles(dir: string, pattern: RegExp): Array<string> {
  const results: Array<string> = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findFiles(fullPath, pattern));
      } else if (pattern.test(entry.name)) {
        results.push(fullPath);
      }
    }
  } catch {
    // Directory doesn't exist
  }
  return results;
}

const CONTENT_TYPE_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".js": "application/javascript",
  ".hbc": "application/javascript",
};

function contentTypeForFile(filename: string): string {
  const ext = extname(filename).toLowerCase();
  return CONTENT_TYPE_MAP[ext] ?? "application/octet-stream";
}

function main() {
  const { dist, runtimeVersion, output } = parseArgs(process.argv);

  // Find the launch asset (Hermes bytecode bundle)
  const bundleFiles = findFiles(dist, /\.(hbc|js)$/);
  const iosBundles = bundleFiles.filter((f) => f.includes("ios"));

  if (iosBundles.length === 0) {
    console.error(`No iOS bundle found in ${dist}`);
    process.exit(1);
  }

  const bundlePath = iosBundles[0];
  const bundleData = readFileSync(bundlePath);
  const bundleHash = sha256Base64Url(bundleData);
  const bundleKey = basename(bundlePath);

  // Find asset files
  const assetsDir = join(dist, "assets");
  const assetFiles: Array<{
    hash: string;
    key: string;
    contentType: string;
    fileExtension: string;
  }> = [];

  try {
    const assetStat = statSync(assetsDir);
    if (assetStat.isDirectory()) {
      for (const file of readdirSync(assetsDir)) {
        const filePath = join(assetsDir, file);
        if (!statSync(filePath).isFile()) continue;

        const data = readFileSync(filePath);
        const hash = sha256Base64Url(data);
        const ext = extname(file);

        assetFiles.push({
          hash,
          key: file,
          contentType: contentTypeForFile(file),
          fileExtension: ext || ".bin",
        });
      }
    }
  } catch {
    // No assets directory — that's fine
  }

  const metadata = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    runtimeVersion,
    platform: "ios",
    launchAsset: {
      hash: bundleHash,
      key: bundleKey,
      contentType: "application/javascript",
    },
    assets: assetFiles,
  };

  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(metadata, null, 2));

  console.log(`Generated metadata.json with ${assetFiles.length} assets`);
  console.log(`  Bundle: ${bundleKey} (${bundleHash.slice(0, 12)}...)`);
  console.log(`  Runtime version: ${runtimeVersion}`);
  console.log(`  Output: ${output}`);
}

main();
