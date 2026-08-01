import { defineProject } from "vitest/config";

export default defineProject({
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  test: {
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    teardownTimeout: 60_000,
    fileParallelism: true,
    pool: "forks",
    retry: 2,
    name: "mobile",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["**/*.integration.test.ts", "**/node_modules/**"],
    setupFiles: ["test-setup.ts"],
    environment: "jsdom",
  },
});
