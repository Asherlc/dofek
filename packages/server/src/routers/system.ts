import { z } from "zod";
import { logBuffer } from "../logger.ts";
import { protectedProcedure, router } from "../trpc.ts";

const logsInput = z.object({
  limit: z.number().min(1).max(500).default(100),
});

export const systemRouter = router({
  /** Return recent server log entries from the in-memory ring buffer. */
  logs: protectedProcedure.input(logsInput).query(({ input }) => {
    const entries = logBuffer.getEntries();
    // Return the most recent `limit` entries
    return entries.slice(-input.limit);
  }),
});
