import { httpBatchLink } from "@trpc/client";
import type { CreateTRPCReact } from "@trpc/react-query";
import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "dofek-server/router";

export const trpc: CreateTRPCReact<AppRouter, unknown> = createTRPCReact<AppRouter>();

export function createTRPCClient() {
  return trpc.createClient({
    links: [
      httpBatchLink({
        url: "/api/trpc",
        methodOverride: "POST",
      }),
    ],
  });
}
