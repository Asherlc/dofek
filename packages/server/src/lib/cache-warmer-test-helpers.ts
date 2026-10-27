import { TRPCError } from "@trpc/server";
export function createTRPCError(code: "NOT_FOUND" | "INTERNAL_SERVER_ERROR"): TRPCError {
  return new TRPCError({ code, message: code });
}
