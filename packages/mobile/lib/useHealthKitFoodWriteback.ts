import { formatDateYmd } from "@dofek/format/format";
import { useEffect, useRef } from "react";
import { deleteDietarySamples, writeDietarySamples } from "../modules/health-kit";
import { AppleHealthAuthorizationService } from "./apple-health-provider";
import { syncDofekFoodToHealthKit } from "./health-kit-food-writeback";
import { runAfterUiIdle } from "./runAfterUiIdle";
import { captureException, logger } from "./telemetry";
import { trpc } from "./trpc";

function hasFoodWritebackRange(
  latestCoverageDate: string | null | undefined,
): latestCoverageDate is string {
  return latestCoverageDate != null && latestCoverageDate < formatDateYmd();
}

/** Writes canonical Dofek nutrition entries to HealthKit for uncovered dashboard dates. */
export function useHealthKitFoodWriteback(latestCoverageDate: string | null | undefined) {
  const triggered = useRef(false);
  const trpcUtils = trpc.useUtils();

  useEffect(() => {
    if (triggered.current || !hasFoodWritebackRange(latestCoverageDate)) {
      return;
    }
    const startDate = latestCoverageDate;

    const idleHandle = runAfterUiIdle(() => {
      if (triggered.current) {
        return;
      }
      triggered.current = true;

      const appleHealthAuthorization = new AppleHealthAuthorizationService();
      void appleHealthAuthorization
        .resolve()
        .then((authorizationState) => {
          if (!authorizationState.canAttemptSync()) {
            return null;
          }
          return syncDofekFoodToHealthKit({
            trpcClient: trpcUtils.client,
            healthKit: {
              writeDietarySamples,
              deleteDietarySamples,
            },
            startDate,
            endDate: formatDateYmd(),
          });
        })
        .then((result) => {
          if (!result) {
            return;
          }
          logger.info(
            "health-kit-food-writeback",
            `HealthKit food writeback complete: ${result.written} written, ${result.errors.length} errors`,
          );
        })
        .catch((error: unknown) => {
          logger.warn(
            "health-kit-food-writeback",
            `HealthKit food writeback failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          captureException(error, { source: "health-kit-food-writeback" });
        });
    });

    return () => {
      idleHandle.cancel();
    };
  }, [latestCoverageDate, trpcUtils]);
}
