import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";

interface PrecacheEntry {
  revision?: string;
  url: string;
}

const webPackageRoot = path.dirname(fileURLToPath(import.meta.url));
let outputDirectory: string | null = null;
let precacheEntries: PrecacheEntry[] = [];
let navigationDenylist: RegExp[] = [];
let runtimeRouteCount = 0;
let clientsClaimCount = 0;
let skipWaitingCount = 0;
let indexHtml = "";
let registrationScript = "";

beforeAll(async () => {
  outputDirectory = await mkdtemp(path.join(tmpdir(), "dofek-web-pwa-"));
  const previousAssetBase = process.env.VITE_ASSET_BASE_URL;
  const previousCommitHash = process.env.COMMIT_HASH;
  process.env.VITE_ASSET_BASE_URL = "https://assets.example.test/web/release-123/";
  process.env.COMMIT_HASH = "release-123";

  try {
    await build({
      configFile: path.join(webPackageRoot, "vite.config.ts"),
      logLevel: "silent",
      root: path.join(webPackageRoot, "src"),
      build: {
        outDir: outputDirectory,
        sourcemap: false,
      },
    });
  } finally {
    if (previousAssetBase === undefined) {
      delete process.env.VITE_ASSET_BASE_URL;
    } else {
      process.env.VITE_ASSET_BASE_URL = previousAssetBase;
    }
    if (previousCommitHash === undefined) {
      delete process.env.COMMIT_HASH;
    } else {
      process.env.COMMIT_HASH = previousCommitHash;
    }
  }

  const serviceWorker = await readFile(path.join(outputDirectory, "sw.js"), "utf8");
  indexHtml = await readFile(path.join(outputDirectory, "index.html"), "utf8");
  registrationScript = await readFile(path.join(outputDirectory, "registerSW.js"), "utf8");

  class NavigationRoute {
    constructor(
      _handler: unknown,
      options: {
        denylist?: RegExp[];
      },
    ) {
      navigationDenylist = options.denylist ?? [];
    }
  }

  const workbox = {
    cleanupOutdatedCaches: () => undefined,
    clientsClaim: () => {
      clientsClaimCount += 1;
    },
    createHandlerBoundToURL: (url: string) => url,
    NavigationRoute,
    precacheAndRoute: (entries: PrecacheEntry[]) => {
      precacheEntries = entries;
    },
    registerRoute: () => {
      runtimeRouteCount += 1;
    },
  };
  const define = (
    _dependencies: string[],
    factory: (workboxRuntime: typeof workbox) => unknown,
  ) => factory(workbox);
  const serviceWorkerGlobal = {
    addEventListener: () => undefined,
    define,
    skipWaiting: () => {
      skipWaitingCount += 1;
    },
  };

  vm.runInNewContext(serviceWorker, {
    define,
    self: serviceWorkerGlobal,
  });
}, 30_000);

afterAll(async () => {
  if (outputDirectory) {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

describe("production PWA build", () => {
  it("keeps the service worker and its registration on the application origin", () => {
    expect(indexHtml).toContain('src="/registerSW.js"');
    expect(indexHtml).toContain('href="/manifest.webmanifest"');
    expect(registrationScript).toContain("register('/sw.js', { scope: '/' })");
    expect(clientsClaimCount).toBe(1);
    expect(skipWaitingCount).toBe(1);
  });

  it("rewrites hashed precache assets to the configured CDN", () => {
    const cdnAssets = precacheEntries.filter(({ url }) =>
      url.startsWith("https://assets.example.test/web/release-123/assets/"),
    );

    expect(cdnAssets.length).toBeGreaterThan(0);
    expect(precacheEntries).toContainEqual(
      expect.objectContaining({
        url: "index.html",
      }),
    );
  });

  it("falls back for SPA documents while preserving every server-owned route", () => {
    const receivesApplicationShell = (pathname: string) =>
      !navigationDenylist.some((pattern) => pattern.test(pathname));

    expect(receivesApplicationShell("/dashboard")).toBe(true);
    expect(receivesApplicationShell("/admin")).toBe(true);

    for (const pathname of [
      "/api/trpc/recovery.readinessScore",
      "/auth/login/google",
      "/callback",
      "/authorize",
      "/admin/queues",
      "/.well-known/oauth-authorization-server",
      "/healthz",
      "/readyz",
      "/metrics",
      "/register",
      "/token",
      "/revoke",
      "/assets/missing.js",
    ]) {
      expect(receivesApplicationShell(pathname), pathname).toBe(false);
    }

    for (const pathname of ["/authorizefoo", "/api2", "/administer"]) {
      expect(receivesApplicationShell(pathname), pathname).toBe(true);
    }

    expect(runtimeRouteCount).toBe(1);
    expect(
      precacheEntries.some(({ url }) =>
        /^\/?(?:api|auth|callback|authorize|admin\/queues)(?:\/|$)/.test(url),
      ),
    ).toBe(false);
  });
});
