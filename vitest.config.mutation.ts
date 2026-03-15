import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    include: [
      "src/**/*.test.ts",
      "packages/web/src/**/*.test.ts",
      "packages/server/src/**/*.test.ts",
    ],
    exclude: [
      // Integration tests that require a database (use setupTestDatabase)
      "src/providers/__tests__/*-sync.test.ts",
      "src/providers/__tests__/*-coverage.test.ts",
      "src/providers/__tests__/*-import.test.ts",
      "src/providers/__tests__/*-ext.test.ts",
      "src/db/__tests__/**",
      "src/sync/__tests__/runner.test.ts",
    ],
  },
  resolve: {
    alias: {
      "@": "./src",
    },
  },
});
