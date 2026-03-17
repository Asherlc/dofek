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
      "packages/garmin-connect/src/**/*.test.ts",
      "packages/eight-sleep/src/**/*.test.ts",
      "packages/trainerroad-client/src/**/*.test.ts",
      "packages/velohero-client/src/**/*.test.ts",
      "packages/zwift-client/src/**/*.test.ts",
      "packages/whoop-whoop/src/**/*.test.ts",
      "packages/trainingpeaks-connect/src/**/*.test.ts",
    ],
    exclude: ["**/*.integration.test.ts"],
  },
  resolve: {
    alias: {
      "@": "./src",
    },
  },
});
