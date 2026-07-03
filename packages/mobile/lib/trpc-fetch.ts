const BODY_PREVIEW_LIMIT = 240;

function getResponseContentType(response: Response): string | null {
  return response.headers.get("content-type")?.toLowerCase() ?? null;
}

function isJsonResponse(response: Response): boolean {
  const contentType = getResponseContentType(response);
  return contentType?.includes("json") ?? false;
}

function responseHasEmptyBody(response: Response): boolean {
  if (response.status === 204 || response.status === 205 || response.status === 304) return true;
  return response.headers.get("content-length") === "0";
}

function buildContentTypeLabel(response: Response): string {
  const contentType = getResponseContentType(response);
  return contentType ? `content-type ${contentType}` : "content-type absent";
}

function getTrpcPath(input: Parameters<typeof fetch>[0]): string {
  const rawUrl =
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const pathPrefix = "/api/trpc/";

  try {
    const url = new URL(rawUrl, "https://dofek.local");
    const pathIndex = url.pathname.indexOf(pathPrefix);
    return pathIndex >= 0 ? url.pathname.slice(pathIndex + pathPrefix.length) : url.pathname;
  } catch {
    return rawUrl;
  }
}

function buildStatusLabel(response: Response): string {
  return response.statusText
    ? `${response.status} ${response.statusText}`
    : String(response.status);
}

async function readBodyPreview(response: Response): Promise<string> {
  try {
    return (await response.clone().text()).slice(0, BODY_PREVIEW_LIMIT);
  } catch {
    return "body preview unavailable";
  }
}

function withJsonParseDiagnostics(
  response: Response,
  input: Parameters<typeof fetch>[0],
): Response {
  const originalJson = response.json.bind(response);
  response.json = async () => {
    try {
      return await originalJson();
    } catch {
      throw new Error(
        `The server returned an invalid response for ${getTrpcPath(input)}: ${buildStatusLabel(response)}, ${buildContentTypeLabel(response)}`,
      );
    }
  };
  return response;
}

export function createTrpcFetch(fetchImpl: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (isJsonResponse(response)) {
      if (responseHasEmptyBody(response)) {
        throw new Error(
          `The server returned an empty response for ${getTrpcPath(input)}: ${buildStatusLabel(response)}, ${buildContentTypeLabel(response)}`,
        );
      }
      return withJsonParseDiagnostics(response, input);
    }

    const bodyPreview = await readBodyPreview(response);
    throw new Error(
      `Non-JSON tRPC response from ${getTrpcPath(input)}: ${buildStatusLabel(response)}, ${buildContentTypeLabel(response)}, ${bodyPreview}`,
    );
  };
}
