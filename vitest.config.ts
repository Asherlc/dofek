import { defineConfig } from "vitest/config";

const sharedTestConfig = {
  globals: true,
  testTimeout: 30_000,
  hookTimeout: 120_000,
  teardownTimeout: 60_000,
  fileParallelism: true,
  pool: "forks" as const,
  retry: 2,
};

export default defineConfig({
  test: {
    ...sharedTestConfig,
    projects: [
      {
        esbuild: {
          jsx: "automatic",
        },
        test: {
          ...sharedTestConfig,
          name: "unit",
          include: [
            "src/**/*.test.ts",
            "packages/*/src/**/*.test.{ts,tsx}",
            "scripts/**/*.test.ts",
          ],
          exclude: ["**/*.integration.test.ts", "packages/mobile/**"],
        },
      },
      "packages/mobile/vitest.config.ts",
      {
        test: {
          ...sharedTestConfig,
          name: "integration",
          include: ["src/**/*.integration.test.ts", "packages/*/src/**/*.integration.test.ts"],
          env: {
            TEST_TOKEN_USER_ID: "00000000-0000-0000-0000-000000000001",
          },
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "json", "lcov"],
      include: ["src/**/*.ts", "packages/*/src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/test-helpers.ts",
        "**/fixtures/**",
        "**/node_modules/**",
        "**/routeTree.gen.ts",
      ],
      thresholds: process.env.VITEST_COVERAGE_SKIP_THRESHOLDS
        ? undefined
        : {
            lines: 93.5,
            functions: 94.5,
            branches: 89,
            statements: 93.5,
          },
    },
  },
  resolve: {
    alias: {
      "@": "./src",
    },
  },
});
