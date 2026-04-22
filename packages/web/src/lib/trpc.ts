import { httpBatchLink, httpBatchStreamLink, splitLink } from "@trpc/client";
import type { CreateTRPCReact } from "@trpc/react-query";
import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "dofek-server/router";

export const trpc: CreateTRPCReact<AppRouter, unknown> = createTRPCReact<AppRouter>();

const clientTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function createTRPCClient() {
  const buildCommonOptions = () => ({
    url: "/api/trpc",
    methodOverride: "POST" as const,
    headers: () => ({ "x-timezone": clientTimezone }),
  });

  return trpc.createClient({
    links: [
      splitLink({
        condition: (operation) => operation.type === "mutation",
        true: httpBatchLink({
          ...buildCommonOptions(),
          fetch: async (url, options) => {
            const response = await fetch(url, { ...options, credentials: "include" });
            if (response.status === 401) {
              window.location.href = "/login";
            }
            return response;
          },
        }),
        false: httpBatchStreamLink({
          ...buildCommonOptions(),
          fetch: async (url, options) => {
            const response = await fetch(url, { ...options, credentials: "include" });
            if (response.status === 401) {
              window.location.href = "/login";
            }
            return response;
          },
        }),
      }),
    ],
  });
}
