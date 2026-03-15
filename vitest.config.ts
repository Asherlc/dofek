import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: true,
    include: ["src/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts", "packages/*/src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/__tests__/**",
        "**/node_modules/**",
        "src/index.ts",
        "src/server.ts",
        "src/providers/types.ts",
        "src/fit/index.ts",
        "src/auth/index.ts",
        "packages/server/src/types.ts",
        "src/db/schema.ts",
        "packages/server/src/index.ts",
        "packages/web/src/**",
        "packages/whoop-whoop/src/**",
        // New provider stubs — sync logic requires API integration tests.
        // Parsing is tested via *-client package tests.
        "src/providers/concept2.ts",
        "src/providers/coros.ts",
        "src/providers/cycling-analytics.ts",
        "src/providers/decathlon.ts",
        "src/providers/eight-sleep.ts",
        "src/providers/komoot.ts",
        "src/providers/mapmyfitness.ts",
        "src/providers/suunto.ts",
        "src/providers/trainerroad.ts",
        "src/providers/ultrahuman.ts",
        "src/providers/velohero.ts",
        "src/providers/wger.ts",
        "src/providers/xert.ts",
        "src/providers/zwift.ts",
        // Reverse-engineered API client packages — require real API connections
        "packages/eight-sleep/src/client.ts",
        "packages/eight-sleep/src/types.ts",
        "packages/garmin-connect/src/client.ts",
        "packages/garmin-connect/src/types.ts",
        "packages/trainerroad-client/src/client.ts",
        "packages/trainerroad-client/src/types.ts",
        "packages/velohero-client/src/client.ts",
        "packages/velohero-client/src/types.ts",
        "packages/zwift-client/src/client.ts",
        "packages/zwift-client/src/types.ts",
      ],
      thresholds: {
        lines: 92,
        functions: 95,
        branches: 81,
        statements: 92,
      },
    },
  },
  resolve: {
    alias: {
      "@": "./src",
    },
  },
});
