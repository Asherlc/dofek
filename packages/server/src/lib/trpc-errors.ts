import { TRPCError } from "@trpc/server";

export function isTRPCNotFoundError(error: unknown): boolean {
  return error instanceof TRPCError && error.code === "NOT_FOUND";
}
