import { defineConfig } from "vitest/config";
import { unitSharedProject } from "./vitest.config.ts";

// Mutation testing for shared-domain source needs only the shared unit suite.
// Keep it free of server/web/mobile, integration, and native FIT baselines.
export default defineConfig({
  test: {
    projects: [unitSharedProject],
  },
});
