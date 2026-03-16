import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    include: [
      "src/**/*.test.ts",
      "packages/web/src/**/*.test.ts",
      "packages/server/src/**/*.test.ts",
    ],
    exclude: ["**/*.integration.test.ts"],
  },
  resolve: {
    alias: {
      "@": "./src",
    },
  },
});
