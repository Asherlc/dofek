import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { z } from "zod";
import { climbingBestOnsightRecordFixture } from "../../../server/src/repositories/fixtures/climbing-best-onsight-record.ts";

const recordDetailInputSchema = z.object({
  providerId: z.string().optional(),
  recordId: z.string().optional(),
});

/** Record detail for the clicked onsight cell, or null when the selection is unknown. */
export function climbingRecordDetailStoryData(input: unknown) {
  const { providerId, recordId } = recordDetailInputSchema.parse(input ?? {});
  return climbingBestOnsightRecordFixture({ providerId, recordId });
}

export function createClimbingRecordDetailLink(): TRPCLink<AppRouter> {
  return () =>
    ({ op, next }) => {
      if (op.path !== "providerDetail.recordDetail") return next(op);
      const result: OperationResultObservable<AppRouter, unknown> = {
        subscribe(observer) {
          observer.next?.({ result: { data: climbingRecordDetailStoryData(op.input) } });
          observer.complete?.();
          return { unsubscribe: () => {} };
        },
        pipe() {
          return result;
        },
      };
      return result;
    };
}
