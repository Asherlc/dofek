import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("integration MSW startup", () => {
  it("intercepts a retained Garmin client across successive files without leaking handlers", () => {
    const dir = mkdtempSync(path.join(process.cwd(), ".msw-lifecycle-"));
    try {
      const write = (name: string, content: string) => writeFileSync(path.join(dir, name), content);
      write(
        "sentinel.ts",
        `
import { Socket } from "node:net";
if (!globalThis.sentinelInstalled) {
  globalThis.sentinelInstalled = true;
  Socket.prototype.connect = function () { throw new Error("Unexpected socket"); };
  globalThis.fetch = async () => new Response("synthetic unauthorized", { status: 401 });
}
process.env.GARMIN_CLIENT_ID = "fixture-client";
process.env.GARMIN_CLIENT_SECRET = "fixture-secret";
`,
      );
      write(
        "first.test.ts",
        `
import { it } from "vitest";
import { GarminProvider } from ${JSON.stringify(path.join(process.cwd(), "src/providers/garmin/provider.ts"))};
globalThis.retainedProvider = new GarminProvider();
it("constructs the retained client", () => {});
`,
      );
      write(
        "second.test.ts",
        `
import { afterAll, beforeAll, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
it("uses current handlers and persists rotated authorization before revocation", async () => {
  let persisted;
  server.use(
    http.post("https://diauth.garmin.com/di-oauth2-service/oauth/token", () => HttpResponse.json({ access_token: "rotated", refresh_token: "rotated-refresh", expires_in: 86400 })),
    http.delete("https://apis.garmin.com/partner-gateway/rest/user/registration", () => {
      expect(persisted).toMatchObject({ accessToken: "rotated", refreshToken: "rotated-refresh", authorizationId: "fixture-auth" });
      return HttpResponse.text("outage", { status: 503 });
    }),
  );
  await expect(globalThis.retainedProvider.authSetup().revokeExistingTokens({ accessToken: "old", refreshToken: "old-refresh", expiresAt: new Date("2020-01-01"), providerAccountId: "account", authorizationId: "fixture-auth", scopes: "HEALTH_EXPORT ACTIVITY_EXPORT" }, async tokens => { persisted = tokens; })).rejects.toThrow("service unavailable (503)");
  await expect(fetch("https://unexpected.example.test/")).rejects.toThrow();
});
`,
      );
      write(
        "third.test.ts",
        `
import { afterAll, beforeAll, expect, it } from "vitest";
import { setupServer } from "msw/node";
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
it("does not retain the previous file handlers", async () => {
  await expect(fetch("https://diauth.garmin.com/di-oauth2-service/oauth/token", { method: "POST" })).rejects.toThrow();
});
`,
      );
      write(
        "vitest.config.ts",
        `
import { defineConfig } from "vitest/config";
import { BaseSequencer } from "vitest/node";
import root from ${JSON.stringify(path.join(process.cwd(), "vitest.config.ts"))};
class Sequencer extends BaseSequencer { async sort(files) { return files.sort((a, b) => a.moduleId.localeCompare(b.moduleId)); } }
const integration = root.test.projects.find(project => project.test?.name === "integration").test;
export default defineConfig({ test: { ...integration, include: [${JSON.stringify(`${dir}/*.test.ts`)}], setupFiles: [${JSON.stringify(`${dir}/sentinel.ts`)}, ...(integration.setupFiles ?? [])], sequence: { sequencer: Sequencer }, retry: 0 } });
`,
      );
      const output = execFileSync(
        "pnpm",
        ["exec", "vitest", "run", "--config", path.join(dir, "vitest.config.ts"), "--retry=0"],
        { cwd: process.cwd(), encoding: "utf8", stdio: "pipe" },
      );
      expect(output).toContain("3 passed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
