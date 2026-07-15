import { getPublicUrlBase } from "../lib/public-url.ts";

export function getMcpResourceUrl(): URL {
  return new URL("/api/mcp", `${getPublicUrlBase()}/`);
}

export function getMcpIssuerUrl(): URL {
  return new URL(`${getPublicUrlBase()}/`);
}
