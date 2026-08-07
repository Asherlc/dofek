export function normalizePublicUrl(value: string | undefined): string {
  if (!value) {
    throw new Error("PUBLIC_URL environment variable is required");
  }
  const baseUrl = value.trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("PUBLIC_URL environment variable is required");
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("PUBLIC_URL environment variable must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("PUBLIC_URL environment variable must use http or https");
  }
  return baseUrl;
}

export function getPublicUrlBase(): string {
  return normalizePublicUrl(process.env.PUBLIC_URL);
}

export function getPublicUrlOrigin(): string {
  return new URL(getPublicUrlBase()).origin;
}
