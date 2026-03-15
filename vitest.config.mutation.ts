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
      "src/providers/*-sync.test.ts",
      "src/providers/*-coverage.test.ts",
      "src/providers/*-import.test.ts",
      "src/providers/*-ext.test.ts",
      "src/db/*.test.ts",
      "src/db/test-helpers.ts",
      "src/sync/runner.test.ts",
    ],
  },
  resolve: {
    alias: {
      "@": "./src",
    },
  },
});
