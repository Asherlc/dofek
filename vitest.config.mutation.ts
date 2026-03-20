import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  test: {
    globals: true,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    include: [
      "src/**/*.test.ts",
      "packages/format/src/**/*.test.ts",
      "packages/scoring/src/**/*.test.ts",
      "packages/nutrition/src/**/*.test.ts",
      "packages/training/src/**/*.test.ts",
      "packages/stats/src/**/*.test.ts",
      "packages/onboarding/src/**/*.test.ts",
      "packages/providers-meta/src/**/*.test.ts",
      "packages/auth/src/**/*.test.ts",
      "packages/web/src/**/*.test.ts",
      "packages/server/src/**/*.test.ts",
      "packages/garmin-connect/src/**/*.test.ts",
      "packages/eight-sleep/src/**/*.test.ts",
      "packages/trainerroad-client/src/**/*.test.ts",
      "packages/velohero-client/src/**/*.test.ts",
      "packages/zwift-client/src/**/*.test.ts",
      "packages/whoop-whoop/src/**/*.test.ts",
      "packages/trainingpeaks-connect/src/**/*.test.ts",
      "packages/ios/**/*.test.{ts,tsx}",
    ],
    exclude: ["**/*.integration.test.ts", "**/node_modules/**"],
    setupFiles: ["packages/ios/test-setup.ts"],
    environmentMatchGlobs: [["packages/ios/**", "jsdom"]],
  },
  resolve: {
    alias: {
      "@": "./src",
    },
  },
});
