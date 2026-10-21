// Retain the SDK's standard signed-URL fields when supplying an overriding list.
export const TELEMETRY_REDACTED_QUERY_PARAMS = [
  "sig",
  "Signature",
  "AWSAccessKeyId",
  "X-Goog-Signature",
  "X-Amz-Signature",
  "X-Amz-Credential",
  "X-Amz-Security-Token",
  "token",
  "session",
  "code",
];

const sensitiveQueryNames = new Set(
  TELEMETRY_REDACTED_QUERY_PARAMS.map((name) => name.toLowerCase()),
);

export function redactTelemetryQuery(query: string): string {
  const prefix = query.startsWith("?") ? "?" : "";
  const params = new URLSearchParams(query);
  let changed = false;
  for (const name of new Set(params.keys())) {
    if (sensitiveQueryNames.has(name.toLowerCase())) {
      params.set(name, "REDACTED");
      changed = true;
    }
  }
  return changed ? `${prefix}${params.toString()}` : query;
}

export function redactTelemetryUrl(url: string): string {
  const queryStart = url.indexOf("?");
  if (queryStart === -1) return url;
  const fragmentStart = url.indexOf("#", queryStart);
  const queryEnd = fragmentStart === -1 ? url.length : fragmentStart;
  return `${url.slice(0, queryStart + 1)}${redactTelemetryQuery(url.slice(queryStart + 1, queryEnd))}${url.slice(queryEnd)}`;
}

export function telemetryHttpAttributes(url: string): Record<string, string> {
  const redactedUrl = redactTelemetryUrl(url);
  const target = redactedUrl.replace(/^https?:\/\/[^/?#]+/i, "") || "/";
  const queryStart = target.indexOf("?");
  const attributes: Record<string, string> = {
    "http.url": redactedUrl,
    "http.target": target,
    "url.query": queryStart === -1 ? "" : (target.slice(queryStart + 1).split("#", 1)[0] ?? ""),
  };
  if (/^https?:\/\//i.test(redactedUrl)) attributes["url.full"] = redactedUrl;
  return attributes;
}

export function redactTelemetryAttributes(attributes: Record<string, unknown> | undefined): void {
  if (!attributes) return;
  for (const key of ["url", "url.full", "http.url", "http.target"]) {
    const value = attributes[key];
    if (typeof value === "string") attributes[key] = redactTelemetryUrl(value);
  }
  for (const key of ["url.query", "http.query"]) {
    const value = attributes[key];
    if (typeof value === "string") attributes[key] = redactTelemetryQuery(value);
  }
}
