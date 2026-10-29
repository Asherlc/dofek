import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const endpoint = "https://api.github.com/users/Asherlc/packages/container/dofek-ota";
const server = setupServer();
const originalArguments = process.argv;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("GITHUB_REPOSITORY", "Asherlc/dofek");
  vi.stubEnv("GH_TOKEN", "test-token");
  process.argv = ["node", "check-ota-image-visibility.ts"];
});
afterEach(() => {
  server.resetHandlers();
  process.argv = originalArguments;
  vi.unstubAllEnvs();
});
afterAll(() => server.close());

describe("OTA image privacy gate", () => {
  it.each([
    { name: "another-package", package_type: "container" },
    { name: "dofek-ota", package_type: "npm" },
  ])("rejects a private package with the wrong identity: %j", async (identity) => {
    server.use(http.get(endpoint, () => HttpResponse.json({ ...identity, visibility: "private" })));
    await expect(import("./check-ota-image-visibility.ts")).rejects.toThrow();
  });
  it("accepts an existing private container package", async () => {
    server.use(
      http.get(endpoint, () =>
        HttpResponse.json({ name: "dofek-ota", package_type: "container", visibility: "private" }),
      ),
    );
    await expect(import("./check-ota-image-visibility.ts")).resolves.toBeDefined();
  });

  it.each(["public", "internal"])("blocks a %s package", async (visibility) => {
    server.use(
      http.get(endpoint, () =>
        HttpResponse.json({ name: "dofek-ota", package_type: "container", visibility }),
      ),
    );
    await expect(import("./check-ota-image-visibility.ts")).rejects.toThrow(
      "OTA image package must be private",
    );
  });

  it("allows a not-yet-created package only before publication", async () => {
    server.use(
      http.get(endpoint, () => HttpResponse.json({ message: "Not Found" }, { status: 404 })),
    );
    await expect(import("./check-ota-image-visibility.ts")).resolves.toBeDefined();
  });

  it("requires the package to exist after publication", async () => {
    process.argv.push("--require-existing");
    server.use(
      http.get(endpoint, () => HttpResponse.json({ message: "Not Found" }, { status: 404 })),
    );
    await expect(import("./check-ota-image-visibility.ts")).rejects.toThrow(
      "OTA image package was not found after publication",
    );
  });

  it.each([403, 500])("blocks publication when GitHub returns HTTP %s", async (status) => {
    server.use(
      http.get(endpoint, () => HttpResponse.json({ message: "Request failed" }, { status })),
    );
    await expect(import("./check-ota-image-visibility.ts")).rejects.toThrow(
      `GitHub returned HTTP ${status}`,
    );
  });
});
