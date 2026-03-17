import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    teardownTimeout: 60_000,
    fileParallelism: true,
    pool: "forks",
    retry: 2,
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "packages/*/src/**/*.test.ts"],
          exclude: ["**/*.integration.test.ts"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["src/**/*.integration.test.ts", "packages/*/src/**/*.integration.test.ts"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts", "packages/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/test-helpers.ts", "**/fixtures/**", "**/node_modules/**"],
      thresholds: {
        lines: 93,
        functions: 94,
        branches: 86,
        statements: 93,
      },
    },
  },
  resolve: {
    alias: {
      "@": "./src",
    },
  },
});
