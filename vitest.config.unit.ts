import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: true,
    include: ["src/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    exclude: ["**/*.integration.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts", "packages/*/src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/test-helpers.ts",
        "**/fixtures/**",
        "**/node_modules/**",
        "src/index.ts",
        "src/server.ts",
        "src/providers/types.ts",
        "src/auth/index.ts",
        "packages/server/src/types.ts",
        "src/db/schema.ts",
        "packages/server/src/index.ts",
        "packages/web/src/**",
        "src/jobs/worker.ts",
        "src/jobs/provider-registration.ts",
        "packages/server/src/lib/start-worker.ts",
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
  },
  resolve: {
    alias: {
      "@": "./src",
    },
  },
});
