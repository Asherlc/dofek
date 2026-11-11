import { getMultipartBoundary, parseMultipart } from "@remix-run/multipart-parser";
import { z } from "zod";

const defaultCommandOptions = {
  channel: "production",
  platform: "ios",
  url: "https://ota.dofek.asherlc.com/manifest",
} satisfies Omit<OtaManifestRequestOptions, "runtimeVersion" | "appId">;

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

const commandOptionsSchema = z.object({
  appId: z.string({ error: "--app-id is required" }).trim().min(1, "--app-id is required"),
  channel: z.string().min(1),
  platform: z.enum(["android", "ios"]),
  runtimeVersion: z
    .string({ error: "--runtime-version is required; resolve the app runtime before checking OTA" })
    .min(1, "--runtime-version is required; resolve the app runtime before checking OTA"),
  url: z.url(),
});

type OtaManifest = z.infer<typeof manifestSchema>;
type OtaPlatform = z.infer<typeof commandOptionsSchema.shape.platform>;

interface OtaManifestRequestOptions {
  appId: string;
  channel: string;
  platform: OtaPlatform;
  runtimeVersion: string;
  url: string;
}

interface OtaManifestCheckOptions {
  fetchImplementation: typeof fetch;
  timeoutMilliseconds: number;
  requestOptions: OtaManifestRequestOptions;
}

function extractJsonPart(body: string, boundary: string, partName: string): string | null {
  const parts = [...parseMultipart(Buffer.from(body), { boundary })];
  const matchingParts = parts.filter((part) => part.name === partName);
  if (matchingParts.length > 1)
    throw new Error(`OTA response requires exactly one ${partName} part`);
  const part = matchingParts[0];
  if (
    !part ||
    !["application/json", "application/expo+json"].includes(
      part.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() ?? "",
    )
  )
    return null;
  return part.text;
}

function readOptionValue(arguments_: string[], index: number, optionName: string): string {
  const value = arguments_[index + 1];
  if (!value) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

function parseCommandOptions(arguments_: string[]): OtaManifestRequestOptions {
  const options: {
    channel: string;
    platform: string;
    runtimeVersion?: string;
    appId?: string;
    url: string;
  } = { ...defaultCommandOptions };

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument) {
      continue;
    }
    switch (argument) {
      case "--app-id":
        options.appId = readOptionValue(arguments_, index, argument);
        index += 1;
        break;
      case "--channel":
        options.channel = readOptionValue(arguments_, index, argument);
        index += 1;
        break;
      case "--platform":
        options.platform = readOptionValue(arguments_, index, argument);
        index += 1;
        break;
      case "--runtime-version":
        options.runtimeVersion = readOptionValue(arguments_, index, argument);
        index += 1;
        break;
      case "--url":
        options.url = readOptionValue(arguments_, index, argument);
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${argument}`);
    }
  }

  return commandOptionsSchema.parse(options);
}

export async function checkOtaManifest({
  fetchImplementation,
  timeoutMilliseconds,
  requestOptions,
}: OtaManifestCheckOptions): Promise<OtaManifest | null> {
  let response: Response;
  try {
    response = await fetchImplementation(requestOptions.url, {
      headers: {
        accept: "application/expo+json, application/json, multipart/mixed",
        "expo-app-id": requestOptions.appId,
        "expo-channel-name": requestOptions.channel,
        "expo-platform": requestOptions.platform,
        "expo-protocol-version": "1",
        "expo-runtime-version": requestOptions.runtimeVersion,
      },
      signal: AbortSignal.timeout(timeoutMilliseconds),
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`OTA manifest request timed out after ${timeoutMilliseconds}ms`, {
        cause: error,
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to reach ${requestOptions.url}: ${message}`, { cause: error });
  }

  if (response.status === 204) {
    return null;
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

  const boundary = getMultipartBoundary(contentType);
  if (!boundary) {
    throw new Error("OTA manifest response is missing a multipart boundary");
  }

  const body = await response.text();
  const manifestPart = extractJsonPart(body, boundary, "manifest");
  if (!manifestPart) {
    const directivePart = extractJsonPart(body, boundary, "directive");
    if (directivePart) {
      z.object({ type: z.literal("noUpdateAvailable") }).parse(JSON.parse(directivePart));
      return null;
    }
    throw new Error("OTA manifest response is missing a valid manifest part");
  }

  const manifest = manifestSchema.parse(JSON.parse(manifestPart));
  if (manifest.runtimeVersion !== requestOptions.runtimeVersion) {
    throw new Error("OTA manifest runtime does not match requested runtime");
  }
  return manifest;
}

const isDirectExecution =
  typeof process.argv[1] === "string" &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));

if (isDirectExecution) {
  const requestOptions = parseCommandOptions(process.argv.slice(2));
  const manifest = await checkOtaManifest({
    fetchImplementation: fetch,
    requestOptions,
    timeoutMilliseconds: 5_000,
  });
  if (!manifest) {
    console.log(
      `No update deployed for platform=${requestOptions.platform} runtimeVersion=${requestOptions.runtimeVersion}`,
    );
  } else {
    console.log(`id:              ${manifest.id}`);
    console.log(`createdAt:       ${manifest.createdAt}`);
    console.log(`runtimeVersion:  ${manifest.runtimeVersion}`);
    console.log(`launchAsset:     ${manifest.launchAsset.key}`);
    console.log(`assets:          ${manifest.assets.length}`);
  }
}
