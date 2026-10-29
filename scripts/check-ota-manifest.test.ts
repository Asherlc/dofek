import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { checkOtaManifest } from "./check-ota-manifest.ts";

const requestOptions = {
  channel: "production",
  platform: "ios",
  runtimeVersion: "1.0",
  url: "https://ota.dofek.asherlc.com/manifest",
} as const;

const manifestUrl = "https://ota.dofek.asherlc.com/manifest";

function createDirectiveResponse(value: unknown): Response {
  const boundary = "new-runtime-boundary";
  return new Response(
    [
      `--${boundary}`,
      'Content-Disposition: form-data; name="directive"',
      "Content-Type: application/json",
      "",
      JSON.stringify(value),
      `--${boundary}--`,
      "",
    ].join("\r\n"),
    {
      headers: {
        "content-type": `multipart/mixed; boundary=${boundary}`,
        "expo-protocol-version": "1",
      },
    },
  );
}

function createValidManifestResponse(): Response {
  const boundary = "ota-health-check-boundary";
  const manifest = JSON.stringify({
    assets: [],
    createdAt: "2026-07-21T22:33:19.000Z",
    extra: {},
    id: "a2018e93-2f3e-45aa-8556-aa8b3c38380c",
    launchAsset: {
      contentType: "application/javascript",
      key: "index.bundle",
      url: "https://ota.dofek.asherlc.com/assets?asset=index.bundle",
    },
    metadata: { branch: "main" },
    runtimeVersion: "1.0",
  });
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="manifest"',
    "Content-Type: application/json",
    "",
    manifest,
    `--${boundary}--`,
    "",
  ].join("\r\n");

  return new Response(body, {
    headers: {
      "content-type": `multipart/mixed; boundary=${boundary}`,
      "expo-protocol-version": "1",
    },
    status: 200,
  });
}

async function runMobileUpdateCheck(arguments_: string[]): Promise<{
  status: number | null;
  stderr: string;
  stdout: string;
}> {
  const child = spawn("pnpm", ["check:mobile-update", ...arguments_], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let stdout = "";
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  const [status] = await once(child, "close");
  return { status: typeof status === "number" ? status : null, stderr, stdout };
}

describe("checkOtaManifest", () => {
  it("accepts a protocol directive when the requested runtime has no published update", async () => {
    const response = createDirectiveResponse({ type: "noUpdateAvailable" });
    await expect(
      checkOtaManifest({
        requestOptions,
        fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(response),
        timeoutMilliseconds: 5_000,
      }),
    ).resolves.toBeNull();
  });

  it.each([{ type: "rollBackToEmbedded" }, { type: "unknown" }, {}])(
    "rejects directives that do not establish a valid empty runtime: %j",
    async (directive) => {
      await expect(
        checkOtaManifest({
          requestOptions,
          fetchImplementation: vi
            .fn<typeof fetch>()
            .mockResolvedValue(createDirectiveResponse(directive)),
          timeoutMilliseconds: 5_000,
        }),
      ).rejects.toThrow();
    },
  );

  it("rejects a manifest for a different runtime than the requested release", async () => {
    await expect(
      checkOtaManifest({
        requestOptions: { ...requestOptions, runtimeVersion: "new-native-fingerprint" },
        fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(createValidManifestResponse()),
        timeoutMilliseconds: 5_000,
      }),
    ).rejects.toThrow("OTA manifest runtime does not match requested runtime");
  });

  it("fails before requesting a manifest when the CLI runtime is missing", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(204).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server port");
    try {
      const result = await runMobileUpdateCheck(["--url", `http://127.0.0.1:${address.port}`]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("--runtime-version is required");
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("accepts a 204 response and sends the production Expo request headers", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));

    await expect(
      checkOtaManifest({ requestOptions, fetchImplementation, timeoutMilliseconds: 5_000 }),
    ).resolves.toBeNull();

    expect(fetchImplementation).toHaveBeenCalledWith(manifestUrl, {
      headers: {
        accept: "application/expo+json, application/json, multipart/mixed",
        "expo-channel-name": "production",
        "expo-platform": "ios",
        "expo-protocol-version": "1",
        "expo-runtime-version": "1.0",
      },
      signal: expect.any(AbortSignal),
    });
  });

  it("accepts a valid multipart manifest response", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(createValidManifestResponse());

    await expect(
      checkOtaManifest({ requestOptions, fetchImplementation, timeoutMilliseconds: 5_000 }),
    ).resolves.toMatchObject({
      id: "a2018e93-2f3e-45aa-8556-aa8b3c38380c",
      runtimeVersion: "1.0",
    });
  });

  it("sends command-line URL and Expo request header overrides", async () => {
    let requestHeaders: IncomingHttpHeaders | undefined;
    let requestUrl: string | undefined;
    const server = createServer((request, response) => {
      requestHeaders = request.headers;
      requestUrl = request.url;
      response.statusCode = 204;
      response.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test OTA server did not expose a TCP port");
    }
    const url = `http://127.0.0.1:${address.port}/manifest`;

    try {
      const result = await runMobileUpdateCheck([
        "--url",
        url,
        "--channel",
        "preview-pr-1783",
        "--runtime-version",
        "2.0",
        "--platform",
        "android",
      ]);

      expect(result).toMatchObject({
        status: 0,
        stdout: expect.stringContaining(
          "No update deployed for platform=android runtimeVersion=2.0",
        ),
      });
      expect(requestUrl).toBe("/manifest");
      expect(requestHeaders).toMatchObject({
        "expo-channel-name": "preview-pr-1783",
        "expo-platform": "android",
        "expo-protocol-version": "1",
        "expo-runtime-version": "2.0",
      });
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("rejects an HTTP 400 response", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("No channel name provided", { status: 400 }));

    await expect(
      checkOtaManifest({ requestOptions, fetchImplementation, timeoutMilliseconds: 5_000 }),
    ).rejects.toThrow("OTA manifest request returned HTTP 400");
  });

  it("rejects a malformed HTTP 200 response", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("not a multipart manifest", {
        headers: {
          "content-type": "text/plain",
          "expo-protocol-version": "1",
        },
        status: 200,
      }),
    );

    await expect(
      checkOtaManifest({ requestOptions, fetchImplementation, timeoutMilliseconds: 5_000 }),
    ).rejects.toThrow("OTA manifest response is not multipart/mixed");
  });

  it("rejects a request that exceeds the timeout", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("This operation was aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );

    await expect(
      checkOtaManifest({ requestOptions, fetchImplementation, timeoutMilliseconds: 1 }),
    ).rejects.toThrow("OTA manifest request timed out after 1ms");
  });
});
