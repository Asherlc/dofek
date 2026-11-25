import { guardTrpcHttpResponse } from "@dofek/telemetry/handled-failure";
import { httpBatchLink, httpBatchStreamLink, httpLink, splitLink } from "@trpc/client";
import type { CreateTRPCReact } from "@trpc/react-query";
import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "dofek-server/router";

export const trpc: CreateTRPCReact<AppRouter, unknown> = createTRPCReact<AppRouter>();

const clientTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const unbatchedQueryPaths = new Set(["recovery.workloadRatio"]);

async function fetchWithCredentials(
  url: RequestInfo | URL,
  options?: RequestInit,
): Promise<Response> {
  const response = await fetch(url, { ...options, credentials: "include" });
  if (response.status === 401) {
    window.location.href = "/login";
  }
  return guardTrpcHttpResponse(response);
}

export function createTRPCClient() {
  const buildCommonOptions = () => ({
    url: "/api/trpc",
    methodOverride: "POST" as const,
    headers: () => ({ "x-timezone": clientTimezone }),
    fetch: fetchWithCredentials,
  });

  return trpc.createClient({
    links: [
      splitLink({
        condition: (operation) => operation.type === "mutation",
        true: httpBatchLink({
          ...buildCommonOptions(),
        }),
        false: splitLink({
          condition: (operation) =>
            operation.type === "query" && unbatchedQueryPaths.has(operation.path),
          true: httpLink({
            ...buildCommonOptions(),
          }),
          false: httpBatchStreamLink({
            ...buildCommonOptions(),
          }),
        }),
      }),
    ],
  });
}
