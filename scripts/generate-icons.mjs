import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const svgPath = resolve(root, "packages/web/src/public/icon.svg");
const svg = readFileSync(svgPath);

const targets = [
  // iOS app icon (1024x1024, no rounded corners — iOS applies its own mask)
  {
    path: resolve(root, "packages/ios/assets/icon.png"),
    size: 1024,
    removeRoundedRect: true,
  },
  // Web favicon PNG (32x32)
  {
    path: resolve(root, "packages/web/src/public/favicon-32.png"),
    size: 32,
  },
  // Web favicon large (192x192 for PWA/Android)
  {
    path: resolve(root, "packages/web/src/public/favicon-192.png"),
    size: 192,
  },
  // Apple touch icon (180x180)
  {
    path: resolve(root, "packages/web/src/public/apple-touch-icon.png"),
    size: 180,
  },
  // Logo for use in the app (512x512)
  {
    path: resolve(root, "packages/web/src/public/logo-512.png"),
    size: 512,
  },
];

for (const target of targets) {
  let svgInput = svg;

  if (target.removeRoundedRect) {
    // For iOS: replace rounded rect with plain rect (iOS adds its own superellipse mask)
    svgInput = Buffer.from(svg.toString().replace('rx="224"', ""));
  }

  await sharp(svgInput).resize(target.size, target.size).png().toFile(target.path);

  console.log(`Generated ${target.path} (${target.size}x${target.size})`);
}

console.log("\nDone!");
