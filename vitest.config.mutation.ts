import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    include: ["src/**/*.test.ts", "packages/web/src/**/*.test.ts"],
    exclude: [
      // Integration tests that require a database
      "src/providers/__tests__/*-sync.test.ts",
      "src/providers/__tests__/whoop-coverage.test.ts",
      "src/db/__tests__/dedup.test.ts",
      "src/db/__tests__/tokens.test.ts",
      "src/sync/__tests__/runner.test.ts",
      // Server tests (excluded from mutation entirely)
      "packages/server/**",
    ],
  },
  resolve: {
    alias: {
      "@": "./src",
    },
  },
});
