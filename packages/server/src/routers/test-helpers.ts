import type { AnyRouter } from "@trpc/server";
import { initTRPC } from "@trpc/server";
import type { Context } from "../trpc.ts";

const trpc = initTRPC.context<Context>().create();

export function createTestCallerFactory(router: AnyRouter) {
  return trpc.createCallerFactory(router);
}
