import { lookup } from "node:dns/promises";
import { request } from "node:https";
import {
  OAuthClientInformationFullSchema,
  OAuthClientMetadataSchema,
  type OAuthClientInformationFull,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import ipaddr from "ipaddr.js";
import { isAllowedMcpOAuthRedirectUri } from "./oauth-client-store.ts";

const CIMD_CACHE_MAX_AGE_MS = 86_400_000;
const CIMD_DEFAULT_CACHE_AGE_MS = 300_000;
const CIMD_FETCH_TIMEOUT_MS = 5_000;
const CIMD_MAX_RESPONSE_BYTES = 65_536;

class CimdMetadataError extends Error {}

function isCimdClientId(clientId: string): boolean {
  try {
    const url = new URL(clientId);
    return (
      url.protocol === "https:" &&
      Boolean(url.hostname) &&
      url.pathname !== "/" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.parse(address).range() === "unicast";
  } catch {
    return false;
  }
}

function cacheAge(responseCacheControl: string | undefined): number {
  const match = responseCacheControl?.match(/(?:^|,)\s*max-age=(\d+)/i);
  if (!match?.[1]) return CIMD_DEFAULT_CACHE_AGE_MS;
  return Math.min(Number(match[1]) * 1_000, CIMD_CACHE_MAX_AGE_MS);
}

async function fetchMetadata(url: URL): Promise<{ body: unknown; cacheAgeMs: number }> {
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new CimdMetadataError("CIMD host must resolve only to public addresses");
  }
  const destination = addresses[0];
  if (!destination) throw new CimdMetadataError("CIMD host did not resolve");

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new CimdMetadataError("CIMD metadata request timed out")),
      CIMD_FETCH_TIMEOUT_MS,
    );
    const requestPath = `${url.pathname}${url.search}`;
    const clientRequest = request(
      {
        headers: { Accept: "application/json", Host: url.host },
        host: destination.address,
        lookup: (_hostname, _options, callback) => callback(null, destination.address, destination.family),
        method: "GET",
        path: requestPath,
        port: url.port ? Number(url.port) : 443,
        protocol: "https:",
        servername: url.hostname,
      },
      (response) => {
        const contentType = response.headers["content-type"];
        if (response.statusCode !== 200 || !contentType?.includes("application/json")) {
          response.resume();
          clearTimeout(timeout);
          reject(new CimdMetadataError("CIMD metadata response is invalid"));
          return;
        }
        const chunks: Buffer[] = [];
        let byteLength = 0;
        response.on("data", (chunk: Buffer) => {
          byteLength += chunk.length;
          if (byteLength > CIMD_MAX_RESPONSE_BYTES) {
            response.destroy(new CimdMetadataError("CIMD metadata response is too large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          clearTimeout(timeout);
          try {
            resolve({
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
              cacheAgeMs: cacheAge(response.headers["cache-control"]),
            });
          } catch {
            reject(new CimdMetadataError("CIMD metadata response is not valid JSON"));
          }
        });
      },
    );
    clientRequest.on("error", (error) => {
      clearTimeout(timeout);
      reject(error instanceof CimdMetadataError ? error : new CimdMetadataError("CIMD metadata request failed"));
    });
    clientRequest.end();
  });
}

export function parseCimdClientMetadata(
  clientId: string,
  value: unknown,
): OAuthClientInformationFull {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CimdMetadataError("CIMD response must be a JSON object");
  }
  const metadataWithId = value as Record<string, unknown>;
  if (metadataWithId.client_id !== clientId) {
    throw new CimdMetadataError("CIMD client_id must exactly match the requested URL");
  }
  if (metadataWithId.client_secret !== undefined) {
    throw new CimdMetadataError("CIMD clients must not include a client_secret");
  }
  if (
    metadataWithId.token_endpoint_auth_method !== undefined &&
    metadataWithId.token_endpoint_auth_method !== "none"
  ) {
    throw new CimdMetadataError("CIMD clients must use token_endpoint_auth_method none");
  }

  let metadata;
  try {
    metadata = OAuthClientMetadataSchema.parse(metadataWithId);
  } catch {
    throw new CimdMetadataError("CIMD metadata does not match the OAuth client schema");
  }
  if (metadata.redirect_uris.length === 0) {
    throw new CimdMetadataError("CIMD clients must declare at least one redirect_uri");
  }
  for (const redirectUri of metadata.redirect_uris) {
    if (!isAllowedMcpOAuthRedirectUri(redirectUri)) {
      throw new CimdMetadataError("CIMD client has an invalid redirect_uri");
    }
  }
  return OAuthClientInformationFullSchema.parse({ ...metadata, client_id: clientId });
}

export class McpOAuthClientMetadataResolver {
  readonly #cache = new Map<string, { client: OAuthClientInformationFull; expiresAt: number }>();

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    if (!isCimdClientId(clientId)) return undefined;
    const cached = this.#cache.get(clientId);
    if (cached && cached.expiresAt > Date.now()) return cached.client;
    try {
      const { body, cacheAgeMs } = await fetchMetadata(new URL(clientId));
      const client = parseCimdClientMetadata(clientId, body);
      this.#cache.set(clientId, { client, expiresAt: Date.now() + cacheAgeMs });
      return client;
    } catch (error) {
      if (error instanceof CimdMetadataError) return undefined;
      throw error;
    }
  }
}
