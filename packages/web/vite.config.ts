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

export default defineConfig({
  define: {
    __COMMIT_HASH__: JSON.stringify(getCommitHash()),
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
      release: { name: getCommitHash() },
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
        manualChunks: {
          echarts: ["echarts", "echarts-for-react"],
          react: ["react", "react-dom"],
          trpc: ["@trpc/client", "@trpc/react-query", "@tanstack/react-query"],
        },
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
