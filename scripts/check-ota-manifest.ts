import { z } from "zod";

const manifestUrl = "https://ota.dofek.asherlc.com/manifest";

const assetSchema = z.object({
  contentType: z.string(),
  key: z.string().min(1),
  url: z.url(),
});

const manifestSchema = z.object({
  assets: z.array(assetSchema),
  createdAt: z.string().min(1),
  extra: z.record(z.string(), z.unknown()),
  id: z.string().min(1),
  launchAsset: assetSchema,
  metadata: z.record(z.string(), z.string()),
  runtimeVersion: z.string().min(1),
});

interface OtaManifestCheckOptions {
  fetchImplementation: typeof fetch;
  timeoutMilliseconds: number;
}

function extractBoundary(contentType: string): string | null {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  return boundaryMatch?.[1] ?? boundaryMatch?.[2] ?? null;
}

function extractManifestPart(body: string, boundary: string): string | null {
  const normalizedBody = body.replaceAll("\r\n", "\n");
  for (const part of normalizedBody.split(`--${boundary}`)) {
    const separatorIndex = part.indexOf("\n\n");
    if (separatorIndex === -1) {
      continue;
    }

    const headers = part.slice(0, separatorIndex).toLowerCase();
    if (
      !headers.includes('content-disposition: form-data; name="manifest"') ||
      (!headers.includes("content-type: application/json") &&
        !headers.includes("content-type: application/expo+json"))
    ) {
      continue;
    }

    return part.slice(separatorIndex + 2).trim();
  }

  return null;
}

export async function checkOtaManifest({
  fetchImplementation,
  timeoutMilliseconds,
}: OtaManifestCheckOptions): Promise<void> {
  let response: Response;
  try {
    response = await fetchImplementation(manifestUrl, {
      headers: {
        accept: "application/expo+json, application/json, multipart/mixed",
        "expo-channel-name": "production",
        "expo-platform": "ios",
        "expo-protocol-version": "1",
        "expo-runtime-version": "1.0",
      },
      signal: AbortSignal.timeout(timeoutMilliseconds),
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`OTA manifest request timed out after ${timeoutMilliseconds}ms`, {
        cause: error,
      });
    }
    throw error;
  }

  if (response.status === 204) {
    return;
  }
  if (response.status !== 200) {
    throw new Error(`OTA manifest request returned HTTP ${response.status}`);
  }
  if (response.headers.get("expo-protocol-version") !== "1") {
    throw new Error("OTA manifest response is missing Expo protocol version 1");
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/mixed")) {
    throw new Error("OTA manifest response is not multipart/mixed");
  }

  const boundary = extractBoundary(contentType);
  if (!boundary) {
    throw new Error("OTA manifest response is missing a multipart boundary");
  }

  const manifestPart = extractManifestPart(await response.text(), boundary);
  if (!manifestPart) {
    throw new Error("OTA manifest response is missing a valid manifest part");
  }

  manifestSchema.parse(JSON.parse(manifestPart));
}

const isDirectExecution =
  typeof process.argv[1] === "string" &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));

if (isDirectExecution) {
  await checkOtaManifest({ fetchImplementation: fetch, timeoutMilliseconds: 5_000 });
  console.log("OTA server returned a valid production manifest response");
}
