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

const testCredentialEncryptionKey = Buffer.from("a".repeat(32), "utf8").toString("base64");

const sharedTestConfig = {
  globals: true,
  testTimeout: 30_000,
  hookTimeout: 120_000,
  fileParallelism: true,
  pool: "forks" as const,
  execArgv: ["--no-experimental-webstorage"],
  env: {
    ACCOUNT_ERASURE_LEDGER_KEYRING_JSON: JSON.stringify({
      activeKeyId: "test-v1",
      keys: {
        "test-v0": Buffer.from("b".repeat(32), "utf8").toString("base64"),
        "test-v1": testCredentialEncryptionKey,
      },
    }),
    TEST_TOKEN_USER_ID: "00000000-0000-0000-0000-000000000001",
    CREDENTIAL_ENCRYPTION_KEY_BASE64: testCredentialEncryptionKey,
    CREDENTIAL_ENCRYPTION_KEY_NAMESPACE: "dofek-test",
    CREDENTIAL_ENCRYPTION_KEY_NAME: "provider-credentials-test",
    DEPLOY_ENVIRONMENT: "test",
    PUBLIC_URL: "https://app.example.test",
  },
  setupFiles: [path.resolve(dirname, "packages/web/test-setup.ts")],
};

const nodeTestIncludes = [
  "analytics/models/**/*.test.ts",
  "src/**/*.test.ts",
  "packages/format/src/**/*.test.ts",
  "packages/scoring/src/**/*.test.ts",
  "packages/nutrition/src/**/*.test.ts",
  "packages/training/src/**/*.test.ts",
  "packages/recovery/src/**/*.test.ts",
  "packages/zones/src/**/*.test.ts",
  "packages/stats/src/**/*.test.ts",
  "packages/onboarding/src/**/*.test.ts",
  "packages/providers-meta/src/**/*.test.ts",
  "packages/auth/src/**/*.test.ts",
  "packages/mcp-contracts/src/**/*.test.ts",
  "packages/server/src/**/*.test.ts",
  "packages/garmin-connect/src/**/*.test.ts",
  "packages/eight-sleep/src/**/*.test.ts",
  "packages/kaya-client/src/**/*.test.ts",
  "packages/trainerroad-client/src/**/*.test.ts",
  "packages/velohero-client/src/**/*.test.ts",
  "packages/mountain-project-client/src/**/*.test.ts",
  "packages/zwift-client/src/**/*.test.ts",
  "packages/zepp-client/src/**/*.test.ts",
  "packages/whoop-whoop/src/**/*.test.ts",
  "packages/trainingpeaks-connect/src/**/*.test.ts",
  "packages/provider-http/src/**/*.test.ts",
  "packages/peloton-client/src/**/*.test.ts",
  "packages/xert-client/src/**/*.test.ts",
  "packages/zepp/src/**/*.test.ts",
  "packages/zepp/workout-extension/**/*.test.ts",
  "packages/web/vite.config.test.ts",
];

export default defineConfig({
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  test: {
    projects: [
      {
        test: {
          ...sharedTestConfig,
          name: "node",
          include: nodeTestIncludes,
          exclude: ["**/*.integration.test.ts", "**/node_modules/**"],
          environment: "node",
        },
      },
      {
        test: {
          ...sharedTestConfig,
          name: "web",
          include: ["packages/web/src/**/*.test.ts", "packages/web/src/**/*.test.tsx"],
          exclude: ["**/*.integration.test.ts", "**/node_modules/**"],
          environment: "jsdom",
        },
      },
      {
        test: {
          ...sharedTestConfig,
          name: "mobile",
          include: ["packages/mobile/**/*.test.{ts,tsx}"],
          exclude: ["**/*.integration.test.ts", "**/node_modules/**"],
          environment: "jsdom",
          setupFiles: [
            path.resolve(dirname, "packages/web/test-setup.ts"),
            path.resolve(dirname, "packages/mobile/test-setup.ts"),
          ],
        },
      },
    ],
  },
  resolve: {
    alias: {
      "@": "./src",
      ...zeppAliases,
    },
  },
});
