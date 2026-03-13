import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    pool: "forks",
    poolOptions: { forks: { maxForks: 2 } },
    include: ["src/**/*.test.ts", "packages/*/src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": "./src",
    },
  },
});
