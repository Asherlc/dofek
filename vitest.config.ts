import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const zeppStubPath = path.resolve(dirname, "packages/zepp/src/__mocks__/zos-stub.js");
const zeppModules = [
  "@zos/app-access",
  "@zos/sensor",
  "@zos/fs",
  "@zos/utils",
  "@zos/device",
  "@zos/display",
  "@zos/interaction",
  "@zos/app",
  "@zos/ble",
  "@zos/app-service",
  "@zeppos/zml/base-page",
  "@zeppos/zml/base-side",
  "@zeppos/zml/base-app",
  "@zeppos/zml/3.0/module/messaging/plugin/page",
  "@zeppos/zml/3.0/module/messaging/plugin/side",
  "@zeppos/zml/3.0/module/messaging/plugin/app",
  "@zeppos/zml",
];
const zeppAliases: Record<string, string> = {};
for (const moduleName of zeppModules) {
  zeppAliases[moduleName] = `${zeppStubPath}?zepp-module=${encodeURIComponent(moduleName)}`;
}

const sharedTestConfig = {
  globals: true,
  testTimeout: 30_000,
  hookTimeout: 120_000,
  teardownTimeout: 60_000,
  fileParallelism: true,
  pool: "forks" as const,
  execArgv: ["--no-experimental-webstorage"],
  retry: 2,
};

const testCredentialEncryptionKey = Buffer.from("a".repeat(32), "utf8").toString("base64");

const sharedTestEnv = {
  ACCOUNT_ERASURE_LEDGER_KEYRING_JSON: JSON.stringify({
    activeKeyId: "test-v1",
    keys: {
      "test-v0": Buffer.from("b".repeat(32), "utf8").toString("base64"),
      "test-v1": testCredentialEncryptionKey,
    },
  }),
  CREDENTIAL_ENCRYPTION_KEY_BASE64: testCredentialEncryptionKey,
  CREDENTIAL_ENCRYPTION_KEY_NAMESPACE: "dofek-test",
  CREDENTIAL_ENCRYPTION_KEY_NAME: "provider-credentials-test",
  PUBLIC_URL: "https://app.example.test",
  // Classify the test environment as non-production by default so no test run is
  // ever treated as a production deployment. The production-only guard in
  // initProductionSentry() keys off DEPLOY_ENVIRONMENT; an explicit non-prod
  // default keeps a stray env mutation in one test from letting local
  // test-fixture errors reach production error tracking. Tests that need to
  // exercise the production path must opt in explicitly via vi.stubEnv and
  // restore it afterwards.
  DEPLOY_ENVIRONMENT: "test",
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
        resolve: {
          alias: zeppAliases,
        },
        test: {
          ...sharedTestConfig,
          name: "unit",
          setupFiles: [path.resolve(dirname, "packages/web/test-setup.ts")],
          include: [
            ".github/workflows/**/*.test.ts",
            "entrypoint.test.ts",
            "analytics/models/**/*.test.ts",
            "src/**/*.test.ts",
            "packages/web/vite.config.test.ts",
            "packages/*/src/**/*.test.{ts,tsx}",
            "packages/zepp/src/**/*.test.ts",
            "packages/zepp/setting/**/*.test.ts",
            "packages/zepp/workout-extension/**/*.test.ts",
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
          maxWorkers: 1,
          isolate: false,
          include: [
            "src/**/*.integration.test.ts",
            "packages/*/src/**/*.integration.test.ts",
            "scripts/**/*.integration.test.ts",
          ],
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
      provider: "istanbul",
      reporter: ["text", "json-summary", "json", "lcov"],
      include: ["src/**/*.ts", "packages/*/src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/*.test-helper.{ts,tsx}",
        "**/test-helpers/**",
        "**/test-helpers.ts",
        "**/fixtures/**",
        "**/node_modules/**",
        "**/routeTree.gen.ts",
        "src/db/clickhouse-migrations/**",
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
    alias: { "@": "./src", ...zeppAliases },
  },
});
