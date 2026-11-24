import { formatDateYmd, shiftDateYmd } from "@dofek/format/format";
import {
  partialMatchKey,
  type Query,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";
import { z } from "zod";
import { replaceSnapshot } from "../modules/sleep-widget";
import { captureException } from "./telemetry";
import { trpc } from "./trpc";

const SIGNED_OUT_WIRE = JSON.stringify({ version: 1, kind: "signedOut" });

function dashboardV2KeyPrefix(): QueryKey {
  return getQueryKey(trpc.mobileDashboard.dashboardV2);
}

/**
 * Minimal dashboard slice at the untyped QueryCache boundary.
 * `sleep` is required (server may send null).
 */
const sleepWidgetSourceSchema = z.object({
  sleep: z
    .object({
      lastNight: z
        .object({
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          durationMinutes: z.number().finite().nonnegative(),
        })
        .nullable(),
    })
    .nullable(),
});

/** Local calendar midnight as epoch milliseconds for a YYYY-MM-DD value. */
export function localMidnightMs(ymd: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!match) {
    throw new Error("Expected a valid YYYY-MM-DD date");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error("Expected a valid YYYY-MM-DD date");
  }
  return date.getTime();
}

/** Start of the local calendar day two days after the sleep record date. */
export function sleepRecordExpiresAtMs(recordDate: string): number {
  return localMidnightMs(shiftDateYmd(recordDate, 2));
}

/** Next local midnight after `now`. */
export function emptySnapshotExpiresAtMs(now: Date = new Date()): number {
  return localMidnightMs(shiftDateYmd(formatDateYmd(now), 1));
}

/** Build version-one wire JSON, or null when the reply must not be published. */
export function buildSleepWidgetWire(
  payload: unknown,
  queryEndDate: string,
  now: Date,
): string | null {
  const parsed = sleepWidgetSourceSchema.safeParse(payload);
  if (!parsed.success) return null;

  const lastNight = parsed.data.sleep?.lastNight ?? null;
  if (lastNight == null) {
    return JSON.stringify({
      version: 1,
      kind: "empty",
      expiresAt: emptySnapshotExpiresAtMs(now),
    });
  }

  const preceding = shiftDateYmd(queryEndDate, -1);
  if (lastNight.date !== queryEndDate && lastNight.date !== preceding) {
    return null;
  }

  // Native v1 accepts integer minutes.
  const durationMinutes = Math.round(lastNight.durationMinutes);
  if (durationMinutes < 0) return null;

  return JSON.stringify({
    version: 1,
    kind: "sleep",
    date: lastNight.date,
    durationMinutes,
    expiresAt: sleepRecordExpiresAtMs(lastNight.date),
  });
}

/** In-memory activation for one restored writer lifetime (object identity, not the durable nonce). */
type SleepWidgetActivation = {
  readonly ownerNonce: string;
};

let activeActivation: SleepWidgetActivation | null = null;

/** Drop the active writer so stamped requests cannot match a later same-nonce restore. */
export function retireSleepWidgetWriter(): void {
  activeActivation = null;
}

/**
 * Activate publication for a durable session owner nonce.
 * Ordinary same-owner re-verification keeps the existing activation object.
 */
export function restoreSleepWidgetWriter(ownerNonce: string): void {
  if (activeActivation?.ownerNonce === ownerNonce) {
    return;
  }
  activeActivation = { ownerNonce };
}

/**
 * Remove the App Group snapshot file. Throws on failure so auth/erasure can retry or abort.
 */
export function removeSleepWidgetSnapshot(): void {
  replaceSnapshot(null);
}

/**
 * Best-effort signed-out marker after the health file is already gone.
 * Failures are telemetried only — they must not undo a successful removal.
 */
export function writeSleepWidgetSignedOutMarker(): void {
  try {
    replaceSnapshot(SIGNED_OUT_WIRE);
  } catch (error: unknown) {
    captureException(error, { source: "sleep-widget-signed-out" });
  }
}

/** Owned account erasure entry point — removal failures stay retryable via purge `attempt`. */
export function purgeSleepWidgetSnapshot(): void {
  removeSleepWidgetSnapshot();
}

function isDashboardV2Query(query: Query): boolean {
  return partialMatchKey(query.queryKey, dashboardV2KeyPrefix());
}

function dashboardEndDate(query: Query): string | null {
  const options = query.queryKey[1];
  if (
    options == null ||
    typeof options !== "object" ||
    !("input" in options) ||
    options.input == null ||
    typeof options.input !== "object" ||
    !("endDate" in options.input) ||
    typeof options.input.endDate !== "string"
  ) {
    return null;
  }
  return options.input.endDate;
}

export function dashboardV2QueryKey(endDate: string): QueryKey {
  return getQueryKey(trpc.mobileDashboard.dashboardV2, { endDate }, "query");
}

/** Refetch the stale active Overview dashboardV2 query without canceling in-flight work. */
export function refetchStaleDashboardV2(
  queryClient: Pick<QueryClient, "refetchQueries">,
  endDate: string,
): Promise<void> {
  return queryClient
    .refetchQueries(
      {
        queryKey: dashboardV2QueryKey(endDate),
        exact: true,
        type: "active",
        stale: true,
      },
      { cancelRefetch: false },
    )
    .then(() => undefined);
}

export function registerSleepWidgetPublisher(options: {
  queryClient: QueryClient;
  now?: () => Date;
}): { dispose(): void } {
  const now = options.now ?? (() => new Date());
  // Stamp the activation object so a later restore of the same durable nonce cannot match.
  const activationByQuery = new WeakMap<Query, SleepWidgetActivation | null>();

  const unsubscribe = options.queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated") return;
    const { query, action } = event;
    if (!isDashboardV2Query(query)) return;

    if (action.type === "fetch") {
      activationByQuery.set(query, activeActivation);
      return;
    }

    if (action.type !== "success") return;
    if (action.manual) return;

    const stampedActivation = activationByQuery.get(query);
    if (
      stampedActivation == null ||
      activeActivation == null ||
      stampedActivation !== activeActivation
    ) {
      return;
    }

    const endDate = dashboardEndDate(query);
    if (endDate == null) return;

    // Sample the local calendar once for this network response.
    const responseNow = now();
    const today = formatDateYmd(responseNow);
    if (endDate !== today) return;

    const wire = buildSleepWidgetWire(action.data, endDate, responseNow);
    if (wire == null) return;

    try {
      replaceSnapshot(wire);
    } catch (error: unknown) {
      captureException(error, { source: "sleep-widget-publish" });
    }
  });

  return {
    dispose() {
      unsubscribe();
    },
  };
}
