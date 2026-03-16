import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: true,
    include: ["src/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    exclude: ["**/*.integration.test.ts", "**/__tests__/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts", "packages/*/src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/test-helpers.ts",
        "**/fixtures/**",
        "**/node_modules/**",
      ],
      thresholds: {
        lines: 69,
        functions: 87,
        branches: 86,
        statements: 69,
      },
    },
  },
  resolve: {
    alias: {
      "@": "./src",
    },
  },
});
