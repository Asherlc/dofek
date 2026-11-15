import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { checkOtaManifest } from "./check-ota-manifest.ts";

const requestOptions = {
  appId: "release-app-id",
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

function createValidManifestResponse(
  id = "a2018e93-2f3e-45aa-8556-aa8b3c38380c",
  runtimeVersion = "1.0",
): Response {
  const boundary = "ota-health-check-boundary";
  const manifest = JSON.stringify({
    assets: [],
    createdAt: "2026-07-21T22:33:19.000Z",
    extra: {},
    id,
    launchAsset: {
      contentType: "application/javascript",
      key: "index.bundle",
      url: "https://ota.dofek.asherlc.com/assets?asset=index.bundle",
    },
    metadata: { branch: "main" },
    runtimeVersion,
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

async function runMobileUpdateCheck(
  arguments_: string[],
  outputPath?: string,
): Promise<{
  status: number | null;
  stderr: string;
  stdout: string;
}> {
  const child = spawn("pnpm", ["check:mobile-update", ...arguments_], {
    env: { ...process.env, ...(outputPath ? { GITHUB_OUTPUT: outputPath } : {}) },
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

async function runMobileUpdateCheckAgainst(response: Response): Promise<{
  output: string;
  result: { status: number | null; stderr: string; stdout: string };
}> {
  const body = await response.text();
  const headers = Object.fromEntries(response.headers.entries());
  const server = createServer((_request, reply) => {
    reply.writeHead(response.status, headers).end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server port");
  const directory = mkdtempSync(join(tmpdir(), "ota-manifest-cli-"));
  const outputPath = join(directory, "github-output");
  try {
    const result = await runMobileUpdateCheck(
      [
        "--app-id",
        "release-app-id",
        "--url",
        `http://127.0.0.1:${address.port}/manifest`,
        "--runtime-version",
        "1.0",
      ],
      outputPath,
    );
    return { output: existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "", result };
  } finally {
    server.close();
    await once(server, "close");
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("checkOtaManifest", () => {
  it("writes verified live manifest identity to GITHUB_OUTPUT through the public CLI", async () => {
    const { output, result } = await runMobileUpdateCheckAgainst(createValidManifestResponse());
    expect(result.status, result.stderr).toBe(0);
    expect(output).toBe("manifest_id=a2018e93-2f3e-45aa-8556-aa8b3c38380c\nmanifest_runtime=1.0\n");
  });

  it("writes the explicit no-update sentinel and runtime through the public CLI", async () => {
    const { output, result } = await runMobileUpdateCheckAgainst(
      createDirectiveResponse({ type: "noUpdateAvailable" }),
    );
    expect(result.status, result.stderr).toBe(0);
    expect(output).toBe("manifest_id=none\nmanifest_runtime=1.0\n");
  });

  it.each(["none", "not-a-uuid", "47a9ab69-6103-6981-398b-a90d59a49a8a\nmanifest_runtime=spoof"])(
    "does not write an invalid or sentinel manifest ID to GITHUB_OUTPUT: %j",
    async (id) => {
      const { output, result } = await runMobileUpdateCheckAgainst(createValidManifestResponse(id));
      expect(result.status).not.toBe(0);
      expect(output).toBe("");
    },
  );

  it("rejects a runtime containing output-file line breaks before making the manifest request", async () => {
    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount += 1;
      response.writeHead(204).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server port");
    const directory = mkdtempSync(join(tmpdir(), "ota-runtime-output-"));
    const outputPath = join(directory, "github-output");
    try {
      const result = await runMobileUpdateCheck(
        [
          "--app-id",
          "release-app-id",
          "--url",
          `http://127.0.0.1:${address.port}/manifest`,
          "--runtime-version",
          "1.0\nmanifest_id=spoof",
        ],
        outputPath,
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("runtime version cannot contain line breaks");
      expect(requestCount).toBe(0);
      expect(existsSync(outputPath)).toBe(false);
    } finally {
      server.close();
      await once(server, "close");
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous duplicate manifest parts", async () => {
    const valid = createValidManifestResponse();
    const body = await valid.text();
    const first = body.replace(/--ota-health-check-boundary--\r\n$/, "");
    const second = body.replace("a2018e93-2f3e-45aa-8556-aa8b3c38380c", "different-update-id");
    await expect(
      checkOtaManifest({
        requestOptions,
        fetchImplementation: vi.fn(
          async () => new Response(first + second, { headers: valid.headers }),
        ),
        timeoutMilliseconds: 5_000,
      }),
    ).rejects.toThrow("exactly one manifest");
  });
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

  it.each([
    { arguments: [], message: "--runtime-version is required" },
    { arguments: ["--runtime-version", "runtime"], message: "--app-id is required" },
  ])(
    "fails before requesting a manifest when required CLI context is missing: $message",
    async (missing) => {
      let requestCount = 0;
      const server = createServer((_request, response) => {
        requestCount += 1;
        response.writeHead(204).end();
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test server port");
      try {
        const result = await runMobileUpdateCheck([
          "--url",
          `http://127.0.0.1:${address.port}`,
          ...missing.arguments,
        ]);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(missing.message);
        expect(requestCount).toBe(0);
      } finally {
        server.close();
        await once(server, "close");
      }
    },
  );

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
        "expo-app-id": "release-app-id",
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

  it("rejects an unterminated multipart response", async () => {
    const valid = createValidManifestResponse();
    const body = (await valid.text()).replace(/--ota-health-check-boundary--\r\n$/, "");
    await expect(
      checkOtaManifest({
        requestOptions,
        fetchImplementation: vi.fn(async () => new Response(body, { headers: valid.headers })),
        timeoutMilliseconds: 5_000,
      }),
    ).rejects.toThrow();
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
        "--app-id",
        "release-app-id",
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
        "expo-app-id": "release-app-id",
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
