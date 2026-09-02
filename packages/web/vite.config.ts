import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { VitePWA } from "vite-plugin-pwa";

function getCommitHash(): string {
  if (process.env.COMMIT_HASH) return process.env.COMMIT_HASH;
  try {
    return execSync("git rev-parse --short HEAD").toString().trim();
  } catch {
    return "unknown";
  }
}

const commitHash = getCommitHash();
const assetBase = process.env.VITE_ASSET_BASE_URL || "/";
const normalizedAssetBase = assetBase.endsWith("/") ? assetBase : `${assetBase}/`;
const cdnAssetPrefix = URL.canParse(normalizedAssetBase)
  ? new URL("assets/", normalizedAssetBase).href
  : null;

// Workbox matches navigation routes against pathname + search, so every
// server-owned prefix must recognize query-string boundaries too.
const SERVER_OWNED_NAVIGATION_DENYLIST = [
  /^\/api(?:[/?]|$)/,
  /^\/auth(?:[/?]|$)/,
  /^\/callback(?:[/?]|$)/,
  /^\/authorize(?:[/?]|$)/,
  /^\/admin\/queues(?:[/?]|$)/,
  /^\/\.well-known(?:[/?]|$)/,
  /^\/(?:healthz|readyz|metrics)(?:[/?]|$)/,
  /^\/(?:register|token|revoke)(?:[/?]|$)/,
  /^\/assets(?:[/?]|$)/,
];

if (process.env.REQUIRE_SENTRY_AUTH_TOKEN === "true" && !process.env.SENTRY_AUTH_TOKEN) {
  throw new Error("SENTRY_AUTH_TOKEN is required when REQUIRE_SENTRY_AUTH_TOKEN is true.");
}

function isPackage(id: string, packageName: string): boolean {
  const nodeModulesMarker = "/node_modules/";
  let searchStart = 0;
  while (searchStart < id.length) {
    const nodeModulesIndex = id.indexOf(nodeModulesMarker, searchStart);
    if (nodeModulesIndex === -1) {
      return false;
    }

    const packagePath = id.slice(nodeModulesIndex + nodeModulesMarker.length);
    if (packagePath === packageName || packagePath.startsWith(`${packageName}/`)) {
      return true;
    }
    searchStart = nodeModulesIndex + nodeModulesMarker.length;
  }

  return false;
}

function manualChunks(id: string): string | undefined {
  if (isPackage(id, "echarts") || isPackage(id, "echarts-for-react")) {
    return "echarts.lazy";
  }

  if (
    isPackage(id, "@trpc/client") ||
    isPackage(id, "@trpc/react-query") ||
    isPackage(id, "@tanstack/react-query")
  ) {
    return "trpc";
  }

  if (isPackage(id, "react") || isPackage(id, "react-dom")) {
    return "react";
  }

  return undefined;
}

export default defineConfig({
  base: assetBase,
  define: {
    __COMMIT_HASH__: JSON.stringify(commitHash),
  },
  plugins: [
    tanstackRouter(),
    react(),
    tailwindcss(),
    VitePWA({
      base: "/",
      buildBase: "/",
      registerType: "autoUpdate",
      scope: "/",
      manifest: {
        name: "Dofek",
        short_name: "Dofek",
        description: "Health, training, nutrition, body, and recovery data in one dashboard.",
        start_url: "/",
        theme_color: "#eef3ed",
        background_color: "#eef3ed",
        display: "standalone",
        icons: [
          {
            src: "/favicon-192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "/logo-512.png",
            sizes: "512x512",
            type: "image/png",
          },
        ],
      },
      workbox: {
        navigateFallback: "index.html",
        navigateFallbackDenylist: SERVER_OWNED_NAVIGATION_DENYLIST,
        ...(cdnAssetPrefix
          ? {
              modifyURLPrefix: {
                "assets/": cdnAssetPrefix,
              },
            }
          : {}),
      },
    }),
    sentryVitePlugin({
      org: "east-bay-software",
      project: "dofek-web",
      release: { name: commitHash },
      sourcemaps: { filesToDeleteAfterUpload: ["../dist/**/*.map"] },
      disable: !process.env.SENTRY_AUTH_TOKEN,
    }),
  ],
  root: "src",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks,
      },
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:3000",
      "/auth": "http://localhost:3000",
      "/callback": "http://localhost:3000",
    },
  },
});
