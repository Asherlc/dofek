import { z } from "zod";

const defaultCommandOptions = {
  channel: "production",
  platform: "ios",
  runtimeVersion: "1.0",
  url: "https://ota.dofek.asherlc.com/manifest",
} satisfies OtaManifestRequestOptions;

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
  channel: z.string().min(1),
  platform: z.enum(["android", "ios"]),
  runtimeVersion: z.string().min(1),
  url: z.url(),
});

type OtaManifest = z.infer<typeof manifestSchema>;
type OtaPlatform = z.infer<typeof commandOptionsSchema.shape.platform>;

interface OtaManifestRequestOptions {
  channel: string;
  platform: OtaPlatform;
  runtimeVersion: string;
  url: string;
}

interface OtaManifestCheckOptions {
  fetchImplementation: typeof fetch;
  timeoutMilliseconds: number;
  requestOptions?: OtaManifestRequestOptions;
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
    runtimeVersion: string;
    url: string;
  } = { ...defaultCommandOptions };

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument) {
      continue;
    }
    switch (argument) {
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
  requestOptions = defaultCommandOptions,
}: OtaManifestCheckOptions): Promise<OtaManifest | null> {
  let response: Response;
  try {
    response = await fetchImplementation(requestOptions.url, {
      headers: {
        accept: "application/expo+json, application/json, multipart/mixed",
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

  const boundary = extractBoundary(contentType);
  if (!boundary) {
    throw new Error("OTA manifest response is missing a multipart boundary");
  }

  const manifestPart = extractManifestPart(await response.text(), boundary);
  if (!manifestPart) {
    throw new Error("OTA manifest response is missing a valid manifest part");
  }

  return manifestSchema.parse(JSON.parse(manifestPart));
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
