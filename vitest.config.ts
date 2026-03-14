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
      ],
      thresholds: {
        lines: 93,
        functions: 96,
        branches: 82,
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
