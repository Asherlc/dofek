const BODY_PREVIEW_LIMIT = 240;

function getResponseContentType(response: Response): string {
  return response.headers.get("content-type")?.toLowerCase() ?? "";
}

function isJsonResponse(response: Response): boolean {
  return getResponseContentType(response).includes("json");
}

function getTrpcPath(input: Parameters<typeof fetch>[0]): string {
  const rawUrl =
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const url = new URL(rawUrl);
  const pathPrefix = "/api/trpc/";
  const pathIndex = url.pathname.indexOf(pathPrefix);
  return pathIndex >= 0 ? url.pathname.slice(pathIndex + pathPrefix.length) : url.pathname;
}

function buildStatusLabel(response: Response): string {
  return response.statusText
    ? `${response.status} ${response.statusText}`
    : String(response.status);
}

export function createTrpcFetch(fetchImpl: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (isJsonResponse(response)) {
      return response;
    }

    const bodyPreview = (await response.clone().text()).slice(0, BODY_PREVIEW_LIMIT);
    throw new Error(
      `Non-JSON tRPC response from ${getTrpcPath(input)}: ${buildStatusLabel(response)} ${bodyPreview}`,
    );
  };
}
