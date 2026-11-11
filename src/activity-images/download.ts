import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import type { StoredImageMetadata } from "../db/activity-images.ts";

export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const privateAddresses = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  privateAddresses.addSubnet(address, prefix, "ipv4");
const specialV6 = new BlockList();
specialV6.addSubnet("2001::", 23, "ipv6");
specialV6.addSubnet("2001:db8::", 32, "ipv6");
specialV6.addSubnet("2002::", 16, "ipv6");
export function isPublicImageAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !privateAddresses.check(address, "ipv4");
  if (family === 6) return /^[23]/i.test(address) && !specialV6.check(address, "ipv6");
  return false;
}
export class ImageDownloadError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number;

  constructor(code: string, retryable = false, retryAfterSeconds = 0) {
    super(code);
    this.code = code;
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
export function validateImageUrl(value: string, allowedOrigins: string[]): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !allowedOrigins.includes(url.origin)
  )
    throw new ImageDownloadError("image_origin_rejected");
  return url;
}
const formats: Record<string, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  heif: "image/heif",
};
export async function inspectImageBytes(
  bytes: Buffer,
  contentType: string,
): Promise<Omit<StoredImageMetadata, "objectKey">> {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES)
    throw new ImageDownloadError("image_size_limit");
  return inspectImageOriginal(
    bytes,
    contentType,
    bytes.length,
    createHash("sha256").update(bytes).digest("hex"),
  );
}
async function inspectImageOriginal(
  input: Buffer | string,
  contentType: string,
  sizeBytes: number,
  sha256: string,
): Promise<Omit<StoredImageMetadata, "objectKey">> {
  const metadata = await sharp(input, { limitInputPixels: 100_000_000, animated: true }).metadata();
  let mimeType = metadata.format ? formats[metadata.format] : undefined;
  if (metadata.format === "heif" && metadata.compression === "av1") mimeType = "image/avif";
  if (!mimeType || !metadata.width || !metadata.height)
    throw new ImageDownloadError("unsupported_image");
  const declared = contentType.split(";")[0]?.trim().toLowerCase();
  if (declared !== mimeType && !(mimeType === "image/heif" && declared === "image/heic"))
    throw new ImageDownloadError("image_MIME_mismatch");
  if (metadata.width * metadata.height > 100_000_000)
    throw new ImageDownloadError("image_pixel_limit");
  return {
    sha256,
    mimeType,
    sizeBytes,
    width: metadata.width,
    height: metadata.height,
  };
}
async function getPublicImage(
  url: URL,
  signal: AbortSignal,
  filePath: string,
): Promise<{
  status: number;
  location: string | null;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  retryAfterSeconds: number;
}> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some((a) => !isPublicImageAddress(a.address)))
    throw new ImageDownloadError("image_address_rejected");
  const chosen = addresses[0];
  if (!chosen) throw new ImageDownloadError("image_dns_failed", true);
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        signal,
        agent: false,
        family: chosen.family,
        lookup: (_host, _options, callback) => callback(null, chosen.address, chosen.family),
        headers: { Accept: "image/*" },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const retryAfter = res.headers["retry-after"];
        const numericRetryAfter = Number(retryAfter);
        const parsedRetryAfter = retryAfter
          ? Number.isNaN(numericRetryAfter)
            ? Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000)
            : numericRetryAfter
          : 0;
        const retryAfterSeconds = Number.isFinite(parsedRetryAfter)
          ? Math.max(0, parsedRetryAfter)
          : 0;
        if (status !== 200) {
          res.resume();
          resolve({
            status,
            location: res.headers.location ?? null,
            contentType: "",
            sizeBytes: 0,
            sha256: "",
            retryAfterSeconds,
          });
          return;
        }
        const length = res.headers["content-length"];
        if (length && Number(length) > MAX_IMAGE_BYTES) {
          res.destroy();
          reject(new ImageDownloadError("image_size_limit"));
          return;
        }
        const hash = createHash("sha256");
        let size = 0;
        const meter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length;
            if (size > MAX_IMAGE_BYTES) {
              callback(new ImageDownloadError("image_size_limit"));
              return;
            }
            hash.update(chunk);
            callback(null, chunk);
          },
        });
        pipeline(res, meter, createWriteStream(filePath), { signal }).then(() => {
          if (!size || (length && Number(length) !== size)) {
            reject(new ImageDownloadError(size ? "image_truncated" : "image_size_limit", size > 0));
            return;
          }
          resolve({
            status,
            location: null,
            contentType: res.headers["content-type"] ?? "",
            sizeBytes: size,
            sha256: hash.digest("hex"),
            retryAfterSeconds,
          });
        }, reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}
export interface DownloadedImage extends Omit<StoredImageMetadata, "objectKey"> {
  filePath: string;
  cleanup(): Promise<void>;
}
export async function downloadActivityImage(input: {
  url: string;
  signal?: AbortSignal;
  allowedOrigins: string[];
}): Promise<DownloadedImage> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(120_000),
    ...(input.signal ? [input.signal] : []),
  ]);
  let url = validateImageUrl(input.url, input.allowedOrigins);
  const directory = await mkdtemp(join(tmpdir(), "dofek-image-"));
  const filePath = join(directory, "original");
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await getPublicImage(url, signal, filePath);
      if ([301, 302, 303, 307, 308].includes(response.status) && response.location) {
        url = validateImageUrl(new URL(response.location, url).href, input.allowedOrigins);
        continue;
      }
      if (response.status !== 200)
        throw new ImageDownloadError(
          `image_http_${response.status}`,
          [408, 429].includes(response.status) || response.status >= 500,
          response.retryAfterSeconds,
        );
      const metadata = await inspectImageOriginal(
        filePath,
        response.contentType,
        response.sizeBytes,
        response.sha256,
      );
      return {
        ...metadata,
        filePath,
        cleanup: () => rm(directory, { recursive: true, force: true }),
      };
    }
    throw new ImageDownloadError("image_redirect_limit");
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
