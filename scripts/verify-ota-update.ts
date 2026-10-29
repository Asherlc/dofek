import { createHash, verify } from "node:crypto";
import { getMultipartBoundary, parseMultipart } from "@remix-run/multipart-parser";
import { parseDictionary } from "structured-headers";
import { z } from "zod";
import { checkOtaManifest } from "./check-ota-manifest.ts";

const signedAsset = z.object({ url: z.url(), hash: z.string().min(1) });
const signedManifest = z.object({
  id: z.string().min(1),
  runtimeVersion: z.string().min(1),
  launchAsset: signedAsset,
  assets: z.array(signedAsset),
});

interface AuditOptions {
  url: string;
  runtimeVersion: string;
  channel: string;
  expectedId: string;
  certificate: string;
  fetchImplementation: typeof fetch;
}

/** Audit the exact signed manifest and asset bytes an installed client receives. */
export async function verifyOtaUpdate(options: AuditOptions): Promise<string> {
  let captured: Response | undefined;
  const checked = await checkOtaManifest({
    requestOptions: {
      url: options.url,
      runtimeVersion: options.runtimeVersion,
      channel: options.channel,
      platform: "ios",
    },
    timeoutMilliseconds: 5_000,
    fetchImplementation: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("expo-expect-signature", 'sig, keyid="main", alg="rsa-v1_5-sha256"');
      const response = await options.fetchImplementation(input, { ...init, headers });
      captured = response.clone();
      return response;
    },
  });
  if (!checked || !captured) throw new Error("Expected a deployed OTA manifest for audit");
  const contentType = captured.headers.get("content-type");
  if (!contentType) throw new Error("OTA audit response has no content type");
  const boundary = getMultipartBoundary(contentType);
  if (!boundary) throw new Error("OTA audit response has no multipart boundary");
  const parts = [...parseMultipart(new Uint8Array(await captured.arrayBuffer()), { boundary })];
  const manifests = parts.filter((part) => part.name === "manifest");
  const part = manifests[0];
  if (manifests.length !== 1 || !part)
    throw new Error("OTA audit requires exactly one manifest part");
  const raw = part.bytes;
  const manifest = signedManifest.parse(JSON.parse(part.text));
  if (manifest.id !== options.expectedId) throw new Error("OTA update identity changed");
  if (manifest.runtimeVersion !== options.runtimeVersion) throw new Error("OTA runtime changed");
  const signatureHeader = part.headers["expo-signature"];
  if (!signatureHeader) throw new Error("OTA manifest signature is missing");
  const dictionary = parseDictionary(signatureHeader);
  const signature = z.string().min(1).parse(dictionary.get("sig")?.[0]);
  z.literal("main").parse(dictionary.get("keyid")?.[0]);
  const signatureBytes = Buffer.from(signature, "base64");
  if (signatureBytes.toString("base64") !== signature)
    throw new Error("OTA manifest signature must use canonical base64 encoding");
  if (!verify("RSA-SHA256", Buffer.from(raw), options.certificate, signatureBytes)) {
    throw new Error("OTA manifest signature does not match the installed device certificate");
  }
  for (const asset of [manifest.launchAsset, ...manifest.assets]) {
    const response = await options.fetchImplementation(asset.url, {
      // Expo iOS uses a 60-second request timeout; also bound the audit body read.
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`OTA asset returned HTTP ${response.status}`);
    const hash = createHash("sha256")
      .update(Buffer.from(await response.arrayBuffer()))
      .digest("base64url");
    if (hash !== asset.hash)
      throw new Error(`OTA asset hash mismatch for expected hash ${asset.hash}`);
  }
  return manifest.id;
}
