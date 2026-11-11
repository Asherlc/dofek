import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { createContext, runInContext } from "node:vm";
import { createServer } from "vite";
import { describe, expect, it } from "vitest";
import configuration from "./main";

describe("native Storybook worker environment", () => {
  it("initializes a real transformed map worker environment without a browser window", async () => {
    if (typeof configuration.viteFinal !== "function")
      throw new Error("Expected Vite configuration hook");
    const configured = await Reflect.apply(configuration.viteFinal, configuration, [
      {
        configFile: false,
        root: process.cwd(),
        logLevel: "silent",
        server: { middlewareMode: true, hmr: false, watch: null },
        optimizeDeps: { noDiscovery: true },
        plugins: [
          {
            name: "react-native-web-framework-globals",
            enforce: "pre",
            config: () => ({ define: { global: "window" } }),
          },
        ],
      },
      {},
    ]);
    const server = await createServer(configured);
    try {
      const workerFile = realpathSync(
        createRequire(import.meta.url).resolve("maplibre-gl/dist/maplibre-gl-worker.mjs"),
      );
      const worker = await server.transformRequest(`/@fs/${workerFile}?worker_file&type=module`);
      if (!worker) throw new Error("Expected transformed worker module");
      const environment = await server.transformRequest("/@vite/env");
      if (!environment) throw new Error("Expected transformed worker environment");
      const context = createContext({});
      expect(() => runInContext(environment.code, context)).not.toThrow();
      expect(runInContext("global === globalThis", context)).toBe(true);
    } finally {
      await server.close();
    }
  });
});
