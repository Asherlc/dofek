import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { sentryVitePlugin } from "@sentry/vite-plugin";

function getCommitHash(): string {
  if (process.env.COMMIT_HASH) return process.env.COMMIT_HASH;
  try {
    return execSync("git rev-parse --short HEAD").toString().trim();
  } catch {
    return "unknown";
  }
}

const commitHash = getCommitHash();

function isPackage(id: string, packageName: string): boolean {
  return id.includes(`/node_modules/${packageName}/`);
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
  base: process.env.VITE_ASSET_BASE_URL || "/",
  define: {
    __COMMIT_HASH__: JSON.stringify(commitHash),
  },
  plugins: [
    tanstackRouter({
      routesDirectory: "./routes",
      generatedRouteTree: "./routeTree.gen.ts",
    }),
    react(),
    tailwindcss(),
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
