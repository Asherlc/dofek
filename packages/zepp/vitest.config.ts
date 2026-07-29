import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const stubPath = path.resolve(dirname, "src/__mocks__/zos-stub.js");

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
  "@zeppos/zml",
  "@zeppos/zml/base-page",
  "@zeppos/zml/base-side",
  "@zeppos/zml/base-app",
  "@zeppos/zml/3.0/module/messaging/plugin/page",
  "@zeppos/zml/3.0/module/messaging/plugin/side",
  "@zeppos/zml/3.0/module/messaging/plugin/app",
];

const alias: Record<string, string> = {};
for (const mod of zeppModules) {
  alias[mod] = stubPath;
}

export default defineConfig({
  test: {
    globals: false,
    include: ["src/*.test.ts", "setting/**/*.test.ts", "workout-extension/**/*.test.ts"],
  },
  resolve: {
    alias,
  },
});
