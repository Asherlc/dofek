import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));

const sharedTestConfig = {
  globals: true,
  testTimeout: 30_000,
  hookTimeout: 120_000,
  teardownTimeout: 60_000,
  fileParallelism: true,
  pool: "forks" as const,
  retry: 2,
};

const testCredentialEncryptionKey = Buffer.from("a".repeat(32), "utf8").toString("base64");

const sharedTestEnv = {
  CREDENTIAL_ENCRYPTION_KEY_BASE64: testCredentialEncryptionKey,
  CREDENTIAL_ENCRYPTION_KEY_NAMESPACE: "dofek-test",
  CREDENTIAL_ENCRYPTION_KEY_NAME: "provider-credentials-test",
};

const configuredClickHouseUrl = process.env.CLICKHOUSE_URL?.trim();
const testClickHouseUrl =
  configuredClickHouseUrl && configuredClickHouseUrl.length > 0
    ? configuredClickHouseUrl
    : "http://localhost:8123";

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
            "entrypoint.test.ts",
            "analytics/models/**/*.test.ts",
            "src/**/*.test.ts",
            "packages/*/src/**/*.test.{ts,tsx}",
            "dofek-zepp/src/**/*.test.ts",
            "scripts/**/*.test.ts",
          ],
          exclude: ["**/*.integration.test.ts", "packages/mobile/**"],
          env: sharedTestEnv,
        },
      },
      "packages/mobile/vitest.config.ts",
      {
        test: {
          ...sharedTestConfig,
          name: "integration",
          fileParallelism: false,
          poolOptions: {
            forks: {
              singleFork: true,
            },
          },
          include: ["src/**/*.integration.test.ts", "packages/*/src/**/*.integration.test.ts"],
          exclude: ["**/packages/mobile/**"],
          env: {
            ...sharedTestEnv,
            CLICKHOUSE_URL: testClickHouseUrl,
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
      "@zos/sensor": path.resolve(dirname, "dofek-zepp/src/__mocks__/zos-stub.js"),
      "@zos/fs": path.resolve(dirname, "dofek-zepp/src/__mocks__/zos-stub.js"),
      "@zos/utils": path.resolve(dirname, "dofek-zepp/src/__mocks__/zos-stub.js"),
      "@zos/device": path.resolve(dirname, "dofek-zepp/src/__mocks__/zos-stub.js"),
      "@zos/display": path.resolve(dirname, "dofek-zepp/src/__mocks__/zos-stub.js"),
      "@zos/interaction": path.resolve(dirname, "dofek-zepp/src/__mocks__/zos-stub.js"),
      "@zos/app": path.resolve(dirname, "dofek-zepp/src/__mocks__/zos-stub.js"),
      "@zos/ble": path.resolve(dirname, "dofek-zepp/src/__mocks__/zos-stub.js"),
      "@zos/app-service": path.resolve(dirname, "dofek-zepp/src/__mocks__/zos-stub.js"),
      "@zeppos/zml": path.resolve(dirname, "dofek-zepp/src/__mocks__/zos-stub.js"),
      "@zeppos/zml/base-page": path.resolve(dirname, "dofek-zepp/src/__mocks__/zos-stub.js"),
      "@zeppos/zml/base-side": path.resolve(dirname, "dofek-zepp/src/__mocks__/zos-stub.js"),
      "@zeppos/zml/base-app": path.resolve(dirname, "dofek-zepp/src/__mocks__/zos-stub.js"),
      "@zeppos/zml/3.0/module/messaging/plugin/page": path.resolve(
        dirname,
        "dofek-zepp/src/__mocks__/zos-stub.js",
      ),
      "@zeppos/zml/3.0/module/messaging/plugin/side": path.resolve(
        dirname,
        "dofek-zepp/src/__mocks__/zos-stub.js",
      ),
      "@zeppos/zml/3.0/module/messaging/plugin/app": path.resolve(
        dirname,
        "dofek-zepp/src/__mocks__/zos-stub.js",
      ),
    },
  },
});
