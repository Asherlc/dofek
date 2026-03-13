import { httpBatchStreamLink } from "@trpc/client";
import type { CreateTRPCReact } from "@trpc/react-query";
import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "dofek-server/router";

export const trpc: CreateTRPCReact<AppRouter, unknown> = createTRPCReact<AppRouter>();

export function createTRPCClient() {
  return trpc.createClient({
    links: [
      httpBatchStreamLink({
        url: "/api/trpc",
        methodOverride: "POST",
        fetch: async (url, options) => {
          const response = await fetch(url, { ...options, credentials: "include" });
          if (response.status === 401) {
            window.location.href = "/login";
          }
          return response;
        },
      }),
    ],
  });
}
